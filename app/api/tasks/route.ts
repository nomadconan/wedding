import type { NextRequest } from "next/server";
import { z } from "zod";

import { recordEvent } from "@/lib/audit/record";
import { fail, failValidation, ok } from "@/lib/api/response";
import { WAITING_NOTE } from "@/lib/core/schedule/graph";
import { TaskCreateSchema, TaskUpdateSchema } from "@/lib/core/schemas/task";
import { findMyCouple } from "@/lib/couple/membership";
import { generateChecklist } from "@/lib/tasks/generate";
import { loadChecklist, outOfOrderOnComplete } from "@/lib/tasks/loader";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * GET/POST/PATCH /api/tasks — 체크리스트 (F-C-04, 명세서 §4.2)
 *
 * **선행 미완 상태로 완료해도 막지 않는다**(§3.2). 대신 `completed_out_of_order` 를
 * 함께 기록한다 — **경고가 아니라 기록**이며, 나중에 예산·날짜 충돌을 설명할 때 쓰인다.
 * 잠그면 사용자는 우회하려고 의존을 지우고 그때 데이터가 망가진다.
 *
 * **`ready`·`waiting` 은 응답에 계산해 싣는다**(저장하지 않는다 · §3.2). 그래서 GET 이
 * 그 계산의 유일한 자리이며, 표현 넷(S7-19)이 **같은 응답**을 쓴다 — 뷰마다 다른 API 를
 * 두면 같은 질문에 다른 답이 나온다.
 *
 * 자동 생성(`action: "generate"`)은 **사용자가 누른다.** 온보딩에서 조용히 만들면
 * 자기가 만들지 않은 목록을 받게 되고, 그때 지우는 일이 첫 경험이 된다.
 */
const PostSchema = z.union([
  z.object({ action: z.literal("generate") }).strict(),
  TaskCreateSchema.extend({ action: z.literal("create") }).strict(),
]);

async function context() {
  const user = await getSessionUser();
  if (!user) return { error: fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.") } as const;

  const membership = await findMyCouple(user.id);
  if (!membership) {
    return { error: fail(404, "TASK_COUPLE_NOT_FOUND", "먼저 온보딩을 마쳐 주세요.") } as const;
  }

  return { user, membership } as const;
}

const today = () => new Date().toISOString().slice(0, 10);

export async function GET() {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;

  const supabase = await createClient();
  const view = await loadChecklist(supabase, {
    coupleId: ctx.membership.coupleId,
    today: today(),
  });

  return ok({
    ...view,
    // **`waiting` 은 잠금이 아니다.** 문구를 응답에 실어 화면이 다시 쓰지 않게 한다.
    waitingNote: WAITING_NOTE,
  });
}

export async function POST(request: NextRequest) {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "TASK_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = PostSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();

  if (parsed.data.action === "generate") {
    // 예식일은 커플 행이 갖는다. **없으면 기한을 지어내지 않는다**(§3.2).
    const { data: couple } = await supabase
      .from("couples")
      .select("wedding_date")
      .eq("id", ctx.membership.coupleId)
      .maybeSingle();

    const result = await generateChecklist(supabase, {
      coupleId: ctx.membership.coupleId,
      actorId: ctx.user.id,
      weddingDate: (couple as { wedding_date: string | null } | null)?.wedding_date ?? null,
    });

    return ok(result, { status: 201 });
  }

  const { data: created, error } = await supabase
    .from("tasks")
    .insert({
      couple_id: ctx.membership.coupleId,
      category: parsed.data.category,
      title: parsed.data.title,
      due_date: parsed.data.dueDate,
      assignee_id: parsed.data.assigneeId,
      source: "manual",
    })
    .select("id")
    .maybeSingle();

  const taskId = (created as { id: string } | null)?.id ?? null;
  if (error || taskId === null) return fail(500, "TASK_CREATE_FAILED", "할 일을 만들지 못했어요.");

  // **선행 관계를 여기서 잇지 않는다.** 그 API 는 커버리지 표가 S7-19 에 배정했다
  // (F-C-37). S7-08 이 간선을 쓰는 자리는 자동 생성 하나다.

  await recordEvent({
    entityType: "task",
    entityId: taskId,
    eventType: "task_created",
    actor: { id: ctx.user.id },
    afterState: "todo",
    // 제목을 넣지 않는다(§7.3). 남길 사실은 카테고리뿐이다.
    memo: `category:${parsed.data.category}`,
  });

  return ok({ taskId }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "TASK_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = TaskUpdateSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();

  const values: Record<string, unknown> = {};
  if (parsed.data.title !== undefined) values.title = parsed.data.title;
  if (parsed.data.dueDate !== undefined) values.due_date = parsed.data.dueDate;
  if (parsed.data.status !== undefined) values.status = parsed.data.status;
  if (parsed.data.assigneeId !== undefined) values.assignee_id = parsed.data.assigneeId;

  if (Object.keys(values).length === 0) {
    return fail(422, "TASK_NOTHING_TO_UPDATE", "바꿀 내용을 적어 주세요.");
  }

  // **완료로 옮길 때만 선행을 본다.** 그리고 막지 않는다 — 기록할 뿐이다(§3.2).
  let outOfOrder = false;

  if (parsed.data.status === "done") {
    outOfOrder = await outOfOrderOnComplete(supabase, {
      coupleId: ctx.membership.coupleId,
      taskId: parsed.data.taskId,
    });

    values.completed_out_of_order = outOfOrder;
  }

  const { data: updated } = await supabase
    .from("tasks")
    .update(values)
    .eq("id", parsed.data.taskId)
    .select("id");

  if ((updated ?? []).length === 0) {
    return fail(403, "TASK_FORBIDDEN", "이 할 일을 고칠 권한이 없어요.");
  }

  if (parsed.data.status !== undefined) {
    await recordEvent({
      entityType: "task",
      entityId: parsed.data.taskId,
      eventType: "task_status_changed",
      actor: { id: ctx.user.id },
      afterState: parsed.data.status,
      memo: outOfOrder ? "out_of_order" : null,
    });
  }

  return ok({ taskId: parsed.data.taskId, completedOutOfOrder: outOfOrder });
}

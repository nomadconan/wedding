import type { NextRequest } from "next/server";

import { recordEvent } from "@/lib/audit/record";
import { fail, failValidation, ok } from "@/lib/api/response";
import {
  TASK_DEPENDENCY_ERRORS,
  TaskDependencySchema,
  taskDependencyErrorOf,
} from "@/lib/core/schemas/task";
import { findMyCouple } from "@/lib/couple/membership";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * POST/DELETE /api/tasks/[id]/dependencies — 선행 관계 편집
 * (S7-19 · F-C-37 · 명세서 §4.2)
 *
 * ── 판정은 DB 가 한다 ───────────────────────────────────────────────────────
 * 순환·타 커플 참조·깊이 초과는 **재귀 CTE 트리거와 커플 단위 어드바이저리 락**이
 * 막는다(0042 · D-71). 이 라우트가 같은 검사를 다시 하면 판정이 두 벌이 되고 언젠가
 * 둘이 다른 답을 낸다 — 그래서 여기서는 **DB 의 거절을 §4.2 가 정한 코드로 옮기기만**
 * 한다. 화면이 후보를 미리 줄이는 것(`dependencyCandidates`)은 편의이지 방어가 아니다.
 *
 * ── 이미 있는 간선·없는 간선은 실패가 아니다 ────────────────────────────────
 * 같은 순서를 두 번 이어 달라는 요청에 422 로 답하면 사용자는 **이미 원하는 상태인데
 * 거절만 받는다.** 없는 간선을 지워 달라는 요청도 마찬가지다 — 결과가 요청한 대로면
 * 성공이다(S7-15 가 중복 신고에서 세운 규칙과 같다: "이미 접수된 것이 사실이다").
 * 대신 응답에 `created`·`deleted` 를 실어 **무슨 일이 실제로 일어났는지**는 숨기지 않는다.
 *
 * ── UPDATE 가 없는 이유 ─────────────────────────────────────────────────────
 * 간선은 **양끝이 곧 정체성**이라 고칠 것이 없다(D-72). 방향을 바꾸는 일은 지우고 다시
 * 만드는 것이고, 그래야 트리거가 **새 간선을** 검사한다. 0042 가 UPDATE 권한을
 * 회수했으므로 라우트를 만들어도 서지 않는다.
 *
 * **세션 클라이언트로 쓴다.** 인가의 최종 경계는 RLS 다 — 정책이 간선 **양쪽**이 내
 * 커플 것인지 본다(0042 `owns_task`).
 */

type Params = { params: { id: string } };

async function context() {
  const user = await getSessionUser();
  if (!user) return { error: fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.") } as const;

  const membership = await findMyCouple(user.id);
  if (!membership) {
    return { error: fail(404, "TASK_COUPLE_NOT_FOUND", "먼저 온보딩을 마쳐 주세요.") } as const;
  }

  return { user, membership } as const;
}

/**
 * DB 거절을 §4.2 의 코드로 옮긴다. 짝이 없으면 **아는 척하지 않는다**.
 *
 * **사유는 `hint` 로 온다**(0044). PostgREST 는 `raise ... using constraint` 의 이름을
 * 응답에 싣지 않아서(`{"code":"23514","details":null,"hint":null,"message":"…"}`)
 * 순환과 깊이를 구분할 수 없었다 — 흐름 점검이 그것을 잡았고, 트리거가 `hint` 에도
 * 사유를 싣도록 갈아 끼웠다. **메시지 문자열로 분기하지 않는다**: 문안을 다듬는 날
 * 조용히 500 으로 돌아간다.
 */
function toFailure(
  error: { code?: string; message?: string; details?: string | null; hint?: string | null } | null,
) {
  const key = taskDependencyErrorOf({
    constraint: error?.hint ?? error?.details ?? null,
    message: error?.message ?? "",
  });

  if (key !== null) {
    const mapped = TASK_DEPENDENCY_ERRORS[key];

    return fail(422, mapped.code, mapped.message);
  }

  // 정책이 막은 경우(양쪽 중 하나가 남의 태스크)는 PostgREST 가 42501 로 답한다.
  if (error?.code === "42501") {
    return fail(403, "TASK_FORBIDDEN", "이 할 일의 순서를 고칠 권한이 없어요.");
  }

  return null;
}

export async function POST(request: NextRequest, { params }: Params) {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "TASK_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = TaskDependencySchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  // 길이 1 순환은 DB CHECK 도 막지만 **여기서 먼저 답하는 편이 친절하다** — 사용자가
  // 무엇을 잘못했는지가 분명한 유일한 경우이기 때문이다.
  if (parsed.data.dependsOn === params.id) {
    return fail(422, TASK_DEPENDENCY_ERRORS.task_cycle.code, "자기 자신을 먼저 할 일로 둘 수 없어요.");
  }

  const supabase = await createClient();

  const { error } = await supabase.from("task_dependencies").insert({
    task_id: params.id,
    depends_on_task_id: parsed.data.dependsOn,
    created_by: ctx.user.id,
  });

  // **이미 있는 간선은 성공이다.** 결과가 요청한 대로다.
  if (error?.code === "23505") {
    return ok({ taskId: params.id, dependsOn: parsed.data.dependsOn, created: false });
  }

  if (error) {
    const failure = toFailure(error);
    if (failure) return failure;

    return fail(500, "TASK_DEPENDENCY_FAILED", "순서를 잇지 못했어요.");
  }

  await recordEvent({
    entityType: "task",
    entityId: params.id,
    eventType: "task_dependency_added",
    actor: { id: ctx.user.id },
    // 제목을 넣지 않는다(§7.3). 남길 사실은 **어느 태스크를 먼저로 두었는가**뿐이다.
    memo: `depends_on:${parsed.data.dependsOn}`,
  });

  return ok({ taskId: params.id, dependsOn: parsed.data.dependsOn, created: true }, { status: 201 });
}

/**
 * 지울 간선을 **쿼리로 받는다** — `?dependsOn=<uuid>`.
 *
 * DELETE 본문은 프록시·`fetch` 구현에 따라 사라질 수 있어(RFC 상 의미가 정의돼 있지
 * 않다) 조용히 "아무것도 안 지움" 으로 끝날 수 있다. 지우는 요청이 조용히 실패하는
 * 것은 최악이라 **URL 에 적는다.**
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;

  const dependsOn = request.nextUrl.searchParams.get("dependsOn");

  const parsed = TaskDependencySchema.safeParse({ dependsOn });
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();

  const { data, error } = await supabase
    .from("task_dependencies")
    .delete()
    .eq("task_id", params.id)
    .eq("depends_on_task_id", parsed.data.dependsOn)
    .select("task_id");

  if (error) {
    const failure = toFailure(error);
    if (failure) return failure;

    return fail(500, "TASK_DEPENDENCY_FAILED", "순서를 지우지 못했어요.");
  }

  const deleted = (data ?? []).length > 0;

  // **없는 간선을 지워 달라는 요청도 성공이다** — 결과가 요청한 대로다. 다만
  // `deleted:false` 로 무슨 일이 있었는지는 숨기지 않는다.
  //
  // **지운 뒤 앞뒤를 잇지 않는다**(0042 근거 7) — A→B→C 에서 B 를 향한 간선을 지우면
  // A 와 C 는 무관해진다. 추론으로 이으면 사용자가 지운 순서를 시스템이 되살리는 셈이다.
  if (deleted) {
    await recordEvent({
      entityType: "task",
      entityId: params.id,
      eventType: "task_dependency_removed",
      actor: { id: ctx.user.id },
      memo: `depends_on:${parsed.data.dependsOn}`,
    });
  }

  return ok({ taskId: params.id, dependsOn: parsed.data.dependsOn, deleted });
}

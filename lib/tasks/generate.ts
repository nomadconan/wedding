import type { SupabaseClient } from "@supabase/supabase-js";

import { recordEvent } from "@/lib/audit/record";
import { generateFromTemplates, mapTemplateEdges } from "@/lib/core/schedule/graph";

/**
 * 역산 자동 생성 (S7-08 · 명세서 §2.1 F-C-04 · §3.2 · IDEA-02)
 *
 * **템플릿 순서를 함께 옮긴다.** 표의 비고가 "의존 이관은 S7-18 이후" 라고 적었고
 * 그 표(`task_dependencies`)와 순환 방지 트리거가 이제 있다 — 이 태스크가 그 이관을
 * 완결한다. 태스크만 만들고 순서를 두고 오면 F-C-37(준비 순서 뷰)이 그릴 그래프가
 * 비어 있게 된다.
 *
 * **코드로 잇는다. uuid 로 잇지 않는다**(S7-18 판단). `tasks.template_code` 가 코드↔
 * 태스크의 다리이며, 그 덕에 시드를 다시 넣어 템플릿 uuid 가 바뀌어도 이미 만들어진
 * 태스크의 출처가 끊기지 않는다.
 *
 * **다시 눌러도 두 번 만들지 않는다.** 이미 있는 `template_code` 는 건너뛴다 — 사용자가
 * 지운 것을 되살리지도 않는다(지운 것은 지운 것이다).
 *
 * **세션 클라이언트로 쓴다.** `tasks`·`task_dependencies` 모두 커플 정책이 경계이고
 * (0005 · 0042), 서비스롤로 넣으면 남의 커플 id 를 적는 실수를 DB 가 잡아 주지 못한다.
 */

export type GenerateResult = {
  created: number;
  skipped: number;
  edges: number;
  /** 예식일이 없어 기한을 비운 태스크 수. 화면이 그 사실을 말한다. */
  undated: number;
};

type TemplateRow = { code: string; category: string; title: string; offset_days: number };

export async function generateChecklist(
  client: SupabaseClient,
  input: { coupleId: string; actorId: string; weddingDate: string | null },
): Promise<GenerateResult> {
  const { data: templateRows } = await client
    .from("task_templates")
    .select("code, category, title, offset_days");

  const templates = ((templateRows ?? []) as TemplateRow[]).map((row) => ({
    code: row.code,
    category: row.category,
    title: row.title,
    offsetDays: row.offset_days,
  }));

  if (templates.length === 0) return { created: 0, skipped: 0, edges: 0, undated: 0 };

  // 이미 만들어진 것은 건너뛴다. 지운 것을 되살리지 않는 것과 같은 판단이다.
  const { data: existingRows } = await client
    .from("tasks")
    .select("id, template_code")
    .eq("couple_id", input.coupleId)
    .not("template_code", "is", null);

  const existing = new Map(
    ((existingRows ?? []) as { id: string; template_code: string }[]).map((row) => [
      row.template_code,
      row.id,
    ]),
  );

  const planned = generateFromTemplates({ templates, weddingDate: input.weddingDate }).filter(
    (task) => !existing.has(task.templateCode),
  );

  let created = 0;

  if (planned.length > 0) {
    const { data: insertedRows } = await client
      .from("tasks")
      .insert(
        planned.map((task) => ({
          couple_id: input.coupleId,
          category: task.category,
          title: task.title,
          due_date: task.dueDate,
          template_code: task.templateCode,
          source: "auto",
        })),
      )
      .select("id, template_code");

    for (const row of (insertedRows ?? []) as { id: string; template_code: string }[]) {
      existing.set(row.template_code, row.id);
      created += 1;
    }
  }

  // ── 순서 이관 ─────────────────────────────────────────────────────────────
  const { data: templateEdgeRows } = await client
    .from("task_template_dependencies")
    .select("template_code, depends_on_code");

  const wanted = mapTemplateEdges({
    edges: ((templateEdgeRows ?? []) as { template_code: string; depends_on_code: string }[]).map(
      (row) => ({ templateCode: row.template_code, dependsOnCode: row.depends_on_code }),
    ),
    taskIdByCode: existing,
  });

  let edges = 0;

  // **한 건씩 넣는다.** 한 건이 트리거에 걸려도 나머지는 들어가야 한다 — 묶어 넣으면
  // 순환 하나가 전체 이관을 되돌린다. 이미 있는 간선은 PK 가 막고 그것은 실패가 아니다.
  for (const edge of wanted) {
    const { error } = await client
      .from("task_dependencies")
      .insert({ task_id: edge.taskId, depends_on_task_id: edge.dependsOn });

    if (!error) edges += 1;
  }

  await recordEvent({
    entityType: "task",
    entityId: input.coupleId,
    eventType: "checklist_generated",
    actor: { id: input.actorId },
    afterState: "generated",
    // 제목을 넣지 않는다. 남길 사실은 셀 수 있는 값뿐이다(§7.3).
    memo: `created:${created} edges:${edges} dated:${input.weddingDate === null ? "no" : "yes"}`,
  });

  return {
    created,
    skipped: templates.length - planned.length,
    edges,
    undated: input.weddingDate === null ? created : 0,
  };
}

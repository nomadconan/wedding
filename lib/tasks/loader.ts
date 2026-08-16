import type { SupabaseClient } from "@supabase/supabase-js";

import {
  annotate,
  buildTimeline,
  categoryProgress,
  completesOutOfOrder,
  nextTasks,
  topoSort,
  type AnnotatedTask,
  type CategoryProgress,
  type TaskEdge,
  type TaskNode,
  type TaskStatus,
  type TimelineBucket,
} from "@/lib/core/schedule/graph";

/**
 * 체크리스트 조회 (S7-08 · 명세서 §6.2 `/checklist` · §4.2)
 *
 * **세션 클라이언트로 읽는다.** `tasks` 는 커플 스코프 RLS 이고(0005 [11]) 플래너
 * 위임까지 그쪽이 판정한다 — 서비스롤로 읽으면 그 위임 규칙이 이 파일의 조건문으로
 * 내려온다.
 *
 * **`ready`·`waiting` 을 여기서 계산한다**(§3.2). 저장하지 않기로 한 값이므로 조회
 * 경로가 계산의 유일한 자리다. 계산 자체는 순수 함수(`lib/core/schedule`)가 하고
 * 이 파일은 행을 그 모양으로 옮기기만 한다.
 */

export type ChecklistView = {
  tasks: AnnotatedTask[];
  edges: TaskEdge[];
  /** 위상 정렬 순서. 순환이 남아 있으면 그 사실을 화면이 말한다. */
  order: string[];
  cycle: string[];
  timeline: TimelineBucket[];
  progress: CategoryProgress[];
  next: AnnotatedTask[];
  /** 이미 만들어진 자동 생성 템플릿 코드. 다시 만들 때 건너뛴다. */
  generatedCodes: string[];
};

type TaskRow = {
  id: string;
  category: string;
  title: string;
  status: string;
  due_date: string | null;
  template_code: string | null;
  completed_out_of_order: boolean;
  assignee_id: string | null;
};

const TASK_COLUMNS =
  "id, category, title, status, due_date, template_code, completed_out_of_order, assignee_id";

function toNode(row: TaskRow): TaskNode {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    status: row.status as TaskStatus,
    dueDate: row.due_date,
    templateCode: row.template_code,
    completedOutOfOrder: row.completed_out_of_order,
  };
}

export async function loadChecklist(
  client: SupabaseClient,
  input: { coupleId: string; today: string },
): Promise<ChecklistView> {
  const { data: taskRows } = await client
    .from("tasks")
    .select(TASK_COLUMNS)
    .eq("couple_id", input.coupleId)
    .order("due_date", { ascending: true, nullsFirst: false })
    .limit(300);

  const rows = (taskRows ?? []) as unknown as TaskRow[];
  const nodes = rows.map(toNode);

  const { data: edgeRows } = rows.length
    ? await client
        .from("task_dependencies")
        .select("task_id, depends_on_task_id")
        .in(
          "task_id",
          rows.map((row) => row.id),
        )
    : { data: [] };

  const edges = ((edgeRows ?? []) as { task_id: string; depends_on_task_id: string }[]).map(
    (row) => ({ taskId: row.task_id, dependsOn: row.depends_on_task_id }),
  );

  const tasks = annotate(nodes, edges);
  const sorted = topoSort(nodes, edges);
  const order = sorted.ok ? sorted.order : nodes.map((node) => node.id);

  return {
    tasks,
    edges,
    order,
    // **순환이 남아 있으면 숨기지 않는다.** DB 가 막지만 조회가 잘려 들어올 수 있고,
    // 그때 화면이 조용히 임의 순서를 그리면 사용자는 그것을 순서로 믿는다.
    cycle: sorted.ok ? [] : sorted.remaining,
    timeline: buildTimeline({ tasks, today: input.today, order }),
    progress: categoryProgress(nodes),
    next: nextTasks(tasks),
    generatedCodes: rows
      .map((row) => row.template_code)
      .filter((code): code is string => code !== null),
  };
}

/**
 * 홈이 쓰는 '다음 할 일'.
 *
 * **`/checklist` 와 같은 함수를 부른다**(§6.2 — "홈과 같은 컴포넌트"). 규칙이 하나여야
 * 두 화면이 같은 3건을 말한다.
 */
export async function loadNextTasks(
  client: SupabaseClient,
  input: { coupleId: string; today: string },
): Promise<AnnotatedTask[]> {
  return (await loadChecklist(client, input)).next;
}

/** 완료로 옮길 때 선행이 남아 있는가. **막지 않고 기록만 한다**(§3.2). */
export async function outOfOrderOnComplete(
  client: SupabaseClient,
  input: { coupleId: string; taskId: string },
): Promise<boolean> {
  const { data: taskRows } = await client
    .from("tasks")
    .select("id, status")
    .eq("couple_id", input.coupleId);

  const statusById = new Map(
    ((taskRows ?? []) as { id: string; status: string }[]).map((row) => [
      row.id,
      row.status as TaskStatus,
    ]),
  );

  const { data: edgeRows } = await client
    .from("task_dependencies")
    .select("task_id, depends_on_task_id")
    .eq("task_id", input.taskId);

  const edges = ((edgeRows ?? []) as { task_id: string; depends_on_task_id: string }[]).map(
    (row) => ({ taskId: row.task_id, dependsOn: row.depends_on_task_id }),
  );

  return completesOutOfOrder({ taskId: input.taskId, edges, statusById });
}

/**
 * 준비 순서 그래프 (S7-18 · 명세서 §3.2 · §2.1 F-C-37 · IDEA-02)
 *
 * **`ready`·`waiting` 을 저장하지 않는다.** 선행이 완료되는 순간 화면이 바뀌어야 하는데
 * 저장하면 배치가 돌기 전까지 화면이 거짓말을 한다 — 그리고 그 배치를 놓치면 **영원히
 * 막힌 것처럼 보인다.** 그래서 이 파일은 조회 시점에 계산하는 순수 함수만 갖는다
 * (`payment_schedules` 의 '도래·연체' 와 쿠폰의 '만료·소진' 이 같은 이유로 저장값이
 * 아니다).
 *
 * **선행 미완을 잠그지 않는다.** 현실의 준비 순서는 자주 어긋나고(스드메를 먼저
 * 계약하고 홀을 나중에 잡는 커플이 있다) 우리가 가진 것은 **템플릿 추정이지 사실이
 * 아니다.** 잠그면 사용자는 우회하려고 의존을 지우고 그때 데이터가 망가진다. 그래서
 * `waiting` 은 **순서 표시**이지 잠금이 아니며, 완료는 언제나 가능하다.
 *
 * 프레임워크를 모르는 순수 모듈이다.
 */

export const TASK_STATUSES = ["todo", "doing", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type TaskNode = {
  id: string;
  title: string;
  category: string;
  status: TaskStatus;
  /** 없으면 기한 미정이다. **0으로 두지 않는다.** */
  dueDate: string | null;
  templateCode: string | null;
  completedOutOfOrder: boolean;
};

/** 간선 하나. `dependsOn` 이 **먼저** 끝나야 하는 쪽이다. */
export type TaskEdge = { taskId: string; dependsOn: string };

// =============================================================================
// ready · waiting — 계산값이다
// =============================================================================

export const READINESS = ["done", "ready", "waiting"] as const;
export type Readiness = (typeof READINESS)[number];

export const READINESS_LABEL: Record<Readiness, string> = {
  done: "완료",
  ready: "지금 할 수 있어요",
  waiting: "먼저 할 일이 있어요",
};

/**
 * **`waiting` 을 '못 한다' 로 읽히게 하지 않는다**(§6.2 · S7-19 가 화면에서 지킨다).
 * 회색 비활성으로 칠하면 사용자는 잠긴 것으로 이해하는데 잠긴 것이 아니다.
 */
export const WAITING_NOTE = "순서를 보여드리는 것이고 잠긴 것이 아니에요. 먼저 해도 됩니다.";

export type ReadinessResult = {
  readiness: Readiness;
  /** 아직 끝나지 않은 선행. 화면이 "무엇을 먼저" 를 말하는 근거다. */
  blockedBy: string[];
};

export function readinessOf(input: {
  task: Pick<TaskNode, "id" | "status">;
  edges: readonly TaskEdge[];
  statusById: ReadonlyMap<string, TaskStatus>;
}): ReadinessResult {
  if (input.task.status === "done") return { readiness: "done", blockedBy: [] };

  const blockedBy = input.edges
    .filter((edge) => edge.taskId === input.task.id)
    // **모르는 선행은 막지 않는다.** 간선이 가리키는 태스크가 조회 범위 밖이면
    // 그것으로 화면을 멈추는 것보다 진행 가능으로 보는 편이 덜 틀린다.
    .filter((edge) => input.statusById.get(edge.dependsOn) !== undefined)
    .filter((edge) => input.statusById.get(edge.dependsOn) !== "done")
    .map((edge) => edge.dependsOn);

  return { readiness: blockedBy.length === 0 ? "ready" : "waiting", blockedBy };
}

export type AnnotatedTask = TaskNode & ReadinessResult;

export function annotate(
  tasks: readonly TaskNode[],
  edges: readonly TaskEdge[],
): AnnotatedTask[] {
  const statusById = new Map(tasks.map((task) => [task.id, task.status]));

  return tasks.map((task) => ({ ...task, ...readinessOf({ task, edges, statusById }) }));
}

/**
 * 선행이 미완인 채 완료하는가.
 *
 * **막지 않는다.** 호출부는 이 값을 `completed_out_of_order` 에 **기록**할 뿐이며
 * 경고를 띄우지 않는다(§3.2) — 나중에 예산·날짜 충돌을 설명할 때 쓰인다.
 */
export function completesOutOfOrder(input: {
  taskId: string;
  edges: readonly TaskEdge[];
  statusById: ReadonlyMap<string, TaskStatus>;
}): boolean {
  return input.edges
    .filter((edge) => edge.taskId === input.taskId)
    .some((edge) => {
      const status = input.statusById.get(edge.dependsOn);

      return status !== undefined && status !== "done";
    });
}

// =============================================================================
// 위상 정렬
// =============================================================================

export type TopoResult =
  | { ok: true; order: string[] }
  /** 순환이 남아 있다. DB 가 막지만 조회 결과가 잘려 들어올 수 있어 여기서도 답한다. */
  | { ok: false; reason: "cycle"; remaining: string[] };

/**
 * 위상 정렬(칸 알고리즘).
 *
 * **동순위는 기한 순, 그다음 제목 순으로 고정한다.** 정렬이 흔들리면 같은 데이터가
 * 볼 때마다 다른 순서로 보이고, 사용자는 무언가 바뀐 줄 안다. 기한이 없는 것은
 * **뒤로** 보낸다 — 날짜를 아는 일이 모르는 일보다 먼저다.
 */
export function topoSort(tasks: readonly TaskNode[], edges: readonly TaskEdge[]): TopoResult {
  const ids = new Set(tasks.map((task) => task.id));
  const inside = edges.filter((edge) => ids.has(edge.taskId) && ids.has(edge.dependsOn));

  const indegree = new Map(tasks.map((task) => [task.id, 0]));
  const followers = new Map<string, string[]>();

  for (const edge of inside) {
    indegree.set(edge.taskId, (indegree.get(edge.taskId) ?? 0) + 1);
    followers.set(edge.dependsOn, [...(followers.get(edge.dependsOn) ?? []), edge.taskId]);
  }

  const byId = new Map(tasks.map((task) => [task.id, task]));

  const rank = (id: string) => {
    const task = byId.get(id);

    // 기한 없는 것은 뒤로. `null` 을 빈 문자열로 두면 가장 앞으로 온다.
    return `${task?.dueDate ?? "9999-12-31"}|${task?.title ?? ""}|${id}`;
  };

  const order: string[] = [];
  let queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);

  while (queue.length > 0) {
    queue.sort((a, b) => rank(a).localeCompare(rank(b)));

    const current = queue.shift() as string;
    order.push(current);

    for (const next of followers.get(current) ?? []) {
      const degree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, degree);

      if (degree === 0) queue.push(next);
    }
  }

  if (order.length !== tasks.length) {
    return {
      ok: false,
      reason: "cycle",
      remaining: tasks.map((task) => task.id).filter((id) => !order.includes(id)),
    };
  }

  return { ok: true, order };
}

// =============================================================================
// A. 역산 타임라인 — T-00g 가 정한 기본 표현
// =============================================================================

/**
 * **기본 표현은 역산 타임라인이다**(T-00g).
 *
 * 온보딩 직후 사용자가 가진 정보는 **D-day 하나뿐**이고, 진행 게이지는 그 시점에 전부
 * 0이라 "아무것도 안 했다" 만 말한다. 남은 날짜를 축으로 두면 **지금 무엇을 할 때인지**
 * 가 첫 화면에서 보인다.
 */
export type TimelineBucket = {
  /** 예식일까지 남은 일수의 구간. `null` 이면 기한 미정 묶음이다. */
  code: string;
  label: string;
  /** 구간 하한(예식일까지 남은 일수, 큰 값이 먼저다). */
  fromDays: number | null;
  toDays: number | null;
  tasks: AnnotatedTask[];
};

/**
 * 구간 경계.
 *
 * §2.1 이 "D-360 ~ D-0" 을 적었고 그 사이를 사람이 말하는 단위(개월·주)로 나눈다.
 * **경계값은 위쪽 포함**이다 — D-180 은 '6개월 전' 이지 '3개월 전' 이 아니다.
 */
export const TIMELINE_BUCKETS: readonly { code: string; label: string; fromDays: number }[] = [
  { code: "d360", label: "12개월 전", fromDays: 271 },
  { code: "d270", label: "9개월 전", fromDays: 181 },
  { code: "d180", label: "6개월 전", fromDays: 91 },
  { code: "d90", label: "3개월 전", fromDays: 31 },
  { code: "d30", label: "1개월 전", fromDays: 8 },
  { code: "d7", label: "1주 전", fromDays: 1 },
  { code: "d0", label: "예식 당일·이후", fromDays: Number.NEGATIVE_INFINITY },
];

export const TIMELINE_UNDATED = { code: "undated", label: "기한 미정" };

/** 남은 일수. **오늘을 인자로 받는다**(S2-06·S3-11 과 같은 규칙). */
export function daysUntil(today: string, date: string): number {
  const from = Date.parse(`${today}T00:00:00Z`);
  const to = Date.parse(`${date}T00:00:00Z`);

  if (Number.isNaN(from) || Number.isNaN(to)) throw new RangeError("날짜는 YYYY-MM-DD 형식이어야 합니다.");

  return Math.round((to - from) / 86_400_000);
}

export function buildTimeline(input: {
  tasks: readonly AnnotatedTask[];
  today: string;
  order: readonly string[];
}): TimelineBucket[] {
  const rank = new Map(input.order.map((id, index) => [id, index]));
  const sorted = [...input.tasks].sort(
    (a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0),
  );

  const buckets: TimelineBucket[] = TIMELINE_BUCKETS.map((bucket, index) => ({
    code: bucket.code,
    label: bucket.label,
    fromDays: Number.isFinite(bucket.fromDays) ? bucket.fromDays : null,
    toDays: index === 0 ? null : TIMELINE_BUCKETS[index - 1].fromDays - 1,
    tasks: [],
  }));

  const undated: TimelineBucket = {
    ...TIMELINE_UNDATED,
    fromDays: null,
    toDays: null,
    tasks: [],
  };

  for (const task of sorted) {
    if (task.dueDate === null) {
      undated.tasks.push(task);
      continue;
    }

    const days = daysUntil(input.today, task.dueDate);
    const index = TIMELINE_BUCKETS.findIndex((bucket) => days >= bucket.fromDays);

    buckets[index === -1 ? buckets.length - 1 : index].tasks.push(task);
  }

  // **빈 구간은 내보내지 않는다.** 12개월 전이 비어 있는데 자리를 그리면 화면이
  // "여기서 뭔가 놓쳤다" 고 말하는 셈이 된다.
  return [...buckets, undated].filter((bucket) => bucket.tasks.length > 0);
}

// =============================================================================
// B. 진행 게이지 — 카테고리별
// =============================================================================

export type CategoryProgress = {
  category: string;
  total: number;
  done: number;
  /** basis point 정수. **부동소수점을 쓰지 않는다**(§6). */
  rateBp: number;
};

export function categoryProgress(tasks: readonly TaskNode[]): CategoryProgress[] {
  const byCategory = new Map<string, { total: number; done: number }>();

  for (const task of tasks) {
    const current = byCategory.get(task.category) ?? { total: 0, done: 0 };

    byCategory.set(task.category, {
      total: current.total + 1,
      done: current.done + (task.status === "done" ? 1 : 0),
    });
  }

  return [...byCategory.entries()]
    .map(([category, counts]) => ({
      category,
      total: counts.total,
      done: counts.done,
      rateBp: counts.total === 0 ? 0 : Math.round((counts.done * 10_000) / counts.total),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

// =============================================================================
// C. 다음 할 일 — 홈과 같은 판정을 쓴다
// =============================================================================

/**
 * **홈(S3-11)과 같은 데이터를 같은 규칙으로 고른다.**
 *
 * §6.2 는 "C 다음 할 일 카드는 홈과 같은 컴포넌트를 쓴다" 고 적었다. 컴포넌트를
 * 공유하려면 **고르는 규칙도 하나여야** 한다 — 두 화면이 다른 3건을 보여주면 사용자는
 * 어느 쪽이 맞는지 묻게 된다.
 *
 * 규칙: **지금 할 수 있는 것 중 기한이 가까운 순.** `waiting` 은 넣지 않는다 —
 * 먼저 할 일이 있는 태스크를 '다음 할 일' 로 올리면 그 카드가 순서를 뒤집는다.
 */
export const NEXT_TASK_LIMIT = 3;

export function nextTasks(
  tasks: readonly AnnotatedTask[],
  limit = NEXT_TASK_LIMIT,
): AnnotatedTask[] {
  return [...tasks]
    .filter((task) => task.readiness === "ready")
    .sort(
      (a, b) =>
        (a.dueDate ?? "9999-12-31").localeCompare(b.dueDate ?? "9999-12-31") ||
        a.title.localeCompare(b.title),
    )
    .slice(0, limit);
}

// =============================================================================
// 템플릿 → 태스크 (자동 생성이 순서를 함께 옮긴다)
// =============================================================================

export type TemplateNode = { code: string; category: string; title: string; offsetDays: number };
export type TemplateEdge = { templateCode: string; dependsOnCode: string };

export type GeneratedTask = {
  templateCode: string;
  category: string;
  title: string;
  /** 예식일 + offsetDays. 예식일이 없으면 null 이고 기한 미정으로 만든다. */
  dueDate: string | null;
};

/**
 * 역산 생성.
 *
 * **예식일이 없으면 기한을 지어내지 않는다.** 오늘 기준으로 잡으면 그 날짜는 사용자가
 * 정한 적 없는 값이고, 나중에 예식일이 정해져도 그 값이 남는다.
 */
export function generateFromTemplates(input: {
  templates: readonly TemplateNode[];
  weddingDate: string | null;
}): GeneratedTask[] {
  return input.templates.map((template) => ({
    templateCode: template.code,
    category: template.category,
    title: template.title,
    dueDate:
      input.weddingDate === null
        ? null
        : new Date(Date.parse(`${input.weddingDate}T00:00:00Z`) + template.offsetDays * 86_400_000)
            .toISOString()
            .slice(0, 10),
  }));
}

/**
 * 템플릿 순서를 태스크 간선으로 옮긴다.
 *
 * **매핑에 없는 코드는 버린다.** 템플릿에는 있지만 이 커플에 만들어지지 않은 태스크를
 * 가리키는 간선은 **없는 선행**이 되고, 화면은 영영 오지 않을 무언가를 기다린다.
 */
export function mapTemplateEdges(input: {
  edges: readonly TemplateEdge[];
  taskIdByCode: ReadonlyMap<string, string>;
}): TaskEdge[] {
  const mapped: TaskEdge[] = [];

  for (const edge of input.edges) {
    const taskId = input.taskIdByCode.get(edge.templateCode);
    const dependsOn = input.taskIdByCode.get(edge.dependsOnCode);

    if (taskId === undefined || dependsOn === undefined) continue;
    if (taskId === dependsOn) continue;

    mapped.push({ taskId, dependsOn });
  }

  return mapped;
}

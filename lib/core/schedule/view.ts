import {
  READINESS_LABEL,
  type AnnotatedTask,
  type Readiness,
  type TaskEdge,
  type TaskNode,
} from "./graph";

/**
 * 준비 순서 뷰 — 표현 넷 (S7-19 · 명세서 §2.1 F-C-37 · §6.2 · IDEA-02)
 *
 * ── 이 파일이 있는 이유 ──────────────────────────────────────────────────────
 * **표현을 고르는 규칙과 칠하는 규칙을 화면에서 꺼냈다.** 뷰가 넷이라 같은 판단이
 * 네 군데로 흩어지기 쉽고, 흩어지면 한쪽만 고치는 날이 온다 — S7-08 이 '다음 할 일'
 * 에서 겪은 것과 같은 위험이다(§6.2 가 컴포넌트 공유를 요구한 이유이기도 하다).
 *
 * ── `waiting` 을 회색으로 칠하지 않는 규칙을 여기서 지킨다 ────────────────────
 * 회색 비활성은 **'못 한다'** 로 읽히는데 잠긴 것이 아니다(§3.2 · D-71 · S7-18).
 * 화면 파일에 흩어 두면 뷰를 하나 더 만드는 날 그 규칙이 따라오지 않는다. 그래서
 * 배지 모양을 **함수가 정하고 테스트가 붙잡는다** — `waiting` 은 어떤 뷰에서도
 * 흐려지지 않는다.
 *
 * 프레임워크를 모르는 순수 모듈이다.
 */

// =============================================================================
// 표현 넷 — 코드·라벨·기본값
// =============================================================================

export const SCHEDULE_VIEWS = ["timeline", "progress", "next", "graph"] as const;
export type ScheduleView = (typeof SCHEDULE_VIEWS)[number];

/**
 * **기본은 A 역산 타임라인이다**(T-00g · §2.1 F-C-37).
 *
 * 온보딩 직후 사용자가 가진 정보는 D-day 하나뿐이고 진행 게이지는 그 시점에 전부
 * 0이라 "아무것도 안 했다" 만 말한다. 남은 날짜를 축으로 두면 **지금 무엇을 할 때인지**
 * 가 첫 화면에서 보인다.
 */
export const DEFAULT_SCHEDULE_VIEW: ScheduleView = "timeline";

export const SCHEDULE_VIEW_LABEL: Record<ScheduleView, string> = {
  timeline: "순서",
  progress: "진행",
  next: "다음 할 일",
  graph: "관계",
};

/**
 * 각 표현이 **캘린더가 못 하는 무엇을** 말하는가.
 *
 * S7-18 이 정리한 대로 보기 전용 화면이 캘린더보다 더 주는 것은 **순서**와
 * **"지금 할 수 있는가"** 둘뿐이다. 화면에 이 문장을 적어 두면 O-16 이 판정할 때
 * 무엇을 재려 했는지가 남는다.
 */
export const SCHEDULE_VIEW_NOTE: Record<ScheduleView, string> = {
  timeline: "예식일에서 거꾸로 세어 지금이 어느 때인지 보여드려요.",
  progress: "카테고리별로 어디까지 왔는지 보여드려요.",
  next: "지금 할 수 있는 일만 골라 보여드려요.",
  graph: "무엇을 먼저 해야 무엇이 되는지 보여드려요.",
};

/**
 * 켜져 있는 표현.
 *
 * **O-16(일정 뷰의 실효 검증)이 "못 주는 표현은 삭제가 아니라 `feature_flags` 로
 * 끈다" 고 정했다**(§7.5). 판정은 지표가 붙는 S8-01 이후이므로 **지금은 넷 다 켠다** —
 * 여기서 미리 끄면 그것이 판정을 앞지른 셈이 된다(D-66 이 어뷰징 임계값에서 세운
 * 규칙과 같다).
 *
 * **기본 표현은 꺼도 살아남는다.** 넷을 전부 끄면 화면이 비는데, 그것은 O-16 이
 * 의도한 결과가 아니라 설정 사고다 — 하나도 남지 않으면 `timeline` 을 되살린다.
 */
export function enabledViews(rollout: Record<string, unknown> | null): ScheduleView[] {
  const enabled = SCHEDULE_VIEWS.filter((view) => {
    // **행이 없거나 키가 없으면 켜진 것으로 읽는다.** 플래그가 없는 상태는 "아직
    // 판정하지 않았다" 이지 "끄기로 했다" 가 아니다 — 커뮤니티(`community.enabled`)와
    // 반대 방향인데, 그쪽은 여는 조건이 미충족이었고 이쪽은 조건이 없다.
    const value = rollout?.[view];

    return value !== false;
  });

  return enabled.length > 0 ? enabled : [DEFAULT_SCHEDULE_VIEW];
}

/** 요청받은 표현이 켜져 있는가. 꺼져 있으면 켜진 것 중 첫째로 내린다. */
export function resolveView(
  requested: string | null,
  enabled: readonly ScheduleView[],
): ScheduleView {
  const view = SCHEDULE_VIEWS.find((candidate) => candidate === requested);

  if (view !== undefined && enabled.includes(view)) return view;

  return enabled.includes(DEFAULT_SCHEDULE_VIEW) ? DEFAULT_SCHEDULE_VIEW : enabled[0];
}

// =============================================================================
// 배지 — `waiting` 을 흐리지 않는다
// =============================================================================

/**
 * 배지 모양. `variant` 는 디자인 시스템의 값이고 **새 색을 만들지 않는다**(DESIGN.md).
 *
 * `dimmed` 가 이 타입의 요점이다 — **`waiting` 은 언제나 `false`** 이며 테스트가
 * 그것을 붙잡는다. 화면이 이 값을 보고 칠하므로 규칙이 한 곳에 있다.
 */
export type ReadinessBadge = {
  label: string;
  variant: "default" | "secondary" | "outline";
  /** 흐리게(비활성처럼) 칠해도 되는가. **`waiting` 에는 절대 참이 아니다.** */
  dimmed: boolean;
};

export function readinessBadge(readiness: Readiness): ReadinessBadge {
  if (readiness === "done") {
    // 완료는 흐려도 된다 — 이미 지나간 일이고 '못 한다' 로 읽힐 여지가 없다.
    return { label: READINESS_LABEL.done, variant: "secondary", dimmed: true };
  }

  if (readiness === "ready") {
    return { label: READINESS_LABEL.ready, variant: "default", dimmed: false };
  }

  // **순서 표시이지 잠금이 아니다.** 회색으로 칠하면 화면이 결정을 뒤집는다.
  return { label: READINESS_LABEL.waiting, variant: "outline", dimmed: false };
}

// =============================================================================
// D. 의존 관계 뷰 — 단계로 쌓는다
// =============================================================================

/**
 * **그래프를 그리지 않고 단계로 쌓는다.**
 *
 * 노드·간선을 SVG 로 그리면 375px 에서 읽히지 않고(§7.5 터치 타깃 규칙과 같은 자리),
 * 무엇보다 사용자가 알고 싶은 것은 **배치가 아니라 문장**이다 — "이걸 먼저 해야
 * 저게 됩니다"(§2.1 F-C-37). 그래서 각 태스크의 **가장 긴 선행 사슬 길이**를 단계로
 * 삼아 세로로 쌓고, 태스크마다 자기 선행을 이름으로 적는다.
 *
 * 단계 = 나에게 도달하는 가장 긴 경로의 길이. 선행이 없으면 0단계다. **가장 긴
 * 것을 쓰는 이유**는 짧은 쪽을 쓰면 선행보다 앞 단계에 놓이는 태스크가 생기고,
 * 그러면 표가 순서를 거꾸로 말하기 때문이다.
 *
 * 순환이 남아 있으면(DB 가 막지만 조회가 잘려 들어올 수 있다) 그 태스크들은
 * **`cycle` 로 따로 내보낸다** — 임의의 단계에 끼워 넣으면 그것이 순서로 믿긴다.
 */
export type DependencyLevel = {
  depth: number;
  tasks: AnnotatedTask[];
};

export type DependencyLayout = {
  levels: DependencyLevel[];
  /** 단계를 정할 수 없는 태스크(순환). 화면이 그 사실을 말한다. */
  cycle: AnnotatedTask[];
};

export function dependencyLevels(
  tasks: readonly AnnotatedTask[],
  edges: readonly TaskEdge[],
): DependencyLayout {
  const byId = new Map(tasks.map((task) => [task.id, task]));

  // 조회 범위 밖을 가리키는 간선은 버린다. 없는 선행으로 단계를 밀면 화면이
  // 오지 않을 무언가를 기다리는 셈이 된다(`readinessOf` 와 같은 판단이다).
  const inside = edges.filter((edge) => byId.has(edge.taskId) && byId.has(edge.dependsOn));

  const prerequisites = new Map<string, string[]>();
  for (const edge of inside) {
    prerequisites.set(edge.taskId, [...(prerequisites.get(edge.taskId) ?? []), edge.dependsOn]);
  }

  const depthById = new Map<string, number>();
  const visiting = new Set<string>();
  const cyclic = new Set<string>();

  function depthOf(id: string): number {
    const known = depthById.get(id);
    if (known !== undefined) return known;

    if (visiting.has(id)) {
      cyclic.add(id);

      return 0;
    }

    visiting.add(id);

    let depth = 0;
    for (const prerequisite of prerequisites.get(id) ?? []) {
      depth = Math.max(depth, depthOf(prerequisite) + 1);
    }

    visiting.delete(id);
    depthById.set(id, depth);

    return depth;
  }

  for (const task of tasks) depthOf(task.id);

  // 순환에 걸린 태스크가 있으면 그 태스크를 선행으로 두는 것들도 단계를 믿을 수 없다.
  let grew = true;
  while (grew) {
    grew = false;

    for (const task of tasks) {
      if (cyclic.has(task.id)) continue;

      if ((prerequisites.get(task.id) ?? []).some((id) => cyclic.has(id))) {
        cyclic.add(task.id);
        grew = true;
      }
    }
  }

  const buckets = new Map<number, AnnotatedTask[]>();

  for (const task of tasks) {
    if (cyclic.has(task.id)) continue;

    const depth = depthById.get(task.id) ?? 0;
    buckets.set(depth, [...(buckets.get(depth) ?? []), task]);
  }

  // 같은 단계 안은 **기한 순, 그다음 제목 순**으로 고정한다(`topoSort` 와 같은 규칙).
  // 정렬이 흔들리면 같은 데이터가 볼 때마다 다르게 보이고 사용자는 뭔가 바뀐 줄 안다.
  const rank = (task: AnnotatedTask) => `${task.dueDate ?? "9999-12-31"}|${task.title}|${task.id}`;

  return {
    levels: [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([depth, items]) => ({
        depth,
        tasks: [...items].sort((a, b) => rank(a).localeCompare(rank(b))),
      })),
    cycle: tasks.filter((task) => cyclic.has(task.id)),
  };
}

/**
 * 선행으로 고를 수 있는 후보.
 *
 * **막지 않는다 — 줄여서 보여줄 뿐이다.** 최종 판정은 DB 트리거이며(D-71) 여기서
 * 거르는 것은 **이미 확실히 틀린 셋**뿐이다: 자기 자신 · 이미 이어 둔 것 ·
 * **이 태스크에서 뻗어 나가는 쪽**(그것을 선행으로 두면 순환이다).
 *
 * 순환 후보를 화면에서 미리 지우는 이유는, 고를 수 있게 해 두고 422 로 답하면
 * 사용자는 **자기가 무엇을 잘못했는지 모른 채 거절만 받기** 때문이다. 그래도
 * 판정을 화면이 갖지는 않는다 — 여기서 못 거른 것은 DB 가 막는다.
 */
export function dependencyCandidates(input: {
  taskId: string;
  tasks: readonly TaskNode[];
  edges: readonly TaskEdge[];
}): TaskNode[] {
  const followers = new Map<string, string[]>();
  for (const edge of input.edges) {
    followers.set(edge.dependsOn, [...(followers.get(edge.dependsOn) ?? []), edge.taskId]);
  }

  // 이 태스크에 (직·간접으로) 의존하는 것들. 그 중 하나를 선행으로 삼으면 순환이다.
  const downstream = new Set<string>();
  const stack = [input.taskId];

  while (stack.length > 0) {
    const current = stack.pop() as string;

    for (const next of followers.get(current) ?? []) {
      if (downstream.has(next)) continue;

      downstream.add(next);
      stack.push(next);
    }
  }

  const already = new Set(
    input.edges.filter((edge) => edge.taskId === input.taskId).map((edge) => edge.dependsOn),
  );

  return input.tasks
    .filter((task) => task.id !== input.taskId)
    .filter((task) => !already.has(task.id))
    .filter((task) => !downstream.has(task.id))
    .sort((a, b) =>
      `${a.dueDate ?? "9999-12-31"}|${a.title}`.localeCompare(`${b.dueDate ?? "9999-12-31"}|${b.title}`),
    );
}

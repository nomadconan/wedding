import { describe, expect, it } from "vitest";

import {
  TASK_DEPENDENCY_ERRORS,
  TaskDependencySchema,
  taskDependencyErrorOf,
} from "../schemas/task";
import { READINESS, annotate, type TaskEdge, type TaskNode } from "./graph";
import {
  DEFAULT_SCHEDULE_VIEW,
  SCHEDULE_VIEWS,
  SCHEDULE_VIEW_LABEL,
  SCHEDULE_VIEW_NOTE,
  dependencyCandidates,
  dependencyLevels,
  enabledViews,
  readinessBadge,
  resolveView,
} from "./view";

const task = (over: Partial<TaskNode> & { id: string }): TaskNode => ({
  title: over.id,
  category: "hall",
  status: "todo",
  dueDate: null,
  templateCode: null,
  completedOutOfOrder: false,
  ...over,
});

describe("표현 넷 — 목록과 기본값", () => {
  it("표현은 넷이다 (§2.1 F-C-37)", () => {
    expect(SCHEDULE_VIEWS).toHaveLength(4);
    expect([...SCHEDULE_VIEWS]).toEqual(["timeline", "progress", "next", "graph"]);
  });

  it("**기본은 A 역산 타임라인이다** — 온보딩 직후 게이지는 전부 0이라 아무것도 말하지 못한다", () => {
    expect(DEFAULT_SCHEDULE_VIEW).toBe("timeline");
  });

  it("넷 다 라벨과 '캘린더가 못 하는 무엇' 문장을 갖는다", () => {
    for (const view of SCHEDULE_VIEWS) {
      expect(SCHEDULE_VIEW_LABEL[view]).not.toBe("");
      expect(SCHEDULE_VIEW_NOTE[view]).not.toBe("");
    }
  });
});

describe("플래그 — O-16 이 끄는 자리를 만들어 둔다", () => {
  it("**행이 없으면 넷 다 켜진 것으로 읽는다** — 판정 전이지 끄기로 한 것이 아니다", () => {
    expect(enabledViews(null)).toEqual([...SCHEDULE_VIEWS]);
    expect(enabledViews({})).toEqual([...SCHEDULE_VIEWS]);
  });

  it("false 로 적힌 표현만 끈다", () => {
    expect(enabledViews({ progress: false, graph: false })).toEqual(["timeline", "next"]);
  });

  it("**넷을 다 끄면 기본 표현을 되살린다** — 빈 화면은 O-16 이 의도한 결과가 아니다", () => {
    expect(
      enabledViews({ timeline: false, progress: false, next: false, graph: false }),
    ).toEqual([DEFAULT_SCHEDULE_VIEW]);
  });

  it("요청한 표현이 꺼져 있으면 켜진 것으로 내린다", () => {
    expect(resolveView("graph", ["timeline", "next"])).toBe("timeline");
    expect(resolveView("next", ["timeline", "next"])).toBe("next");
    expect(resolveView("없는뷰", [...SCHEDULE_VIEWS])).toBe(DEFAULT_SCHEDULE_VIEW);
    expect(resolveView(null, ["progress", "graph"])).toBe("progress");
  });
});

describe("배지 — waiting 을 흐리지 않는다", () => {
  it("**`waiting` 은 어떤 뷰에서도 흐려지지 않는다** — 회색은 '못 한다' 로 읽힌다", () => {
    expect(readinessBadge("waiting").dimmed).toBe(false);
  });

  it("`ready` 도 흐려지지 않는다", () => {
    expect(readinessBadge("ready").dimmed).toBe(false);
  });

  it("완료만 흐릴 수 있다 — 이미 지나간 일이라 오해할 여지가 없다", () => {
    expect(readinessBadge("done").dimmed).toBe(true);
  });

  it("셋 다 문구를 갖는다", () => {
    for (const readiness of READINESS) {
      expect(readinessBadge(readiness).label).not.toBe("");
    }
  });
});

describe("D. 의존 관계 — 단계로 쌓는다", () => {
  const tasks = [task({ id: "hall" }), task({ id: "date" }), task({ id: "sdm" })];
  const edges: TaskEdge[] = [
    { taskId: "date", dependsOn: "hall" },
    { taskId: "sdm", dependsOn: "date" },
  ];

  it("선행이 없으면 0단계, 사슬을 따라 깊어진다", () => {
    const layout = dependencyLevels(annotate(tasks, edges), edges);

    expect(layout.levels.map((level) => [level.depth, level.tasks.map((t) => t.id)])).toEqual([
      [0, ["hall"]],
      [1, ["date"]],
      [2, ["sdm"]],
    ]);
    expect(layout.cycle).toEqual([]);
  });

  it("**가장 긴 사슬을 쓴다** — 짧은 쪽을 쓰면 선행보다 앞 단계에 놓이는 태스크가 생긴다", () => {
    const wide = [...tasks, task({ id: "late" })];
    const wideEdges: TaskEdge[] = [
      ...edges,
      // late 는 hall(0단계)에도 sdm(2단계)에도 의존한다 → 3단계여야 한다.
      { taskId: "late", dependsOn: "hall" },
      { taskId: "late", dependsOn: "sdm" },
    ];

    const layout = dependencyLevels(annotate(wide, wideEdges), wideEdges);

    expect(layout.levels.at(-1)).toEqual({
      depth: 3,
      tasks: [expect.objectContaining({ id: "late" })],
    });
  });

  it("같은 단계는 기한 순, 그다음 제목 순으로 고정한다", () => {
    const same = [
      task({ id: "c", title: "c", dueDate: "2026-03-01" }),
      task({ id: "a", title: "a", dueDate: "2026-01-01" }),
      task({ id: "b", title: "b", dueDate: null }),
    ];

    const layout = dependencyLevels(annotate(same, []), []);

    // 기한 미정은 뒤로 — 날짜를 아는 일이 모르는 일보다 먼저다.
    expect(layout.levels[0].tasks.map((t) => t.id)).toEqual(["a", "c", "b"]);
  });

  it("조회 범위 밖을 가리키는 간선은 단계를 밀지 않는다", () => {
    const outside: TaskEdge[] = [{ taskId: "hall", dependsOn: "없는-태스크" }];
    const layout = dependencyLevels(annotate(tasks, outside), outside);

    expect(layout.levels[0].tasks.map((t) => t.id)).toContain("hall");
    expect(layout.cycle).toEqual([]);
  });

  it("**순환은 단계에 끼워 넣지 않고 따로 내보낸다** — 임의 단계에 넣으면 그것이 순서로 믿긴다", () => {
    const cyclic: TaskEdge[] = [
      { taskId: "hall", dependsOn: "sdm" },
      { taskId: "sdm", dependsOn: "hall" },
    ];

    const layout = dependencyLevels(annotate(tasks, cyclic), cyclic);
    const cycleIds = layout.cycle.map((t) => t.id);

    expect(cycleIds).toContain("hall");
    expect(cycleIds).toContain("sdm");
    expect(layout.levels.flatMap((level) => level.tasks.map((t) => t.id))).not.toContain("hall");
  });

  it("순환에 매달린 태스크도 단계를 믿을 수 없으므로 함께 뺀다", () => {
    const cyclic: TaskEdge[] = [
      { taskId: "hall", dependsOn: "sdm" },
      { taskId: "sdm", dependsOn: "hall" },
      { taskId: "date", dependsOn: "hall" },
    ];

    const layout = dependencyLevels(annotate(tasks, cyclic), cyclic);

    expect(layout.cycle.map((t) => t.id).sort()).toEqual(["date", "hall", "sdm"]);
    expect(layout.levels).toEqual([]);
  });
});

describe("선행 후보 — 막는 것이 아니라 줄이는 것이다", () => {
  const tasks = [task({ id: "hall" }), task({ id: "date" }), task({ id: "sdm" }), task({ id: "gift" })];
  const edges: TaskEdge[] = [
    { taskId: "date", dependsOn: "hall" },
    { taskId: "sdm", dependsOn: "date" },
  ];

  it("자기 자신은 후보가 아니다", () => {
    expect(dependencyCandidates({ taskId: "date", tasks, edges }).map((t) => t.id)).not.toContain("date");
  });

  it("이미 이어 둔 선행은 후보가 아니다", () => {
    expect(dependencyCandidates({ taskId: "date", tasks, edges }).map((t) => t.id)).not.toContain("hall");
  });

  it("**나에게 의존하는 쪽은 후보가 아니다** — 그것을 선행으로 두면 순환이다", () => {
    // hall 의 후보에서 date·sdm 이 빠진다(date→hall, sdm→date).
    expect(dependencyCandidates({ taskId: "hall", tasks, edges }).map((t) => t.id)).toEqual(["gift"]);
  });

  it("먼 후손도 뺀다 (간접 순환)", () => {
    const deep: TaskEdge[] = [...edges, { taskId: "gift", dependsOn: "sdm" }];

    expect(dependencyCandidates({ taskId: "hall", tasks, edges: deep })).toEqual([]);
  });

  it("후보는 기한 순으로 준다", () => {
    const dated = [
      task({ id: "a", title: "a", dueDate: "2026-05-01" }),
      task({ id: "b", title: "b", dueDate: "2026-01-01" }),
      task({ id: "target", title: "target" }),
    ];

    expect(dependencyCandidates({ taskId: "target", tasks: dated, edges: [] }).map((t) => t.id)).toEqual([
      "b",
      "a",
    ]);
  });
});

describe("선행 편집 입력·거절 코드", () => {
  it("uuid 하나만 받는다 — 여분의 키를 거부한다", () => {
    expect(TaskDependencySchema.safeParse({ dependsOn: crypto.randomUUID() }).success).toBe(true);
    expect(TaskDependencySchema.safeParse({ dependsOn: "먼저-할-일" }).success).toBe(false);
    expect(
      TaskDependencySchema.safeParse({ dependsOn: crypto.randomUUID(), force: true }).success,
    ).toBe(false);
  });

  it("§4.2 가 적은 세 코드를 갖는다", () => {
    expect(TASK_DEPENDENCY_ERRORS.task_cycle.code).toBe("TASK_CYCLE");
    expect(TASK_DEPENDENCY_ERRORS.task_foreign_couple.code).toBe("TASK_FOREIGN_COUPLE");
    expect(TASK_DEPENDENCY_ERRORS.task_depth_exceeded.code).toBe("TASK_DEPTH_EXCEEDED");
  });

  it("제약 이름으로 사유를 읽는다", () => {
    expect(taskDependencyErrorOf({ constraint: "task_cycle" })).toBe("task_cycle");
    expect(taskDependencyErrorOf({ constraint: "task_depth_unconfigured" })).toBe(
      "task_depth_unconfigured",
    );
  });

  it("제약 이름이 없으면 메시지 본문에서 읽는다", () => {
    expect(
      taskDependencyErrorOf({ constraint: null, message: '... constraint "task_foreign_couple" ...' }),
    ).toBe("task_foreign_couple");
  });

  it("**모르는 오류를 아는 척하지 않는다** — 짝이 없으면 null 이다", () => {
    expect(taskDependencyErrorOf({ constraint: "unknown", message: "boom" })).toBeNull();
    expect(taskDependencyErrorOf({})).toBeNull();
  });
});

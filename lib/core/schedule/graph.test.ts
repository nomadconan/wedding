import { describe, expect, it } from "vitest";

import {
  NEXT_TASK_LIMIT,
  TIMELINE_BUCKETS,
  WAITING_NOTE,
  annotate,
  buildTimeline,
  categoryProgress,
  completesOutOfOrder,
  daysUntil,
  generateFromTemplates,
  mapTemplateEdges,
  nextTasks,
  readinessOf,
  topoSort,
  type TaskEdge,
  type TaskNode,
} from "./graph";

const task = (over: Partial<TaskNode> & { id: string }): TaskNode => ({
  title: over.id,
  category: "hall",
  status: "todo",
  dueDate: null,
  templateCode: null,
  completedOutOfOrder: false,
  ...over,
});

describe("ready · waiting — 계산값이다", () => {
  const statusById = new Map([
    ["a", "done" as const],
    ["b", "todo" as const],
    ["c", "todo" as const],
  ]);

  it("선행이 모두 끝났으면 지금 할 수 있다", () => {
    const result = readinessOf({
      task: { id: "c", status: "todo" },
      edges: [{ taskId: "c", dependsOn: "a" }],
      statusById,
    });

    expect(result).toEqual({ readiness: "ready", blockedBy: [] });
  });

  it("선행이 남았으면 기다린다 — **무엇을 먼저 해야 하는지 함께 준다**", () => {
    const result = readinessOf({
      task: { id: "c", status: "todo" },
      edges: [
        { taskId: "c", dependsOn: "a" },
        { taskId: "c", dependsOn: "b" },
      ],
      statusById,
    });

    expect(result).toEqual({ readiness: "waiting", blockedBy: ["b"] });
  });

  it("완료된 태스크는 선행과 무관하게 done 이다", () => {
    expect(
      readinessOf({
        task: { id: "c", status: "done" },
        edges: [{ taskId: "c", dependsOn: "b" }],
        statusById,
      }).readiness,
    ).toBe("done");
  });

  it("**조회 범위 밖의 선행은 막지 않는다** — 화면을 멈추는 것보다 덜 틀린다", () => {
    expect(
      readinessOf({
        task: { id: "c", status: "todo" },
        edges: [{ taskId: "c", dependsOn: "없는-태스크" }],
        statusById,
      }).readiness,
    ).toBe("ready");
  });

  it("**waiting 은 잠금이 아니다** — 화면이 쓸 문장을 코드가 갖는다", () => {
    expect(WAITING_NOTE).toContain("잠긴 것이 아니");
  });

  it("선행 미완 완료를 **막지 않고 기록한다**", () => {
    expect(
      completesOutOfOrder({
        taskId: "c",
        edges: [{ taskId: "c", dependsOn: "b" }],
        statusById,
      }),
    ).toBe(true);

    expect(
      completesOutOfOrder({
        taskId: "c",
        edges: [{ taskId: "c", dependsOn: "a" }],
        statusById,
      }),
    ).toBe(false);
  });
});

describe("위상 정렬", () => {
  const tasks = [
    task({ id: "c", dueDate: "2027-01-03" }),
    task({ id: "a", dueDate: "2027-01-01" }),
    task({ id: "b", dueDate: "2027-01-02" }),
  ];

  it("선행이 먼저 온다", () => {
    const edges: TaskEdge[] = [
      { taskId: "b", dependsOn: "a" },
      { taskId: "c", dependsOn: "b" },
    ];

    expect(topoSort(tasks, edges)).toEqual({ ok: true, order: ["a", "b", "c"] });
  });

  it("**동순위는 기한 순으로 고정된다** — 볼 때마다 순서가 바뀌면 안 된다", () => {
    const result = topoSort(tasks, []);

    expect(result).toEqual({ ok: true, order: ["a", "b", "c"] });
  });

  it("기한 없는 것은 뒤로 간다 — 날짜를 아는 일이 먼저다", () => {
    const result = topoSort([task({ id: "z" }), task({ id: "a", dueDate: "2027-01-01" })], []);

    expect(result).toEqual({ ok: true, order: ["a", "z"] });
  });

  it("순환이 남아 있으면 그 사실을 말한다 (DB 가 막지만 조회가 잘려 들어올 수 있다)", () => {
    const result = topoSort(
      [task({ id: "a" }), task({ id: "b" })],
      [
        { taskId: "a", dependsOn: "b" },
        { taskId: "b", dependsOn: "a" },
      ],
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.remaining.sort()).toEqual(["a", "b"]);
  });

  it("범위 밖을 가리키는 간선은 정렬을 막지 않는다", () => {
    expect(topoSort([task({ id: "a" })], [{ taskId: "a", dependsOn: "밖" }]).ok).toBe(true);
  });
});

describe("A. 역산 타임라인 — 기본 표현 (T-00g)", () => {
  const today = "2026-08-16";

  it("남은 일수를 센다", () => {
    expect(daysUntil(today, "2026-08-17")).toBe(1);
    expect(daysUntil(today, "2026-08-15")).toBe(-1);
  });

  it("구간이 12개월 전부터 예식 당일까지 이어진다", () => {
    expect(TIMELINE_BUCKETS[0].code).toBe("d360");
    expect(TIMELINE_BUCKETS.at(-1)?.code).toBe("d0");
  });

  it("남은 일수로 구간을 나눈다", () => {
    const tasks = annotate(
      [
        task({ id: "far", dueDate: "2027-08-16" }),
        task({ id: "soon", dueDate: "2026-08-20" }),
        task({ id: "none" }),
      ],
      [],
    );

    const timeline = buildTimeline({
      tasks,
      today,
      order: tasks.map((item) => item.id),
    });

    expect(timeline.map((bucket) => bucket.code)).toEqual(["d360", "d7", "undated"]);
  });

  it("**빈 구간은 내보내지 않는다** — 자리를 그리면 뭔가 놓친 것처럼 보인다", () => {
    const tasks = annotate([task({ id: "one", dueDate: "2026-08-20" })], []);
    const timeline = buildTimeline({ tasks, today, order: ["one"] });

    expect(timeline).toHaveLength(1);
  });

  it("구간 안의 순서는 위상 정렬을 따른다", () => {
    const tasks = annotate(
      [
        task({ id: "b", dueDate: "2026-08-19" }),
        task({ id: "a", dueDate: "2026-08-20" }),
      ],
      [{ taskId: "b", dependsOn: "a" }],
    );

    const timeline = buildTimeline({ tasks, today, order: ["a", "b"] });

    expect(timeline[0].tasks.map((item) => item.id)).toEqual(["a", "b"]);
  });
});

describe("B. 진행 게이지", () => {
  it("카테고리별 완료율을 bp 정수로 낸다 — 부동소수점을 쓰지 않는다", () => {
    const progress = categoryProgress([
      task({ id: "a", category: "hall", status: "done" }),
      task({ id: "b", category: "hall" }),
      task({ id: "c", category: "sdm", status: "done" }),
    ]);

    expect(progress).toEqual([
      { category: "hall", total: 2, done: 1, rateBp: 5_000 },
      { category: "sdm", total: 1, done: 1, rateBp: 10_000 },
    ]);
  });

  it("태스크가 없으면 0bp 이고 나눗셈이 터지지 않는다", () => {
    expect(categoryProgress([])).toEqual([]);
  });
});

describe("C. 다음 할 일 — 홈과 같은 규칙", () => {
  const tasks = annotate(
    [
      task({ id: "blocked", dueDate: "2026-08-17" }),
      task({ id: "ready1", dueDate: "2026-08-18" }),
      task({ id: "ready2", dueDate: "2026-08-19" }),
      task({ id: "ready3", dueDate: "2026-08-20" }),
      task({ id: "ready4", dueDate: "2026-08-21" }),
      task({ id: "pre" }),
    ],
    [{ taskId: "blocked", dependsOn: "pre" }],
  );

  it("**waiting 을 다음 할 일로 올리지 않는다** — 그 카드가 순서를 뒤집는다", () => {
    expect(nextTasks(tasks).map((item) => item.id)).not.toContain("blocked");
  });

  it("기한이 가까운 순으로 3건이다 (홈과 같은 상한)", () => {
    expect(nextTasks(tasks).map((item) => item.id)).toEqual(["ready1", "ready2", "ready3"]);
    expect(NEXT_TASK_LIMIT).toBe(3);
  });
});

describe("템플릿 → 태스크", () => {
  const templates = [
    { code: "T-hall", category: "hall", title: "웨딩홀 계약", offsetDays: -270 },
    { code: "T-sdm", category: "sdm", title: "스드메 계약", offsetDays: -180 },
  ];

  it("예식일에서 역산해 기한을 만든다", () => {
    const generated = generateFromTemplates({ templates, weddingDate: "2027-05-15" });

    expect(generated[0].dueDate).toBe("2026-08-18");
    expect(generated[1].dueDate).toBe("2026-11-16");
  });

  it("**예식일이 없으면 기한을 지어내지 않는다**", () => {
    const generated = generateFromTemplates({ templates, weddingDate: null });

    expect(generated.every((item) => item.dueDate === null)).toBe(true);
  });

  it("템플릿 순서를 태스크 간선으로 옮긴다", () => {
    const edges = mapTemplateEdges({
      edges: [{ templateCode: "T-sdm", dependsOnCode: "T-hall" }],
      taskIdByCode: new Map([
        ["T-hall", "task-1"],
        ["T-sdm", "task-2"],
      ]),
    });

    expect(edges).toEqual([{ taskId: "task-2", dependsOn: "task-1" }]);
  });

  it("**매핑에 없는 코드는 버린다** — 없는 선행을 만들면 영영 오지 않을 것을 기다린다", () => {
    const edges = mapTemplateEdges({
      edges: [{ templateCode: "T-sdm", dependsOnCode: "T-없음" }],
      taskIdByCode: new Map([["T-sdm", "task-2"]]),
    });

    expect(edges).toEqual([]);
  });
});

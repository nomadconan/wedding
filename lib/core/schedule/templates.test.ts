import { describe, expect, it } from "vitest";

import { topoSort } from "./graph";
import {
  SCHEDULE_TEMPLATES,
  SCHEDULE_TEMPLATES_VERSION,
  SCHEDULE_TEMPLATE_CODES,
  TASK_CATEGORIES,
  TASK_CATEGORY_LABEL,
  templateDefects,
  templateEdges,
} from "./templates";

describe("템플릿 목록 — 스스로 온전한가", () => {
  it("**결함이 없다** — 없는 코드·순환·순서 뒤집힘", () => {
    expect(templateDefects()).toEqual([]);
  });

  it("코드가 겹치지 않는다", () => {
    expect(SCHEDULE_TEMPLATE_CODES.size).toBe(SCHEDULE_TEMPLATES.length);
  });

  it("§2.1 이 적은 여섯 카테고리를 모두 쓴다", () => {
    const used = new Set(SCHEDULE_TEMPLATES.map((template) => template.category));

    expect([...used].sort()).toEqual([...TASK_CATEGORIES].sort());
  });

  it("카테고리마다 사람이 읽는 이름이 있다", () => {
    for (const category of TASK_CATEGORIES) {
      expect(TASK_CATEGORY_LABEL[category].length).toBeGreaterThan(0);
    }
  });

  it("오프셋이 D-360 ~ 예식 후 1개월 안에 있다 (§2.1 · C-4a)", () => {
    // **상한이 0 이 아니다.** 예식 뒤에 오는 일(축의금 정산·답례 인사·혼인신고
    // 제출)이 생겼고, 그것이 C-4a 의 절반이다. DB CHECK(-1000~365)보다 좁게 잡아
    // 목록 자체가 먼저 이상해지게 한다.
    for (const template of SCHEDULE_TEMPLATES) {
      expect(template.offsetDays, template.code).toBeLessThanOrEqual(30);
      expect(template.offsetDays, template.code).toBeGreaterThanOrEqual(-360);
    }
  });

  it("**예식 뒤에 오는 일이 실재한다** — 양수 오프셋이 목록에 있다 (C-4a)", () => {
    const post = SCHEDULE_TEMPLATES.filter((template) => template.offsetDays > 0);

    // 분모를 먼저 본다 — 0건이면 아래 검사가 전부 조용히 통과한다.
    expect(post.length).toBeGreaterThan(0);
    expect(post.map((template) => template.code).sort()).toEqual([
      "T-doc-marriage-file",
      "T-family-settlement",
      "T-gift-thanks",
    ]);
  });

  it("**요구받은 넷이 전부 목록에 있다** (B-1 조사 4-2)", () => {
    const titles = SCHEDULE_TEMPLATES.map((template) => template.title).join(" ");

    for (const word of ["답례품", "상견례", "예복", "축의금"]) {
      expect(titles, word).toContain(word);
    }
  });

  it("**서류 '확인' 과 '제출' 이 다른 항목이다** — 확인만 있고 제출이 없었다", () => {
    const check = SCHEDULE_TEMPLATES.find((t) => t.code === "T-doc-marriage");
    const file = SCHEDULE_TEMPLATES.find((t) => t.code === "T-doc-marriage-file");

    expect(check?.offsetDays).toBeLessThan(0);
    expect(file?.offsetDays).toBeGreaterThan(0);
    expect(file?.dependsOn).toContain("T-doc-marriage");
  });

  it("판본이 붙어 있다 — 시드가 어긋나면 db:rls 가 알린다", () => {
    expect(SCHEDULE_TEMPLATES_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });
});

describe("결함 검사기 자체", () => {
  const base = { category: "hall" as const, offsetDays: -100 };

  it("없는 코드를 가리키는 선행을 잡는다", () => {
    const defects = templateDefects([
      { code: "A", title: "A", dependsOn: ["없음"], ...base },
    ]);

    expect(defects[0]).toEqual({ kind: "unknown_dependency", code: "A", dependsOn: "없음" });
  });

  it("자기 자신을 가리키는 선행을 잡는다", () => {
    expect(templateDefects([{ code: "A", title: "A", dependsOn: ["A"], ...base }])[0]).toEqual({
      kind: "self_dependency",
      code: "A",
    });
  });

  it("**순환을 잡는다** — 시드가 순환을 담으면 모든 커플에 복제된다", () => {
    const defects = templateDefects([
      { code: "A", title: "A", dependsOn: ["B"], ...base },
      { code: "B", title: "B", dependsOn: ["A"], ...base },
    ]);

    expect(defects.some((defect) => defect.kind === "cycle")).toBe(true);
  });

  it("**선행이 나보다 늦게 시작하면 잡는다** — 순환은 아니지만 뒤집힌 순서다", () => {
    const defects = templateDefects([
      { code: "A", title: "A", dependsOn: [], category: "hall", offsetDays: -10 },
      { code: "B", title: "B", dependsOn: ["A"], category: "hall", offsetDays: -100 },
    ]);

    expect(defects[0]).toEqual({ kind: "offset_inversion", code: "B", dependsOn: "A" });
  });
});

describe("간선", () => {
  it("선행이 있는 템플릿마다 간선이 나온다", () => {
    const edges = templateEdges();
    const expected = SCHEDULE_TEMPLATES.reduce(
      (sum, template) => sum + template.dependsOn.length,
      0,
    );

    expect(edges).toHaveLength(expected);
  });

  it("**위상 정렬이 성립한다** — 목록 전체가 하나의 순서로 펴진다", () => {
    const tasks = SCHEDULE_TEMPLATES.map((template) => ({
      id: template.code,
      title: template.title,
      category: template.category,
      status: "todo" as const,
      dueDate: null,
      templateCode: template.code,
      completedOutOfOrder: false,
      vendorCategory: null,
    }));

    const edges = templateEdges().map((edge) => ({
      taskId: edge.templateCode,
      dependsOn: edge.dependsOnCode,
    }));

    const result = topoSort(tasks, edges);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.order).toHaveLength(SCHEDULE_TEMPLATES.length);
  });

  it("웨딩홀 계약이 스드메 계약보다 먼저다 — 날짜가 정해져야 일정을 잡는다", () => {
    const tasks = SCHEDULE_TEMPLATES.map((template) => ({
      id: template.code,
      title: template.title,
      category: template.category,
      status: "todo" as const,
      dueDate: null,
      templateCode: template.code,
      completedOutOfOrder: false,
      vendorCategory: null,
    }));

    const result = topoSort(
      tasks,
      templateEdges().map((edge) => ({ taskId: edge.templateCode, dependsOn: edge.dependsOnCode })),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order.indexOf("T-hall-contract")).toBeLessThan(
        result.order.indexOf("T-sdm-contract"),
      );
    }
  });
});

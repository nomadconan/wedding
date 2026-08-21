import { describe, expect, it } from "vitest";

import {
  EMPTY_GUIDANCE,
  EMPTY_REASONS,
  UNAVAILABLE_GUIDANCE,
  emptyResult,
  okResult,
  summarizeResult,
  unavailableResult,
} from "./empty";
import { PLANNER_PROMPT_VERSION, buildPlannerSystemPrompt } from "./prompt";
import { TOOL_INPUTS, hasToolSchema, parseToolArgs } from "./tool-schemas";
import {
  IRREVERSIBLE_ACTIONS,
  TOOL_SPECS,
  registrableTools,
  suggestScreen,
  toolGaps,
  toolSpec,
} from "./tools";

const always = () => true;
const never = () => false;

describe("툴 목록 — §5.6 표와 코드가 같은 것을 말한다", () => {
  it("16종이 있고 이름이 겹치지 않는다", () => {
    expect(TOOL_SPECS).toHaveLength(16);
    expect(new Set(TOOL_SPECS.map((spec) => spec.name)).size).toBe(16);
  });

  // S7-19 가 `get_task_graph` 를 열어 11/5 → **12/4** 가 됐다. 07 §5.6 표도 함께 고쳤다
  // (FIX-20 이 남긴 교훈 — 표와 요약이 어긋나면 어느 쪽이 진실인지 알 수 없다).
  it("가용 12 · 대기 4 다 (§5.6 표 기준)", () => {
    expect(TOOL_SPECS.filter((spec) => spec.status === "available")).toHaveLength(12);
    expect(TOOL_SPECS.filter((spec) => spec.status === "pending")).toHaveLength(4);
  });

  it("대기 툴에는 담당 태스크가 적혀 있다 — 언제 열리는지 모르는 대기는 방치다", () => {
    for (const spec of TOOL_SPECS.filter((item) => item.status === "pending")) {
      expect(spec.filledBy).toMatch(/^S\d-\d\d$/);
    }
  });

  it("가용 툴에는 근거 구현이 적혀 있다 — 툴이 계산을 새로 만들지 않는다", () => {
    for (const spec of TOOL_SPECS.filter((item) => item.status === "available")) {
      expect(spec.backing).not.toBe("—");
      expect(spec.filledBy).toBeNull();
    }
  });

  it("쓰기 툴은 둘뿐이고 둘 다 사용자 확인을 거친다", () => {
    const writes = TOOL_SPECS.filter((spec) => spec.mode === "write");

    expect(writes.map((spec) => spec.name)).toEqual(["create_tasks", "update_budget_allocation"]);
    expect(writes.every((spec) => spec.requiresConfirmation)).toBe(true);
  });

  it("읽기 툴은 확인을 요구하지 않는다 — 되돌릴 것이 없다", () => {
    for (const spec of TOOL_SPECS.filter((item) => item.mode === "read")) {
      expect(spec.requiresConfirmation).toBe(false);
    }
  });

  it("이름으로 찾는다", () => {
    expect(toolSpec("search_vendors")?.mode).toBe("read");
    expect(toolSpec("없는_툴")).toBeNull();
  });
});

describe("등록 조건 — 없는 툴을 등록하지 않는다", () => {
  it("스키마와 핸들러가 모두 있어야 등록된다", () => {
    const registered = registrableTools({ hasSchema: always, hasHandler: always });

    expect(registered).toHaveLength(12);
    expect(registered.every((spec) => spec.status === "available")).toBe(true);
  });

  it("핸들러가 없으면 등록되지 않는다 — 등록해 두면 모델이 부르고 대화에 실패가 남는다", () => {
    expect(registrableTools({ hasSchema: always, hasHandler: never })).toHaveLength(0);
  });

  it("스키마만 있어도 등록되지 않는다", () => {
    expect(
      registrableTools({
        hasSchema: (name) => name === "search_vendors",
        hasHandler: never,
      }),
    ).toHaveLength(0);
  });

  it("대기 툴은 스키마·핸들러가 생겨도 상태가 available 이 되기 전에는 안 열린다", () => {
    const registered = registrableTools({ hasSchema: always, hasHandler: always });

    expect(registered.map((spec) => spec.name)).not.toContain("create_tasks");
  });

  it("빠진 이유를 사유별로 돌려준다", () => {
    const gaps = toolGaps({
      hasSchema: (name) => name !== "list_coupons",
      hasHandler: (name) => name !== "compare_carts",
    });

    expect(gaps.find((gap) => gap.name === "list_coupons")?.reason).toBe("schema_missing");
    expect(gaps.find((gap) => gap.name === "compare_carts")?.reason).toBe("handler_missing");
    expect(gaps.find((gap) => gap.name === "get_checklist")?.reason).toBe("pending");
    expect(gaps.find((gap) => gap.name === "get_checklist")?.filledBy).toBe("S7-08");
  });
});

describe("입력 스키마 — zod 와 JSON Schema 가 어긋나지 않는다", () => {
  it("가용 툴 전부에 입력 정의가 있다", () => {
    for (const spec of TOOL_SPECS.filter((item) => item.status === "available")) {
      expect(hasToolSchema(spec.name)).toBe(true);
    }
  });

  it("대기 툴에는 입력 정의를 만들지 않았다", () => {
    for (const spec of TOOL_SPECS.filter((item) => item.status === "pending")) {
      expect(hasToolSchema(spec.name)).toBe(false);
    }
  });

  it("JSON Schema 의 required 는 properties 안에 있다", () => {
    for (const [name, definition] of Object.entries(TOOL_INPUTS)) {
      for (const key of definition.jsonSchema.required) {
        expect(Object.keys(definition.jsonSchema.properties), name).toContain(key);
      }
    }
  });

  it("커플 id 를 인자로 받는 툴이 없다 — 스코프는 세션이 정한다", () => {
    for (const definition of Object.values(TOOL_INPUTS)) {
      const keys = Object.keys(definition.jsonSchema.properties);

      expect(keys).not.toContain("coupleId");
      expect(keys).not.toContain("userId");
    }
  });

  it("모델이 필수 인자를 빼면 거절한다", () => {
    const result = parseToolArgs("search_price_index", { region: "강남" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("category");
  });

  it("모르는 열거값을 거절한다", () => {
    expect(parseToolArgs("search_price_index", { region: "강남", category: "spaceship" }).ok).toBe(
      false,
    );
  });

  it("모르는 필드를 조용히 통과시키지 않는다", () => {
    expect(parseToolArgs("get_cart_summary", { coupleId: "남의-커플-id" }).ok).toBe(false);
  });

  it("등록되지 않은 툴 이름을 거절한다", () => {
    expect(parseToolArgs("charge_card", {}).ok).toBe(false);
  });

  it("정상 인자는 통과한다", () => {
    const result = parseToolArgs("search_vendors", { query: "강남 300인", guestCount: 300 });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.args.guestCount).toBe(300);
  });

  it("위약금 툴은 기존 입력 스키마를 그대로 쓴다 — 두 번째 정의를 만들지 않는다", () => {
    const ok = parseToolArgs("simulate_penalty", {
      category: "hall",
      totalAmount: 10_000_000,
      depositAmount: 1_000_000,
      eventDate: "2027-03-14",
      cancelDate: "2026-12-01",
      contractTerm: { kind: "rate", rateBp: 3_000 },
    });

    expect(ok.ok).toBe(true);
    // 금액은 정수여야 한다(bp·원 단위 정수 규약).
    expect(
      parseToolArgs("simulate_penalty", {
        category: "hall",
        totalAmount: 10_000_000.5,
        depositAmount: 1_000_000,
        eventDate: "2027-03-14",
        cancelDate: "2026-12-01",
        contractTerm: { kind: "none" },
      }).ok,
    ).toBe(false);
  });
});

describe("되돌릴 수 없는 행위 — 툴이 아니라 화면 안내다", () => {
  it("일곱 가지가 목록에 있다", () => {
    expect(IRREVERSIBLE_ACTIONS.map((action) => action.code)).toEqual([
      "payment",
      "contract_sign",
      "booking_confirm",
      "contract_cancel",
      "coupon_redeem",
      "escrow_release",
      "settlement_payout",
    ]);
  });

  it("그 어느 것도 툴로 등록돼 있지 않다", () => {
    // 실행 동사로 시작하는 툴이 없다. `preview_payment_schedule` 처럼 **미리 보기**는
    // 되돌릴 것이 없으므로 이름 안에 payment 가 들어 있어도 무관하다 — 막는 것은
    // '무엇을 실행하는가' 이지 낱말이 아니다.
    const forbidden = /^(pay|charge|sign|confirm|cancel|redeem|release|payout|settle)_/;

    for (const spec of TOOL_SPECS) {
      expect(spec.name, spec.name).not.toMatch(forbidden);
    }
  });

  it("화면이 아직 없으면 링크를 만들지 않고 담당 태스크를 말한다", () => {
    const suggestion = suggestScreen("payment");

    expect(suggestion?.kind).toBe("not_ready");
    if (suggestion?.kind === "not_ready") {
      expect(suggestion.filledBy).toBe("S5-06");
      expect(suggestion.notice).toContain("준비 중");
    }
  });

  it("모르는 행위 코드에는 안내를 만들지 않는다", () => {
    expect(suggestScreen("teleport")).toBeNull();
  });
});

describe("빈 결과 — 지어낼 자리를 문장 단위로 없앤다", () => {
  it("사유 코드 4종에 모두 문장과 다음 행동이 있다", () => {
    for (const reason of EMPTY_REASONS) {
      expect(EMPTY_GUIDANCE[reason].say.length).toBeGreaterThan(0);
      expect(EMPTY_GUIDANCE[reason].nextAction.length).toBeGreaterThan(0);
    }
  });

  it("빈 결과 문장에 숫자가 들어 있지 않다 — 문장 자체가 시세를 말하면 안 된다", () => {
    for (const reason of EMPTY_REASONS) {
      expect(EMPTY_GUIDANCE[reason].say).not.toMatch(/\d/);
    }
  });

  it("'아직 세지 않는다'는 0이 아니다", () => {
    expect(EMPTY_GUIDANCE.not_counted_yet.say).toContain("아직");
    expect(EMPTY_GUIDANCE.not_counted_yet.say).not.toContain("0");
  });

  it("쓸 수 없는 상태는 빈 결과와 다른 코드다", () => {
    const result = unavailableResult("setting_missing", "O-02");

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.say).toBe(UNAVAILABLE_GUIDANCE.setting_missing);
      expect(result.filledBy).toBe("O-02");
    }
  });

  it("감사 요약에 상태와 개수만 남는다 — 이름·금액을 남기지 않는다", () => {
    expect(summarizeResult(okResult({ vendors: ["로컬 데모 웨딩홀"] }), 1)).toBe("ok:1");
    expect(summarizeResult(emptyResult("no_match"))).toBe("empty:no_match");
    expect(summarizeResult(unavailableResult("no_couple"))).toBe("unavailable:no_couple");
  });
});

describe("시스템 프롬프트 — 후처리가 검사할 형태를 요구한다", () => {
  const prompt = buildPlannerSystemPrompt(
    registrableTools({ hasSchema: always, hasHandler: always }),
  );

  it("판본이 붙어 있다", () => {
    expect(PLANNER_PROMPT_VERSION).toBe("planner@1");
  });

  it("숫자는 아라비아 숫자로, 이름은 작은따옴표로 적게 한다", () => {
    expect(prompt).toContain("아라비아 숫자");
    expect(prompt).toContain("작은따옴표");
  });

  it("산술 금지와 사전 지식 금지를 못 박는다", () => {
    expect(prompt).toContain("산술을 하지 않는다");
    expect(prompt).toContain("사전 지식");
  });

  it("등록된 툴만 프롬프트에 적힌다", () => {
    expect(prompt).toContain("search_vendors");
    expect(prompt).not.toContain("create_tasks");
  });

  it("되돌릴 수 없는 행위와 법률 판단 금지를 적는다", () => {
    expect(prompt).toContain("전자서명");
    expect(prompt).toContain("전문가 상담");
  });

  it("법적 고지가 붙는다 (CLAUDE.md §2.3)", () => {
    expect(prompt).toContain("법률 자문");
  });
});

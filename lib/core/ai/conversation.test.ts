import { describe, expect, it } from "vitest";

import { emptyResult, okResult, unavailableResult } from "./empty";
import {
  CONVERSATION_TITLE_MAX_LENGTH,
  FALLBACK_GUIDE_REPLY,
  FALLBACK_SEARCH_REPLY,
  conversationTitle,
  detectIrreversibleRequest,
  messageProblem,
  planWithoutModel,
  toolCard,
} from "./conversation";
import { PLANNER_EVENTS, PlannerTurnSchema } from "../schemas/planner-chat";
import { createSentenceGate, takeSentences } from "./stream";

describe("메시지 입력", () => {
  it("빈 입력을 막는다", () => {
    expect(messageProblem("   ")).not.toBeNull();
  });

  it("상한을 넘으면 막는다", () => {
    expect(messageProblem("가".repeat(1_001))).not.toBeNull();
    expect(messageProblem("가".repeat(1_000))).toBeNull();
  });

  it("스키마가 같은 상한을 쓴다 — 화면과 서버가 갈리지 않는다", () => {
    expect(PlannerTurnSchema.safeParse({ message: "가".repeat(1_001) }).success).toBe(false);
    expect(PlannerTurnSchema.safeParse({ message: "안녕" }).success).toBe(true);
  });

  it("모르는 필드를 통과시키지 않는다", () => {
    expect(PlannerTurnSchema.safeParse({ message: "안녕", coupleId: "x" }).success).toBe(false);
  });
});

describe("대화 제목 — 요약하지 않는다", () => {
  it("짧으면 그대로 쓴다", () => {
    expect(conversationTitle("강남 웨딩홀 알려줘")).toBe("강남 웨딩홀 알려줘");
  });

  it("길면 자르고 잘렸다는 것을 보인다", () => {
    const title = conversationTitle("가".repeat(60));

    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBe(CONVERSATION_TITLE_MAX_LENGTH + 1);
  });

  it("빈 입력이면 기본 제목", () => {
    expect(conversationTitle("  ")).toBe("새 대화");
  });
});

describe("툴 결과 카드 — 문장을 모델이 쓰지 않는다", () => {
  it("업체 목록을 이름·금액 줄로 만든다", () => {
    const card = toolCard(
      "search_vendors",
      okResult({
        rows: [{ vendorName: "로컬 데모 웨딩홀", productName: "본식", basePrice: 12_000_000 }],
      }),
      [{ code: "condition_fit", label: "조건 부합도" }],
    );

    expect(card.title).toBe("조건에 맞는 업체");
    expect(card.rows[0].value).toBe("12,000,000원");
    expect(card.rankingCode).toBe("condition_fit");
  });

  it("빈 결과는 사유 문장과 다음 행동을 함께 담는다", () => {
    const card = toolCard("search_vendors", emptyResult("no_match"));

    expect(card.status).toBe("empty");
    expect(card.notice).toContain("조건에 맞는 것이 없어요");
    expect(card.nextAction).not.toBeNull();
    expect(card.rows).toEqual([]);
  });

  it("표본 부족은 분포를 카드에 그리지 않는다", () => {
    const card = toolCard("search_price_index", emptyResult("not_enough_sample", { sampleSize: 2 }));

    expect(card.rows).toEqual([]);
    expect(card.notice).toContain("표본");
  });

  it("쓸 수 없는 상태는 사유만 적고 기준 코드를 달지 않는다", () => {
    const card = toolCard("preview_payment_schedule", unavailableResult("setting_missing"), [
      { code: "condition_fit", label: "조건 부합도" },
    ]);

    expect(card.status).toBe("unavailable");
    expect(card.rankingCode).toBeNull();
    expect(card.notice).toContain("운영 기준");
  });

  it("예식일 미정을 0일로 그리지 않는다", () => {
    const card = toolCard(
      "get_couple_context",
      okResult({ dDay: { kind: "undecided" }, budgetDecided: false, partnerLinked: false }),
    );

    expect(card.rows[0].value).toBe("아직 정하지 않았어요");
    expect(card.rows[2].value).toBe("아직 정하지 않았어요");
  });

  it("못 쓰는 쿠폰의 사유를 감추지 않는다 (F-C-36)", () => {
    const card = toolCard(
      "list_coupons",
      okResult({
        coupons: [{ name: "첫 계약 쿠폰", usable: false, blockDetail: "3,000,000원 이상 결제에 쓸 수 있어요." }],
      }),
    );

    expect(card.rows[0].value).toContain("3,000,000원 이상");
  });
});

describe("되돌릴 수 없는 요청 — 툴이 아니라 안내다", () => {
  it("결제 지시를 알아채고 화면 안내를 돌려준다", () => {
    const detected = detectIrreversibleRequest("이걸로 결제해 줘");

    expect(detected?.code).toBe("payment");
    // 화면이 아직 없다 — **링크를 만들지 않는다**(S7-20 · D-47).
    expect(detected?.route).toBeNull();
    expect(detected?.notice).toContain("준비 중");
  });

  it("서명·해지도 알아챈다", () => {
    expect(detectIrreversibleRequest("계약서에 서명해 줘")?.code).toBe("contract_sign");
    expect(detectIrreversibleRequest("이 계약 취소해 줘")?.code).toBe("contract_cancel");
  });

  it("질문은 막지 않는다 — 넓게 잡으면 대화가 못 쓰게 된다", () => {
    expect(detectIrreversibleRequest("결제는 어떻게 하나요?")).toBeNull();
    expect(detectIrreversibleRequest("계약 취소하면 위약금이 얼마인가요?")).toBeNull();
  });
});

describe("모델 없이 답하는 길 (D-28 계열)", () => {
  it("조건이 읽히면 조회로 간다", () => {
    const plan = planWithoutModel({ text: "강남 300인 웨딩홀", fields: ["region", "guestCount"] });

    expect(plan.kind).toBe("search");
    if (plan.kind === "search") expect(plan.query).toBe("강남 300인 웨딩홀");
  });

  it("조건을 못 읽으면 안내로 간다", () => {
    expect(planWithoutModel({ text: "안녕", fields: [] }).kind).toBe("guide");
  });

  it("고정 문구에 수치가 없다 — 지어낼 자리를 만들지 않는다", () => {
    expect(FALLBACK_SEARCH_REPLY).not.toMatch(/\d/);
    expect(FALLBACK_GUIDE_REPLY).toMatch(/3월 14일/); // 예시 문장은 사용자에게 형식을 보여 준다
  });
});

describe("SSE 이벤트 목록", () => {
  it("화면과 서버가 같은 이름을 쓴다", () => {
    expect([...PLANNER_EVENTS]).toEqual(["meta", "delta", "card", "discard", "error", "done"]);
  });
});

// =============================================================================
// 문장 게이트
// =============================================================================

const toolResults = [
  { rows: [{ vendorName: "로컬 데모 웨딩홀", basePrice: 12_000_000 }], ranking: { code: "condition_fit" } },
];

describe("문장 자르기", () => {
  it("완성된 문장만 잘라 내고 꼬리는 남긴다", () => {
    const { sentences, rest } = takeSentences("첫 문장이에요. 두 번째는 아직");

    expect(sentences).toEqual(["첫 문장이에요."]);
    expect(rest).toBe(" 두 번째는 아직");
  });

  it("소수점을 문장 끝으로 보지 않는다 — 수치 토큰이 갈라지면 대조가 깨진다", () => {
    const { sentences, rest } = takeSentences("12.5% 입니다");

    expect(sentences).toEqual([]);
    expect(rest).toBe("12.5% 입니다");
  });

  it("줄바꿈도 문장 끝이다", () => {
    expect(takeSentences("한 줄\n").sentences).toEqual(["한 줄\n"]);
  });
});

describe("문장 게이트 — 검사되지 않은 문장을 내보내지 않는다", () => {
  it("통과한 문장만 흘려보낸다", () => {
    const gate = createSentenceGate({ toolResults });

    expect(gate.push("찾아봤어요")).toEqual([]);
    expect(gate.push(". ")).toEqual([{ kind: "emit", text: "찾아봤어요." }]);
  });

  it("툴 결과에 없는 금액이 나오면 그 문장에서 끊는다", () => {
    const gate = createSentenceGate({ toolResults });

    gate.push("먼저 정리해 드릴게요. ");
    const events = gate.push("보통 스드메는 3000000원쯤 해요. ");

    expect(events[0].kind).toBe("violation");
    // 끊긴 뒤에는 아무것도 더 내보내지 않는다.
    expect(gate.push("그리고 또 있어요. ")).toEqual([]);
  });

  it("끊긴 문장은 통과분에 들어가지 않는다 — 부분 결과를 남기지 않는다", () => {
    const gate = createSentenceGate({ toolResults });

    gate.push("정리해 드릴게요. ");
    gate.push("3000000원쯤 해요. ");

    expect(gate.emitted()).toBe("정리해 드릴게요.");
  });

  it("마지막 꼬리도 finish 에서 검사한다", () => {
    const gate = createSentenceGate({ toolResults });

    gate.push("끝맺음 없이 끝나요");

    expect(gate.finish()).toEqual([{ kind: "emit", text: "끝맺음 없이 끝나요" }]);
  });

  it("**기준 코드는 전체 본문에서 본다** — 첫 문장에서 반려하면 정상 응답이 막힌다", () => {
    const gate = createSentenceGate({
      toolResults,
      rankingBasis: [{ code: "condition_fit", label: "조건 부합도" }],
    });

    // 이름을 부르는 문장이 먼저 나가도 막히지 않는다.
    expect(gate.push("'로컬 데모 웨딩홀'이 있어요. ")[0].kind).toBe("emit");
    // 끝까지 기준을 안 밝히면 그때 폐기한다.
    expect(gate.finish()[0].kind).toBe("discard");
  });

  it("기준 코드를 밝히면 폐기하지 않는다", () => {
    const gate = createSentenceGate({
      toolResults,
      rankingBasis: [{ code: "condition_fit", label: "조건 부합도" }],
    });

    gate.push("'로컬 데모 웨딩홀'이 있어요. ");
    gate.push("조건 부합도 순으로 보여드렸어요. ");

    expect(gate.finish()).toEqual([]);
  });

  it("사용자가 말한 숫자를 되읽는 문장은 통과한다", () => {
    const gate = createSentenceGate({ toolResults, userText: "하객 300명이에요" });

    expect(gate.push("300명 기준으로 볼게요. ")[0].kind).toBe("emit");
  });
});

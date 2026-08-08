import { describe, expect, it } from "vitest";

import { html, readSource, text } from "../test-render";
import {
  AMOUNT_UNKNOWN,
  PLANNER_NOT_SELECTED_TEXT,
  PLANNER_UNAVAILABLE_TEXT,
  PriceDisplay,
  UNKNOWN_AMOUNT_TEXT,
  formatAmountText,
  formatKrw,
  isUnknownAmount,
} from "./PriceDisplay";

/** 매 테스트에서 반복되는 필수 prop. */
const base = {
  amount: 12500000,
  basePrice: 12000000,
  taxIncluded: true,
} as const;

/**
 * 내역 한 줄만 떼어 텍스트로 본다.
 * 전체 문자열에서 "0원"을 찾으면 "12,000,000원"에도 걸리므로 행 단위로 좁힌다.
 */
function rowText(markup: string, testId: string): string {
  const start = markup.indexOf(`data-testid="${testId}"`);
  const end = markup.indexOf("</div>", start);

  return markup
    .slice(start, end)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("금액 포매팅", () => {
  it("천 단위로 끊고 소수를 버린다", () => {
    expect(formatKrw(0)).toBe("0");
    expect(formatKrw(1000)).toBe("1,000");
    expect(formatKrw(12500000)).toBe("12,500,000");
    expect(formatKrw(1234.9)).toBe("1,234");
    expect(formatKrw(-2500)).toBe("-2,500");
  });

  it("0원과 미정은 다른 문자열이다", () => {
    expect(formatAmountText(0)).toBe("0원");
    expect(formatAmountText(AMOUNT_UNKNOWN)).toBe(UNKNOWN_AMOUNT_TEXT);
    expect(formatAmountText(0)).not.toBe(formatAmountText(AMOUNT_UNKNOWN));
  });

  it("미정 판정은 sentinel 에만 반응한다 — 0 은 확정된 값이다", () => {
    expect(isUnknownAmount(AMOUNT_UNKNOWN)).toBe(true);
    expect(isUnknownAmount(0)).toBe(false);
  });
});

describe("PriceDisplay — 플래너 행 (D-17)", () => {
  it("플래너 미선택이어도 플래너 행을 렌더한다", () => {
    const markup = html(
      <PriceDisplay {...base} addOns={{ kind: "none" }} plannerFee={{ kind: "not_selected" }} />,
    );

    // 행이 존재해야 한다. 숨기면 고객이 항목의 존재 자체를 모르게 된다.
    expect(markup).toContain('data-testid="price-row-planner"');
    expect(markup).toContain('data-state="not_selected"');
    expect(text(<PriceDisplay {...base} addOns={{ kind: "none" }} plannerFee={{ kind: "not_selected" }} />)).toContain(
      "플래너 수수료",
    );
  });

  it("미선택은 '0원'도 '미정'도 아닌 '선택 안 함'으로 적는다", () => {
    const rendered = text(
      <PriceDisplay {...base} addOns={{ kind: "none" }} plannerFee={{ kind: "not_selected" }} />,
    );

    expect(rendered).toContain(PLANNER_NOT_SELECTED_TEXT);
    expect(PLANNER_NOT_SELECTED_TEXT).not.toBe("0원");
    expect(PLANNER_NOT_SELECTED_TEXT).not.toBe(UNKNOWN_AMOUNT_TEXT);
  });

  it("선택 불가 항목은 '선택 안 함'과 다르게 적는다", () => {
    const rendered = text(
      <PriceDisplay {...base} addOns={{ kind: "none" }} plannerFee={{ kind: "unavailable" }} />,
    );

    expect(rendered).toContain(PLANNER_UNAVAILABLE_TEXT);
    expect(rendered).not.toContain(PLANNER_NOT_SELECTED_TEXT);
  });

  it("선택 시 계산된 금액을 그대로 표시한다", () => {
    const rendered = text(
      <PriceDisplay
        {...base}
        addOns={{ kind: "none" }}
        plannerFee={{ kind: "selected", amount: 840000 }}
      />,
    );

    expect(rendered).toContain("840,000원");
  });

  it("선택했는데 금액이 아직 없으면 미정으로 적는다", () => {
    const rendered = text(
      <PriceDisplay
        {...base}
        addOns={{ kind: "none" }}
        plannerFee={{ kind: "selected", amount: AMOUNT_UNKNOWN }}
      />,
    );

    expect(rendered).toContain(UNKNOWN_AMOUNT_TEXT);
  });

  it("어떤 플래너 상태에서도 행 하나는 반드시 남는다", () => {
    const states = [
      { kind: "not_selected" },
      { kind: "unavailable" },
      { kind: "selected", amount: 0 },
      { kind: "selected", amount: AMOUNT_UNKNOWN },
    ] as const;

    for (const plannerFee of states) {
      const markup = html(
        <PriceDisplay {...base} addOns={{ kind: "none" }} plannerFee={plannerFee} />,
      );
      expect(markup.split('data-testid="price-row-planner"').length - 1).toBe(1);
    }
  });
});

describe("PriceDisplay — 0원과 미정 (S1-02)", () => {
  it("추가금 없음은 0원, 미등록은 미정이다", () => {
    const none = rowText(
      html(<PriceDisplay {...base} addOns={{ kind: "none" }} plannerFee={{ kind: "not_selected" }} />),
      "price-row-addons",
    );
    const unknown = rowText(
      html(
        <PriceDisplay {...base} addOns={{ kind: "unknown" }} plannerFee={{ kind: "not_selected" }} />,
      ),
      "price-row-addons",
    );

    expect(none).toContain("0원");
    expect(none).toContain("추가금 없음");
    expect(none).not.toContain(UNKNOWN_AMOUNT_TEXT);

    expect(unknown).toContain(UNKNOWN_AMOUNT_TEXT);
    expect(unknown).toContain("추가금 미등록");
    expect(unknown).not.toContain("0원");

    // 같은 행이 두 상태에서 다른 문자열이어야 한다 — 이것이 규칙의 핵심이다.
    expect(none).not.toBe(unknown);
  });

  it("사전 등록 추가금은 최댓값이 있으면 금액, 없으면 미정이다", () => {
    const withTotal = text(
      <PriceDisplay
        {...base}
        addOns={{ kind: "listed", count: 3, total: 720000 }}
        plannerFee={{ kind: "not_selected" }}
      />,
    );
    const withoutTotal = text(
      <PriceDisplay
        {...base}
        addOns={{ kind: "listed", count: 3 }}
        plannerFee={{ kind: "not_selected" }}
      />,
    );

    expect(withTotal).toContain("최대 720,000원");
    expect(withTotal).toContain("사전 등록 3건");
    expect(withoutTotal).toContain(UNKNOWN_AMOUNT_TEXT);
  });

  it("총액 0원과 총액 미정을 구분해 렌더한다", () => {
    const zero = html(
      <PriceDisplay
        {...base}
        amount={0}
        basePrice={0}
        addOns={{ kind: "none" }}
        plannerFee={{ kind: "not_selected" }}
      />,
    );
    const unknown = html(
      <PriceDisplay
        {...base}
        amount={AMOUNT_UNKNOWN}
        basePrice={AMOUNT_UNKNOWN}
        addOns={{ kind: "unknown" }}
        plannerFee={{ kind: "not_selected" }}
      />,
    );

    expect(zero).toContain('data-testid="price-total" data-state="known"');
    expect(zero).toContain('aria-label="0원"');

    expect(unknown).toContain('data-state="unknown"');
    expect(unknown).not.toContain('aria-label="0원"');
  });
});

describe("PriceDisplay — 표시 구조 (§6 공통 UI 규칙)", () => {
  const markup = html(
    <PriceDisplay
      {...base}
      addOns={{ kind: "listed", count: 2, total: 300000 }}
      plannerFee={{ kind: "selected", amount: 600000 }}
    />,
  );

  it("총액 → 내역 → 부가세 순으로 놓인다", () => {
    const order = ["price-total", "price-row-base", "price-row-addons", "price-row-planner", "price-tax"].map(
      (id) => markup.indexOf(`data-testid="${id}"`),
    );

    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("총액이 내역보다 큰 스케일이다", () => {
    expect(markup).toContain("text-amount");
    // 내역은 단위 스케일(text-unit)로만 적는다 — 총액과 경쟁하지 않는다.
    expect(markup).toContain("text-unit");
  });

  it("부가세 포함 여부를 같은 블록에서 밝힌다", () => {
    expect(text(
      <PriceDisplay {...base} addOns={{ kind: "none" }} plannerFee={{ kind: "not_selected" }} />,
    )).toContain("부가세 포함");

    expect(text(
      <PriceDisplay
        {...base}
        taxIncluded={false}
        addOns={{ kind: "none" }}
        plannerFee={{ kind: "not_selected" }}
      />,
    )).toContain("부가세 별도");
  });
});

describe("PriceDisplay — 변형 (단품 / 합계)", () => {
  it("단품이 기본이며 합계는 명시해야 한다", () => {
    const item = html(
      <PriceDisplay {...base} addOns={{ kind: "none" }} plannerFee={{ kind: "not_selected" }} />,
    );

    expect(item).toContain('data-variant="item"');
    expect(text(
      <PriceDisplay {...base} addOns={{ kind: "none" }} plannerFee={{ kind: "not_selected" }} />,
    )).toContain("판매가");
  });

  it("합계 변형은 합계임을 라벨로 밝히고 항목 수를 함께 적는다", () => {
    const rendered = text(
      <PriceDisplay
        {...base}
        variant="sum"
        itemCount={4}
        addOns={{ kind: "listed", count: 5, total: 500000 }}
        plannerFee={{ kind: "selected", amount: 900000, categoryCount: 2 }}
      />,
    );

    expect(rendered).toContain("총 예상 금액");
    expect(rendered).toContain("4개 항목");
    expect(rendered).toContain("판매가 합계");
    expect(rendered).toContain("추가금 합계");
    expect(rendered).toContain("플래너 수수료 합계");
    // 카테고리별 부분 선택(D-17)이 합계 화면에서 읽혀야 한다.
    expect(rendered).toContain("2개 카테고리 선택");
  });

  it("합계에서 플래너를 하나도 안 골라도 행은 남는다", () => {
    const rendered = text(
      <PriceDisplay
        {...base}
        variant="sum"
        addOns={{ kind: "none" }}
        plannerFee={{ kind: "not_selected" }}
      />,
    );

    expect(rendered).toContain("플래너 수수료 합계");
    expect(rendered).toContain(PLANNER_NOT_SELECTED_TEXT);
  });
});

describe("PriceDisplay — 요율 하드코딩 금지 (D-16·D-17, O-02)", () => {
  const source = readSource(new URL("./PriceDisplay.tsx", import.meta.url).href);

  it("요율 숫자나 퍼센트 리터럴이 소스에 없다", () => {
    // 요율은 업체별·카테고리별 차등이고 계약 시점 스냅샷이다. 화면이 알 값이 아니다.
    expect(source).not.toMatch(/\d+(\.\d+)?\s*%/);
    expect(source).not.toMatch(/_bp\b/);
    expect(source).not.toMatch(/rate/i);
  });
});

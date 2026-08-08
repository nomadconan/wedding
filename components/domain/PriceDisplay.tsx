import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * 가격 표시 v2 (S1-02 · 구 T-04b)
 *
 * 명세서 §6 공통 UI 규칙:
 *   "총액을 화면에서 가장 크게 표시하고, **추가금·플래너 수수료 포함 여부를 같은 블록에서**
 *    확인할 수 있게 한다. 사용자가 스크롤해야 추가금을 발견하는 구조는 규칙 위반이다."
 *
 * 이 규칙을 문서가 아니라 **타입으로** 강제한다. 아래 넷은 전부 필수 prop이다.
 *  - `basePrice`  총액만 있고 판매가가 없으면 총액이 어떻게 나왔는지 검증할 수 없다.
 *  - `addOns`     추가금이 없으면 `{ kind: "none" }` 을 명시해야 한다.
 *                 "몰라서 안 적었다"(`unknown`)와 "없어서 안 적었다"(`none`)는 다른 정보다.
 *  - `plannerFee` 플래너를 안 골랐어도 **행을 숨기지 않는다**(D-17). 숨기면 고객이 그 항목의
 *                 존재 자체를 모르게 되어 가격 투명성 원칙에 어긋난다.
 *  - `taxIncluded` 부가세 여부를 밝히지 않고는 렌더할 수 없다.
 *
 * 표시 순서는 **총액(가장 큼) → 내역(판매가 / 추가금 / 플래너 수수료) → 부가세 포함 여부**다.
 *
 * **요율 숫자는 이 컴포넌트에 없다.** 요율은 업체별·카테고리별 차등이고 계약 시점 스냅샷으로
 * 박히는 값이라(§3.4, D-16·D-17) 화면이 알 필요가 없다. 계산된 **금액**과 선택 **상태**만 받는다.
 * 요율 해석은 S5-02 `lib/core/pricing` 의 몫이다.
 */

/** '미정' 금액 sentinel. `0`(확정된 0원)과 반드시 구분한다. */
export const AMOUNT_UNKNOWN = "unknown";

/**
 * 금액 값.
 *
 * `null`·`undefined` 를 미정으로 쓰지 않는 이유: 옵셔널 prop 의 누락과 구분되지 않아
 * "안 넘겼다"가 조용히 "미정"으로 렌더된다. 미정은 **명시적으로** 선언해야 한다.
 */
export type PriceAmount = number | typeof AMOUNT_UNKNOWN;

/** 금액이 아직 정해지지 않은 상태인가. */
export function isUnknownAmount(value: PriceAmount): value is typeof AMOUNT_UNKNOWN {
  return value === AMOUNT_UNKNOWN;
}

/** 미정 금액 표기. "0원"과 절대 같은 문자열이 되지 않는다. */
export const UNKNOWN_AMOUNT_TEXT = "미정";

/** 플래너 미선택 표기. 0원도 미정도 아닌 **선택 상태**다. */
export const PLANNER_NOT_SELECTED_TEXT = "선택 안 함";

/** 플래너 선택 대상이 아닌 항목의 표기. '선택 안 함'과 다른 사실이다. */
export const PLANNER_UNAVAILABLE_TEXT = "선택 불가 항목";

/** 추가금 표기. 화면에서 생략할 수 없다. */
export type PriceAddOns =
  | { kind: "none" } // 사전 등록된 추가금이 없다 — 확정된 0원
  | { kind: "included" } // 필수 추가금이 이미 총액에 반영돼 있다
  | { kind: "listed"; count: number; total?: number } // 사전 등록된 추가금이 있다
  | { kind: "unknown" }; // 업체가 등록하지 않았다 — 미정으로 표시한다

/**
 * 플래너 수수료 표기 (D-17 · F-C-31).
 *
 * 플래너는 **카테고리별 부분 선택**이라 같은 화면 안에서도 항목마다 상태가 다르다.
 * 그래서 "금액이 0이다"가 아니라 **선택 상태**를 값으로 받는다.
 */
export type PlannerFee =
  /** 고를 수 있으나 고르지 않았다. 행을 숨기지 않고 '선택 안 함'으로 적는다. */
  | { kind: "not_selected" }
  /** 골랐다. `amount` 는 이미 계산된 금액이며 요율은 넘기지 않는다. */
  | { kind: "selected"; amount: PriceAmount; categoryCount?: number }
  /** 이 항목은 플래너 선택 대상이 아니다. '선택 안 함'이라고 적으면 사실과 다르다. */
  | { kind: "unavailable" };

/**
 * 표시 변형.
 *  - `item` 단품 하나의 가격.
 *  - `sum`  여러 항목의 합계. 플래너를 카테고리별로 다르게 고를 수 있으므로(D-17)
 *           합계 화면에서는 "몇 개 카테고리에 플래너를 붙였는지"가 함께 읽혀야 한다.
 */
export type PriceDisplayVariant = "item" | "sum";

export type PriceDisplayProps = {
  /** 총액(원, 정수). lib/core 규약과 동일하게 원 단위 정수만 받는다. */
  amount: PriceAmount;
  /** 판매가. **필수** — 내역의 첫 행이다. */
  basePrice: PriceAmount;
  /** 부가세 포함 여부. **필수** — 명시 없이 가격을 노출하지 않는다. */
  taxIncluded: boolean;
  /** 추가금 상태. **필수** — 동일 화면에서 확인 가능해야 한다. */
  addOns: PriceAddOns;
  /** 플래너 수수료 상태. **필수** — 미선택이어도 행을 숨기지 않는다. */
  plannerFee: PlannerFee;
  /** 단품용 `item`(기본) / 합계용 `sum`. */
  variant?: PriceDisplayVariant;
  /** `sum` 에서 합산한 항목 수. 합계가 무엇의 합인지 밝힌다. */
  itemCount?: number;
  /** '총 견적가', '예상 지불액' 등 금액의 성격. 생략하면 변형별 기본 라벨을 쓴다. */
  label?: string;
  size?: "lg" | "md" | "sm";
  /** 참가격 지수 대비 편차 배지 등 부가 요소. */
  aside?: ReactNode;
  className?: string;
};

/**
 * 원 단위 금액을 천 단위로 끊는다.
 *
 * `toLocaleString` 을 쓰지 않는 이유: 서버(Node)와 브라우저의 로캘 데이터가 다르면
 * 하이드레이션 불일치가 난다. 결정적 포매팅이 필요하다.
 */
export function formatKrw(amount: number): string {
  const rounded = Math.trunc(amount);
  const sign = rounded < 0 ? "-" : "";

  return sign + String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * 금액 하나를 화면 문자열로 만든다.
 *
 * `0` 은 "0원"(확정), 미정은 "미정"이다. 두 값이 같은 문자열이 되면
 * "추가금이 없다"와 "업체가 등록하지 않았다"가 화면에서 구별되지 않는다.
 */
export function formatAmountText(value: PriceAmount): string {
  return isUnknownAmount(value) ? UNKNOWN_AMOUNT_TEXT : `${formatKrw(value)}원`;
}

const AMOUNT_SIZE = {
  lg: "text-amount-lg",
  md: "text-amount",
  sm: "text-amount-sm",
} as const;

const UNIT_SIZE = {
  lg: "text-xl",
  md: "text-base",
  sm: "text-sm",
} as const;

const DEFAULT_LABEL: Record<PriceDisplayVariant, string> = {
  item: "총액",
  sum: "총 예상 금액",
};

const ROW_LABEL: Record<PriceDisplayVariant, { base: string; addOns: string; planner: string }> = {
  item: { base: "판매가", addOns: "추가금", planner: "플래너 수수료" },
  sum: { base: "판매가 합계", addOns: "추가금 합계", planner: "플래너 수수료 합계" },
};

type RowTone = "default" | "muted" | "warning" | "success";

const ROW_TONE: Record<RowTone, string> = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  warning: "text-warning",
  success: "text-success",
};

/** 내역 한 줄. 값은 오른쪽 정렬하고 부연은 값 아래에 둔다. */
function BreakdownRow({
  label,
  value,
  note,
  tone = "default",
  testId,
  state,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: RowTone;
  testId: string;
  state?: string;
}) {
  return (
    <div
      className="flex items-start justify-between gap-3"
      data-testid={testId}
      data-state={state}
    >
      <dt className="text-unit text-muted-foreground">{label}</dt>
      <dd className="text-right">
        <span data-amount="" className={cn("text-unit font-medium", ROW_TONE[tone])}>
          {value}
        </span>
        {note ? <span className="block text-caption text-muted-foreground">{note}</span> : null}
      </dd>
    </div>
  );
}

/** 추가금 행의 값·부연·톤을 정한다. */
function addOnRow(addOns: PriceAddOns): { value: string; note?: string; tone: RowTone } {
  switch (addOns.kind) {
    case "none":
      // 확정된 0원이다. 미정과 다르다.
      return { value: formatAmountText(0), note: "추가금 없음", tone: "success" };

    case "included":
      return { value: "총액에 포함", note: "필수 추가금 반영", tone: "success" };

    case "listed":
      return {
        value: addOns.total === undefined ? UNKNOWN_AMOUNT_TEXT : `최대 ${formatKrw(addOns.total)}원`,
        note: `사전 등록 ${addOns.count}건`,
        tone: addOns.total === undefined ? "warning" : "default",
      };

    case "unknown":
      // 업체가 추가금을 등록하지 않은 상태. 사실만 적고 평가적 단정을 하지 않는다
      // (CLAUDE.md §2.3).
      return { value: UNKNOWN_AMOUNT_TEXT, note: "추가금 미등록", tone: "warning" };
  }
}

/** 플래너 행의 값·부연·톤을 정한다. 어떤 상태에서도 행 자체는 사라지지 않는다. */
function plannerRow(
  plannerFee: PlannerFee,
  variant: PriceDisplayVariant,
): { value: string; note?: string; tone: RowTone } {
  switch (plannerFee.kind) {
    case "not_selected":
      return { value: PLANNER_NOT_SELECTED_TEXT, note: "선택 시 총액에 반영", tone: "muted" };

    case "unavailable":
      return { value: PLANNER_UNAVAILABLE_TEXT, tone: "muted" };

    case "selected":
      return {
        value: formatAmountText(plannerFee.amount),
        note:
          plannerFee.categoryCount === undefined
            ? variant === "sum"
              ? undefined
              : "플래너 포함"
            : `${plannerFee.categoryCount}개 카테고리 선택`,
        tone: isUnknownAmount(plannerFee.amount) ? "warning" : "default",
      };
  }
}

export function PriceDisplay({
  amount,
  basePrice,
  taxIncluded,
  addOns,
  plannerFee,
  variant = "item",
  itemCount,
  label,
  size = "md",
  aside,
  className,
}: PriceDisplayProps) {
  const rowLabel = ROW_LABEL[variant];
  const totalText = formatAmountText(amount);
  const addOn = addOnRow(addOns);
  const planner = plannerRow(plannerFee, variant);

  return (
    <div
      className={cn("space-y-2", className)}
      data-testid="price-display"
      data-variant={variant}
    >
      <p className="text-unit text-muted-foreground">
        {label ?? DEFAULT_LABEL[variant]}
        {variant === "sum" && itemCount !== undefined ? (
          <span className="text-caption"> · {itemCount}개 항목</span>
        ) : null}
      </p>

      {/* 총액이 화면에서 가장 크다. 비교해야 할 숫자 하나만 크게 보인다(§6). */}
      {isUnknownAmount(amount) ? (
        <p
          className={cn(AMOUNT_SIZE[size], "text-muted-foreground")}
          data-testid="price-total"
          data-state="unknown"
        >
          {UNKNOWN_AMOUNT_TEXT}
        </p>
      ) : (
        <p className="flex items-baseline gap-1" data-testid="price-total" data-state="known">
          <span
            data-amount=""
            className={cn(AMOUNT_SIZE[size], "text-foreground")}
            // 스크린리더가 자릿수 콤마를 하나씩 읽지 않도록 명시한다(§7.5).
            aria-label={totalText}
          >
            {formatKrw(amount)}
          </span>
          <span
            className={cn(UNIT_SIZE[size], "font-medium text-muted-foreground")}
            aria-hidden="true"
          >
            원
          </span>
        </p>
      )}

      {/* 내역은 총액과 같은 블록에 둔다 — 스크롤해야 보이면 규칙 위반이다. */}
      <dl className="space-y-1 border-t border-border pt-2" data-testid="price-breakdown">
        <BreakdownRow
          testId="price-row-base"
          label={rowLabel.base}
          value={formatAmountText(basePrice)}
          tone={isUnknownAmount(basePrice) ? "warning" : "default"}
          state={isUnknownAmount(basePrice) ? "unknown" : "known"}
        />
        <BreakdownRow
          testId="price-row-addons"
          label={rowLabel.addOns}
          value={addOn.value}
          note={addOn.note}
          tone={addOn.tone}
          state={addOns.kind}
        />
        {/* 미선택이어도 이 행은 남는다. 숨기면 항목의 존재 자체가 감춰진다(D-17). */}
        <BreakdownRow
          testId="price-row-planner"
          label={rowLabel.planner}
          value={planner.value}
          note={planner.note}
          tone={planner.tone}
          state={plannerFee.kind}
        />
      </dl>

      <p className="text-unit text-muted-foreground" data-testid="price-tax">
        부가세 {taxIncluded ? "포함" : "별도"}
      </p>

      {aside ? <div className="pt-1">{aside}</div> : null}
    </div>
  );
}

export default PriceDisplay;

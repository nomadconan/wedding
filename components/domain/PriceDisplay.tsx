import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * 가격 표시 (T-04b)
 *
 * 명세서 §6 공통 UI 규칙:
 *   "가격 표시는 항상 **총액**(부가세 포함 여부 명시) 기준이며,
 *    추가금은 **동일 화면에서** 확인 가능해야 한다."
 *
 * 이 규칙을 문서가 아니라 **타입으로** 강제한다.
 *  - `taxIncluded` 는 선택값이 아니다. 부가세 여부를 밝히지 않고는 렌더할 수 없다.
 *  - `addOns` 도 선택값이 아니다. 추가금이 없으면 `{ kind: "none" }` 을 명시해야 한다.
 *    "몰라서 안 적었다" 와 "없어서 안 적었다" 를 구분하기 위해서다.
 *
 * 이것이 서비스의 핵심 가치(가격 정찰제)를 화면에서 지키는 방식이다.
 * 총액을 크게, 단위를 작게 — 사용자가 비교해야 할 숫자 하나만 크게 보인다.
 */

/** 추가금 표기. 화면에서 생략할 수 없다. */
export type PriceAddOns =
  | { kind: "none" } // 사전 등록된 추가금이 없다
  | { kind: "included" } // 필수 추가금이 이미 총액에 반영돼 있다
  | { kind: "listed"; count: number; total?: number } // 사전 등록된 추가금이 있다
  | { kind: "unknown" }; // 업체가 등록하지 않았다 — 경고로 표시한다

export type PriceDisplayProps = {
  /** 총액(원, 정수). lib/core 규약과 동일하게 원 단위 정수만 받는다. */
  amount: number;
  /** 부가세 포함 여부. **필수** — 명시 없이 가격을 노출하지 않는다. */
  taxIncluded: boolean;
  /** 추가금 상태. **필수** — 동일 화면에서 확인 가능해야 한다. */
  addOns: PriceAddOns;
  /** '총 견적가', '예상 지불액' 등 금액의 성격. */
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

function AddOnNote({ addOns }: { addOns: PriceAddOns }) {
  switch (addOns.kind) {
    case "none":
      return (
        <span className="inline-flex items-center gap-1 text-unit text-success">
          <span aria-hidden="true">•</span> 추가금 없음
        </span>
      );

    case "included":
      return (
        <span className="inline-flex items-center gap-1 text-unit text-success">
          <span aria-hidden="true">•</span> 필수 추가금 포함
        </span>
      );

    case "listed":
      return (
        <span className="inline-flex items-center gap-1 text-unit text-muted-foreground">
          <span aria-hidden="true">•</span>
          사전 등록 추가금 {addOns.count}건
          {addOns.total === undefined ? null : <> · 최대 {formatKrw(addOns.total)}원</>}
        </span>
      );

    case "unknown":
      // 업체가 추가금을 등록하지 않은 상태. 사실만 적고 평가적 단정을 하지 않는다
      // (CLAUDE.md §2.3).
      return (
        <span className="inline-flex items-center gap-1 text-unit text-warning">
          <span aria-hidden="true">•</span> 추가금 미등록
        </span>
      );
  }
}

export function PriceDisplay({
  amount,
  taxIncluded,
  addOns,
  label,
  size = "md",
  aside,
  className,
}: PriceDisplayProps) {
  return (
    <div className={cn("space-y-1", className)} data-testid="price-display">
      {label ? <p className="text-unit text-muted-foreground">{label}</p> : null}

      <p className="flex items-baseline gap-1">
        <span
          data-amount=""
          className={cn(AMOUNT_SIZE[size], "text-foreground")}
          // 스크린리더가 자릿수 콤마를 하나씩 읽지 않도록 명시한다(§7.5).
          aria-label={`${formatKrw(amount)}원`}
        >
          {formatKrw(amount)}
        </span>
        <span className={cn(UNIT_SIZE[size], "font-medium text-muted-foreground")} aria-hidden="true">
          원
        </span>
      </p>

      {/* 부가세 여부와 추가금은 총액과 같은 블록에 둔다 — 스크롤해야 보이면 규칙 위반이다. */}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="text-unit text-muted-foreground">
          부가세 {taxIncluded ? "포함" : "별도"}
        </span>
        <AddOnNote addOns={addOns} />
      </p>

      {aside ? <div className="pt-1">{aside}</div> : null}
    </div>
  );
}

export default PriceDisplay;

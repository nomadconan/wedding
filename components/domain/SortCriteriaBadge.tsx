import { ArrowUpDown } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * 정렬 기준 배지 (T-04b)
 *
 * 명세서 §6 공통 UI 규칙 / CLAUDE.md §2.2:
 *   "정렬·추천 결과에는 기준 배지를 노출한다(**유료 노출 없음을 UI에서 증명**)."
 *
 * 이 배지는 장식이 아니라 **증거**다. 광고·제휴 수익을 받지 않는 구조(D-03)를
 * 사용자가 화면에서 직접 확인할 수 있게 만드는 장치다.
 *
 * 목록 화면은 이 배지 없이 렌더하면 안 된다. API 응답의 정렬 기준 코드
 * (`GET /api/vendors` 의 정렬 기준 필드, §4.2)를 그대로 받아 표시한다.
 * AI 플래너의 `search_vendors` 툴도 같은 코드를 동반 반환한다(§5.5).
 */

/** 정렬 기준 코드. API 응답·AI 툴 반환값과 동일한 값을 쓴다. */
export const SORT_CRITERIA = {
  price_asc: "가격 낮은 순",
  price_desc: "가격 높은 순",
  price_index_gap: "참가격 대비 편차 순",
  review_score: "후기 점수 순",
  response_speed: "응답 속도 순",
  distance: "거리 순",
  available_date: "예약 가능일 순",
  recent: "최근 등록 순",
} as const;

export type SortCriteriaCode = keyof typeof SORT_CRITERIA;

export type SortCriteriaBadgeProps = {
  /** API 가 함께 내려준 정렬 기준 코드. */
  criteria: SortCriteriaCode;
  /**
   * "유료 노출 없음" 문구를 함께 보일지 여부.
   * 목록 상단에는 true(기본), 카드 안 반복 노출에는 false 를 쓴다.
   */
  showNoPaidPlacement?: boolean;
  className?: string;
};

export function SortCriteriaBadge({
  criteria,
  showNoPaidPlacement = true,
  className,
}: SortCriteriaBadgeProps) {
  return (
    <div
      className={cn("flex flex-wrap items-center gap-1.5", className)}
      data-testid="sort-criteria-badge"
    >
      <span className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-1 text-caption font-medium text-secondary-foreground">
        <ArrowUpDown aria-hidden="true" className="h-3 w-3" />
        정렬 기준 · {SORT_CRITERIA[criteria]}
      </span>

      {showNoPaidPlacement ? (
        <span className="inline-flex items-center rounded-md bg-brand-50 px-2 py-1 text-caption font-medium text-brand-700">
          유료 노출 없음
        </span>
      ) : null}
    </div>
  );
}

export default SortCriteriaBadge;

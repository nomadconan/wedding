/**
 * 플래너 랭킹 — **기준 공개** (S6-06 · 명세서 §2.1 F-C-18, D-03 · D-25 · O-13)
 *
 * 프레임워크도 DB 도 모르는 순수 모듈이다.
 *
 * ── 이 태스크가 목록을 새로 만들지 않는 이유 ────────────────────────────────
 * S6-02 가 이미 마켓(`/planners`)에서 정렬을 하고 있고, 그 정렬은 **지금 셀 수 있는
 * 유일한 실적 지표**(계약 건수)와 두 가지 사실(경력·등록 시점)로만 이뤄진다. 동점
 * 처리도 고정돼 있다(`sortMarket`). **같은 지표로 목록을 하나 더 그리면 그것은 같은
 * 목록**이고, 두 화면이 같은 순서를 각자 계산하는 순간 어긋날 자리가 생긴다
 * (FIX-52 가 요율에서 만든 자리와 같다).
 *
 * 그래서 이 파일이 하는 일은 **순서를 만드는 것이 아니라 순서의 근거를 공개하는
 * 것**이다 — D-25 가 요구하는 것이 정확히 그것이고, S6-01 이 판정 함수
 * (`rankingMetricAvailability`)를 만들어 두었는데 **읽는 화면이 없었다.**
 *
 * ── 지어내지 않는 것 둘 ─────────────────────────────────────────────────────
 *  1. **가중치.** 산정식은 **O-13 미결**이다. 지표가 하나뿐인 지금 종합 점수를 만들면
 *     그 계수가 곧 기준처럼 굳고, 플래너의 수입이 우리가 지어낸 숫자에 좌우된다.
 *  2. **콜드스타트 대응.** 실적 0인 신규 플래너를 어떻게 노출할지도 O-13 에 함께
 *     열려 있다. 여기서는 **물음을 그대로 보여줄 뿐** 답하지 않는다.
 */

import {
  MARKET_SORTS,
  MARKET_SORT_BASIS_NOTICE,
  MARKET_SORT_LABEL,
  type MarketSort,
} from "./profile";
import {
  COLD_START_NOTE,
  COLD_START_OPEN_ISSUE,
  RANKING_BASIS_NOTICE,
  RANKING_FORMULA_PENDING_NOTICE,
  RANKING_METRICS,
  RANKING_METRIC_LABEL,
  rankingMetricAvailability,
  usableRankingMetrics,
  type RankingMetric,
} from "./scope";

export {
  COLD_START_NOTE,
  COLD_START_OPEN_ISSUE,
  RANKING_BASIS_NOTICE,
  RANKING_FORMULA_PENDING_NOTICE,
  RANKING_METRICS,
  RANKING_METRIC_LABEL,
  rankingMetricAvailability,
  usableRankingMetrics,
  type RankingMetric,
} from "./scope";

/** 한 지표를 화면이 그대로 그릴 수 있는 모양. */
export type RankingMetricRow =
  | { metric: RankingMetric; label: string; state: "counted"; source: string }
  /** 채우는 경로가 아직 없다. **담당 태스크가 있다.** */
  | { metric: RankingMetric; label: string; state: "pending"; reason: string; owner: string }
  /**
   * 구조상 **따로 셀 수 없다.** 담당이 생겨도 별도 지표가 되지 않으므로
   * "곧 생긴다" 로 적으면 거짓말이다.
   */
  | {
      metric: RankingMetric;
      label: string;
      state: "not_distinct";
      reason: string;
      sameAs: RankingMetric;
      sameAsLabel: string;
    };

export function rankingMetricRow(metric: RankingMetric): RankingMetricRow {
  const availability = rankingMetricAvailability(metric);
  const label = RANKING_METRIC_LABEL[metric];

  if (availability.available) {
    return { metric, label, state: "counted", source: availability.source };
  }

  if (availability.kind === "pending") {
    return {
      metric,
      label,
      state: "pending",
      reason: availability.reason,
      owner: availability.owner,
    };
  }

  return {
    metric,
    label,
    state: "not_distinct",
    reason: availability.reason,
    sameAs: availability.sameAs,
    sameAsLabel: RANKING_METRIC_LABEL[availability.sameAs],
  };
}

/** 지금 목록에서 고를 수 있는 정렬과 그것이 무엇으로 정해지는지. */
export type RankingSortRow = {
  sort: MarketSort;
  label: string;
  /** 실적 지표인가, 아니면 사실 정보인가. 광고와 무관함을 가르는 축이다. */
  kind: "performance" | "fact";
  basis: string;
};

export const RANKING_SORTS: readonly RankingSortRow[] = [
  {
    sort: "contracts",
    label: MARKET_SORT_LABEL.contracts,
    kind: "performance",
    basis: "성사된 계약에서 생긴 수수료 원장의 건수(무효 제외)",
  },
  {
    sort: "career",
    label: MARKET_SORT_LABEL.career,
    kind: "fact",
    basis: "플래너가 프로필에 적은 경력 연수(본인 기재)",
  },
  {
    sort: "recent",
    label: MARKET_SORT_LABEL.recent,
    kind: "fact",
    basis: "플래너 등록 시점",
  },
] as const;

export type RankingDisclosure = {
  /** 지금 목록에 실제로 쓰이는 정렬 후보. `MARKET_SORTS` 와 같아야 한다. */
  sorts: RankingSortRow[];
  metrics: RankingMetricRow[];
  /** 지금 셀 수 있는 실적 지표. 하나뿐이면 종합 점수를 만들 수 없다. */
  counted: RankingMetric[];
  /**
   * 종합 점수를 만들었는가. **언제나 false 다.**
   *
   * 값으로 들고 다니는 이유 — 화면에서만 "안 만들었다" 고 적으면 이 함수를 쓰는
   * 다음 사람은 만들어도 되는 줄 안다(함정 3). API 본문에도 그대로 나간다.
   */
  compositeScore: false;
  formulaPending: { openIssue: string; note: string };
  coldStart: { openIssue: string; note: string };
  /** 광고·제휴가 순서에 없다는 고지. §2.2 가 업체 목록에 세운 것과 같은 규칙이다. */
  notices: { basis: string; sortBasis: string };
};

/**
 * 랭킹 기준 공개.
 *
 * **판정을 다시 만들지 않는다** — `rankingMetricAvailability`(S6-01)와
 * `MARKET_SORTS`(S6-02)를 그대로 읽어 화면이 그릴 모양으로만 바꾼다. 여기서 다시
 * 판정하면 공개한 기준과 실제 순서가 갈리고, 그것은 공개하지 않는 것보다 나쁘다.
 */
export function rankingDisclosure(): RankingDisclosure {
  return {
    sorts: RANKING_SORTS.filter((row) =>
      (MARKET_SORTS as readonly string[]).includes(row.sort),
    ).map((row) => ({ ...row })),
    metrics: RANKING_METRICS.map(rankingMetricRow),
    counted: usableRankingMetrics(),
    compositeScore: false,
    formulaPending: { openIssue: COLD_START_OPEN_ISSUE, note: RANKING_FORMULA_PENDING_NOTICE },
    coldStart: { openIssue: COLD_START_OPEN_ISSUE, note: COLD_START_NOTE },
    notices: { basis: RANKING_BASIS_NOTICE, sortBasis: MARKET_SORT_BASIS_NOTICE },
  };
}

// =============================================================================
// 화면 문구
// =============================================================================

export const RANKING_TITLE = "플래너 순서 기준";

export const RANKING_INTRO =
  "플래너 목록의 순서가 무엇으로 정해지는지 그대로 공개해요. **광고·제휴를 받지 않기 때문에** 돈으로 순서를 살 수 있는 자리가 아예 없습니다.";

/**
 * **목록을 여기서 다시 그리지 않는다.**
 *
 * 같은 지표로 목록을 하나 더 만들면 그것은 같은 목록이고, 두 화면이 각자 계산하는
 * 순간 어긋날 자리가 생긴다. 여기는 기준을 읽는 자리이고 목록은 마켓이 든다.
 */
export const RANKING_LIST_ELSEWHERE_NOTICE =
  "순서가 적용된 목록은 플래너 찾기 화면에 있어요. 여기서는 그 순서의 근거만 봅니다.";

export const RANKING_METRIC_STATE_LABEL: Record<RankingMetricRow["state"], string> = {
  counted: "세고 있어요",
  pending: "아직 세지 않아요",
  not_distinct: "따로 세지 않아요",
};

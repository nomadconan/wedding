/**
 * 플래너 범위 (S6-01 · 명세서 §2.1 F-C-18·F-C-31, §3.7 planner_scopes·
 * planner_engagements, §3.9, D-17 · D-18 · D-23 · D-25)
 *
 * 프레임워크도 DB 도 모르는 순수 모듈이다.
 *
 * ── 플래너는 선택적 보조자다 (D-18) ─────────────────────────────────────────
 * 서비스의 주인공이 아니다. 고객은 **카테고리별로 이용 여부를 개별 선택**하고
 * (F-C-31), 선택한 항목에만 수수료가 붙는다. **상담만으로는 발생하지 않는다** —
 * 계약이 성사돼야 한다(D-17).
 *
 * ── 축이 둘이고 서로 다르다 ─────────────────────────────────────────────────
 * 이 태스크의 핵심 판단이다.
 *
 *  1. **`planner_engagements`**(T-03 이 만들었다) — **데이터 열람 권한 위임**이다.
 *     "이 플래너가 우리 커플의 어떤 **표**를 볼 수 있는가" 이며 RLS(`has_planner_scope`)가
 *     그 판정을 한다. 범위는 `{"tables": [...]}` 이고 기간·상태를 갖는다.
 *  2. **`planner_scopes`**(S6-01 이 만든다) — **카테고리별 이용 여부**다.
 *     "홀은 직접, 스드메만 플래너" 를 표현하며 **과금의 축**이다(F-C-31).
 *
 * **합치면 표현할 수 없는 상태가 생긴다.** 예를 들어 "예산 표는 보게 하되 어느
 * 카테고리에도 플래너를 쓰지 않는다"(=수수료 0) 는 실제로 있을 수 있는 상태다 —
 * 상담만 받아 보는 단계가 그렇다. 반대로 "드레스만 플래너를 쓰지만 우리 장바구니
 * 전체를 보여준다" 도 자연스럽다. 그래서 명세가 두 표를 따로 둔 것이고, 이 파일도
 * 두 축을 섞지 않는다.
 *
 * **여기 없는 것 둘.**
 *  1. **요율.** `planner_fee_rates`(S5-01)가 갖고 `resolveRate`(S5-02)가 해석한다.
 *     명세도 "**요율을 여기 저장하지 않는다**" 고 못 박았다 — 계약 확정 시
 *     `bookings.applied_planner_fee_rate_bp` 로 스냅샷된다(D-16).
 *  2. **랭킹 가중치.** O-13 미결이며 **가중치를 지어내지 않는다**(아래 참조).
 */

import { AMOUNT_UNKNOWN, sumAmounts, type Amount } from "../pricing/amount";
import { calculatePlannerFee } from "../pricing/rates";

export { AMOUNT_UNKNOWN, isUnknownAmount, type Amount } from "../pricing/amount";

/** 입력이 규약을 벗어날 때 던진다. */
export class PlannerScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlannerScopeError";
  }
}

// =============================================================================
// 값 집합 — DB CHECK 와 같아야 한다 (`db:rls` 가 정합을 본다)
// =============================================================================

/**
 * 선택 상태.
 *
 * **`released` 행을 지우지 않는다.** "언제부터 언제까지 이 카테고리에 플래너를
 * 썼는가" 는 정산 분쟁에서 실제로 묻는 질문이고(D-23), 지우면 답할 수 없다.
 * 재선택은 **새 행**이며 부분 유니크가 "동시에 선택된 것은 하나" 를 지킨다.
 */
export const SCOPE_STATUSES = ["selected", "released"] as const;
export type ScopeStatus = (typeof SCOPE_STATUSES)[number];

export const SCOPE_STATUS_LABEL: Record<ScopeStatus, string> = {
  selected: "플래너 이용",
  released: "직접 진행",
};

/**
 * 플래너를 쓸 수 있는 카테고리.
 *
 * `ESTIMATE_CATEGORIES`(§3 견적 항목)의 부분집합이다 — **업체와 거래가 일어나는
 * 카테고리만** 대상이며, `helper`(헬퍼비)처럼 업체 계약이 아닌 항목은 뺀다.
 * 플래너 수수료는 **판매가에 붙는 비율**이라(F-C-31) 판매가가 없는 항목에는
 * 붙을 자리가 없다.
 */
export const PLANNER_CATEGORIES = [
  "hall",
  "studio",
  "dress",
  "makeup",
  "video",
  "snap",
  "flower",
  "invitation",
] as const;

export type PlannerCategory = (typeof PLANNER_CATEGORIES)[number];

export const PLANNER_CATEGORY_LABEL: Record<PlannerCategory, string> = {
  hall: "웨딩홀",
  studio: "스튜디오",
  dress: "드레스",
  makeup: "헤어·메이크업",
  video: "본식 영상",
  snap: "본식 스냅",
  flower: "부케·꽃장식",
  invitation: "청첩장",
};

export function isPlannerCategory(value: string): value is PlannerCategory {
  return (PLANNER_CATEGORIES as readonly string[]).includes(value);
}

// =============================================================================
// 선택 — 카테고리별로 개별이다 (F-C-31)
// =============================================================================

export type ScopeRow = {
  category: string;
  plannerId: string;
  status: ScopeStatus;
  selectedAt: string;
  releasedAt: string | null;
};

/**
 * 지금 플래너를 쓰는 카테고리.
 *
 * **저장된 상태만 본다.** `released` 행은 이력이므로 세지 않는다 — 같은 카테고리에
 * `released` 가 여럿이고 `selected` 가 하나인 상태가 정상이다.
 */
export function selectedCategories(rows: readonly ScopeRow[]): PlannerCategory[] {
  return rows
    .filter((row) => row.status === "selected" && isPlannerCategory(row.category))
    .map((row) => row.category as PlannerCategory);
}

/**
 * 이 카테고리에 플래너 수수료가 붙는가.
 *
 * **선택된 카테고리에만 붙는다**(F-C-31). 그리고 **여기서 참이어도 아직 돈이
 * 발생한 것은 아니다** — 실제 발생은 계약 성사 시점이며(D-17) 그때
 * `bookings.applied_planner_fee_rate_bp` 로 스냅샷되고 `planner_settlements` 행이
 * 생긴다(S5-06 `activateContract`).
 */
export function plannerFeeApplies(input: {
  category: string;
  scopes: readonly ScopeRow[];
}): boolean {
  return selectedCategories(input.scopes).includes(input.category as PlannerCategory);
}

/**
 * 담긴 항목 중 플래너를 쓰는 것이 몇 개인가.
 *
 * 장바구니는 **항목 단위**로도 플래너를 토글한다(`cart_items.planner_selected` ·
 * IDEA-01 이 장바구니마다 다를 수 있게 했다). 그래서 **카테고리 선택과 항목 토글이
 * 어긋날 수 있다** — 이 함수는 그 어긋남을 드러낸다.
 *
 * **어느 쪽이 이기는가**: 항목 토글이 이긴다. 카테고리 선택은 **기본값**이고
 * 장바구니에서 항목별로 다르게 정할 수 있어야 조합 비교(S3-07·S3-12)가 성립한다.
 * 다만 **선택하지 않은 카테고리의 항목을 켜면** 그것은 카테고리 선택을 함께 켜는
 * 것과 같으므로 화면이 그 사실을 알린다.
 */
export function scopeMismatch(input: {
  items: readonly { category: string; plannerSelected: boolean }[];
  scopes: readonly ScopeRow[];
}): { category: PlannerCategory; itemOn: boolean }[] {
  const selected = new Set(selectedCategories(input.scopes));
  const seen = new Map<PlannerCategory, boolean>();

  for (const item of input.items) {
    if (!isPlannerCategory(item.category)) continue;

    const category = item.category as PlannerCategory;
    const inScope = selected.has(category);

    if (item.plannerSelected !== inScope) seen.set(category, item.plannerSelected);
  }

  return [...seen.entries()].map(([category, itemOn]) => ({ category, itemOn }));
}

export const SCOPE_MISMATCH_NOTICE =
  "장바구니에서 항목별로 정한 플래너 이용 여부가 카테고리 설정과 달라요. 장바구니 설정이 먼저 적용됩니다.";

// =============================================================================
// 위임 해제 — 이미 성사된 계약은 건드리지 않는다 (D-16 · D-17)
// =============================================================================

export type ReleaseImpact = {
  /** 앞으로 발생할 계약에 수수료가 붙지 않는다. */
  futureFeeStops: true;
  /** 이미 성사된 계약의 수수료. **바뀌지 않는다.** */
  settledFeesUnchanged: true;
  /** 열람 권한이 함께 끊기는가. **아니다** — 다른 축이다. */
  visibilityUnchanged: true;
  notes: string[];
};

/**
 * 카테고리 선택을 해제하면 무엇이 바뀌는가.
 *
 * **이미 성사된 계약의 수수료는 그대로다.** `bookings.applied_planner_fee_rate_bp`
 * 는 계약 확정 시점 스냅샷이고 불변 트리거가 지킨다(0028). `planner_settlements` 도
 * 계약 성사 시 생긴 원장이다(D-17). 해제로 그것을 지우면 **이미 일한 대가를 소급해
 * 없애는 것**이고, 요율 스냅샷 원칙(D-16)이 무너진다.
 *
 * **열람 권한은 따로 끊어야 한다.** 카테고리 해제는 **과금 축**의 일이고, "우리
 * 데이터를 볼 수 있는가" 는 `planner_engagements` 가 갖는 **다른 축**이다. 하나를
 * 끄면 다른 하나도 꺼진다고 가정하면, 고객은 "플래너를 뺐는데 아직 우리 예산을
 * 본다" 를 나중에 발견한다. 화면이 두 경로를 함께 안내한다.
 */
export function releaseImpact(): ReleaseImpact {
  return {
    futureFeeStops: true,
    settledFeesUnchanged: true,
    visibilityUnchanged: true,
    notes: [
      "앞으로 맺는 계약에는 이 카테고리의 플래너 수수료가 붙지 않아요.",
      "이미 확정된 계약의 수수료는 그대로예요 — 계약 시점에 정해진 금액이라 나중에 바꾸지 않습니다.",
      "데이터 열람 권한은 따로 관리해요. 플래너가 더는 보지 않게 하려면 위임도 함께 해제해 주세요.",
    ],
  };
}

export const RELEASE_CONFIRM_TITLE = "이 카테고리에서 플래너를 빼시겠어요?";

// =============================================================================
// 위임 후 볼 수 있는 것과 없는 것 — **이 파일에 두지 않는다**
// -----------------------------------------------------------------------------
// S6-01 이 여기 `PLANNER_VISIBILITY` 여섯 줄을 두었는데, S6-04 가 위임 화면을 만들며
// **정책에서 뽑은 열한 개**를 `lib/core/planner/delegation.ts` 에 세웠다. 두 목록이
// 같은 사실을 다르게 적고 있었고(이쪽은 여섯 · 저쪽은 열한 개 + 막힌 것 다섯), 화면은
// 저쪽만 쓰고 있었다 — **읽히지 않는 목록이 진실 행세를 하던 상태**다.
//
// S6-03 이 이 목록을 지운다. **위임 범위의 어휘는 `delegation.ts` 하나가 든다**
// (`DELEGATABLE_SCOPES` · `CLOSED_SCOPES` · `VISIBILITY_NOTICE`)이며, 그쪽은
// `db:rls` 가 정책·DB CHECK 과 매번 대조한다. 이 파일은 **과금 축**만 든다(D-43).
// =============================================================================


// =============================================================================
// 랭킹 지표 — 지금 셀 수 있는 것과 아직 못 세는 것 (D-25 · O-13)
// =============================================================================

export const RANKING_METRICS = [
  "consultations",
  "bookings",
  "contracts",
  "reviews",
  "profile_views",
] as const;

export type RankingMetric = (typeof RANKING_METRICS)[number];

export const RANKING_METRIC_LABEL: Record<RankingMetric, string> = {
  consultations: "상담 건수",
  bookings: "예약 건수",
  contracts: "계약 건수",
  reviews: "리뷰 건수",
  profile_views: "프로필 방문 수",
};

/**
 * 이 지표를 지금 셀 수 있는가.
 *
 * **못 세는 이유가 두 종류다**(S6-06 이 갈랐다).
 *  · `pending` — 채우는 경로가 아직 없다. **담당 태스크가 있다.**
 *  · `not_distinct` — 구조상 다른 지표와 **같은 행을 센다.** 담당이 생겨도 별도
 *    지표가 되지 않으므로 "언젠가 열린다" 고 적으면 거짓말이 된다.
 *
 * 둘을 한 통에 담으면 화면이 "곧 생긴다" 와 "생길 수 없다" 를 같은 문장으로 적는다.
 */
export type MetricAvailability =
  | { available: true; source: string }
  | { available: false; kind: "pending"; reason: string; owner: string }
  | { available: false; kind: "not_distinct"; reason: string; sameAs: RankingMetric };

/**
 * 지금 이 지표를 실제로 셀 수 있는가.
 *
 * **못 세는 것을 0으로 표시하지 않는다.** 0은 "해 봤는데 없다" 는 뜻이고, 지금
 * 필요한 표현은 "**아직 세지 않는다**" 다 — S2-08 대시보드·S3-11 홈이 같은 규칙을
 * 세웠다. 어느 태스크가 채우는지도 함께 밝힌다.
 *
 * **랭킹 산정식(O-13)은 미결이다.** 가중치를 여기서 만들지 않는다 — 만들면 그 숫자가
 * 곧 기준처럼 굳고, 플래너의 수입이 우리가 지어낸 계수에 좌우된다(D-25 가 실적
 * 지표만 쓰라고 한 취지에도 어긋난다).
 */
export function rankingMetricAvailability(metric: RankingMetric): MetricAvailability {
  switch (metric) {
    case "contracts":
      // 계약 성사 시 planner_settlements 행이 생긴다(D-17 · S5-06 activateContract).
      return { available: true, source: "planner_settlements" };

    case "consultations":
      // 컬럼은 있지만(0025 `consultations.planner_id`) 채우는 경로가 아직 없다.
      // **담당이 옮겨졌다**(FIX-51): S6-04 는 그 값을 채우지 않기로 했다 — 위임에서
      // 계산 가능한 값이라 저장하면 위임을 거둔 뒤에도 남는 두 번째 진실이 된다.
      // 그 컬럼의 실제 쓰임은 3자 캘린더 동기화(D-19)이며 그것은 S4-11 이다.
      return {
        available: false,
        kind: "pending",
        reason: "상담에 플래너를 연결하는 값을 채우는 경로가 아직 없어요.",
        owner: "S4-11",
      };

    case "bookings":
      // **따로 셀 수 없는 지표다**(S6-06 이 확인했다). 예약과 플래너를 잇는 **저장된
      // 값**은 `planner_settlements`(booking_id + planner_id)뿐이고 그 행은 **계약이
      // 성사돼야** 생긴다(D-17). 즉 "플래너가 붙은 예약" 을 세면 계약 건수와 **같은
      // 행**을 센다 — 담당 태스크가 생겨도 별도 지표가 되지 않는다.
      return {
        available: false,
        kind: "not_distinct",
        reason:
          "예약과 플래너를 잇는 값은 계약이 성사될 때 생겨요. 따로 세면 계약 건수와 같은 행을 두 번 세게 됩니다.",
        sameAs: "contracts",
      };

    case "reviews":
      // `reviews` 는 vendor_id 대상이다. 플래너를 평가하는 구조가 없다.
      return {
        available: false,
        kind: "pending",
        reason: "후기는 업체를 대상으로만 쌓입니다. 플래너 후기 구조가 아직 없어요.",
        owner: "S8-11",
      };

    case "profile_views":
      return {
        available: false,
        kind: "pending",
        reason: "프로필 방문을 세는 경로가 아직 없어요.",
        owner: "S8-10",
      };
  }
}

/** 지금 실제로 정렬에 쓸 수 있는 지표. 하나뿐이면 종합 점수를 만들지 않는다. */
export function usableRankingMetrics(): RankingMetric[] {
  return RANKING_METRICS.filter((metric) => rankingMetricAvailability(metric).available);
}

/**
 * 랭킹 산정 기준 공개 문구(D-25).
 *
 * **화면에 그대로 노출한다.** "왜 이 순서인가" 를 밝히지 않는 목록은 광고와
 * 구별되지 않는다(§2.2 가 업체 정렬에서 세운 것과 같은 규칙).
 */
export const RANKING_BASIS_NOTICE =
  "플래너 순서는 실적 지표로만 정합니다. 광고·제휴는 순서에 반영되지 않아요.";

export const RANKING_FORMULA_PENDING_NOTICE =
  "지표를 어떻게 합산할지는 아직 정해지지 않았어요(O-13). 지금은 셀 수 있는 지표 하나를 기준으로 정렬하며, 기준은 목록에 함께 표시됩니다.";

/**
 * **신규 플래너 콜드스타트.**
 *
 * 실적만으로 정렬하면 실적 0인 신규 플래너는 영원히 하위에 남고, 그러면 신규 유입이
 * 끊긴다 — 랭킹이 **기존 사업자의 진입 장벽**이 된다. D-25 는 "실적 지표로만" 이라고
 * 했지만 **노출 기회 자체를 어떻게 나눌지는 별개의 물음**이며 O-13 에 함께 기록해야
 * 한다. 이 상수는 그 물음을 코드에 붙잡아 둔다 — 답을 지어내지 않는다.
 */
export const COLD_START_OPEN_ISSUE = "O-13";

export const COLD_START_NOTE =
  "실적이 없는 신규 플래너가 영원히 하위에 남으면 랭킹이 진입 장벽이 됩니다. 노출 기회를 어떻게 나눌지는 O-13 에서 함께 정해야 합니다.";

// =============================================================================
// 화면 문구
// =============================================================================

export const SCOPE_TITLE = "플래너 이용 범위";

export const SCOPE_EMPTY_TITLE = "아직 플래너를 쓰지 않아요";

export const SCOPE_EMPTY_BODY =
  "카테고리마다 따로 정할 수 있어요. 예를 들어 홀은 직접 알아보고 스드메만 플래너에게 맡길 수 있습니다.";

/**
 * **상담만으로는 수수료가 발생하지 않는다**(D-17).
 *
 * 이 문장을 선택 화면에 두는 이유 — 고객이 "고르면 바로 돈이 나가는가" 를 묻지 않고도
 * 알 수 있어야 한다. 실제 발생 시점은 계약 성사이며 그 전까지는 **총액 표시가 바뀔 뿐**이다.
 */
export const FEE_TIMING_NOTICE =
  "선택하면 총액에 플래너 수수료가 함께 표시돼요. 실제로 발생하는 것은 **계약이 성사된 뒤**이며, 상담만 받고 계약하지 않으면 수수료는 없습니다.";

// =============================================================================
// 선택의 변경 — 무엇을 켜고 무엇을 끄는가 (S6-03 · F-C-31)
// =============================================================================

/** 고객이 원하는 상태. "어느 카테고리를 누구에게" 다. **요율은 없다**(D-16). */
export type ScopeSelection = { category: PlannerCategory; plannerId: string };

export const SCOPE_CHANGE_ERRORS = [
  "category_unknown",
  "category_duplicated",
  "planner_not_delegated",
] as const;

export type ScopeChangeError = (typeof SCOPE_CHANGE_ERRORS)[number];

export const SCOPE_CHANGE_MESSAGE: Record<ScopeChangeError, string> = {
  category_unknown:
    "고를 수 없는 카테고리가 섞여 있어요. 판매가가 있는 항목에만 플래너 수수료가 붙습니다.",
  category_duplicated: "한 카테고리에 플래너를 둘 지정할 수 없어요.",
  planner_not_delegated:
    "먼저 그 플래너에게 열람 권한을 위임해 주세요. 보지도 못하는 플래너에게 수수료가 붙으면 안 됩니다.",
};

export type ScopeChangeValidation = { ok: true } | { ok: false; errors: ScopeChangeError[] };

/**
 * 원하는 선택이 성립하는가.
 *
 * **위임을 전제로 본다**(0036 트리거가 최종 경계다). 두 축은 독립이지만(D-43) 선택의
 * **전제**로는 위임이 필요하다 — 없으면 보지도 못하는 플래너에게 수수료가 붙는다.
 * 여기서 먼저 판정하는 이유는 화면이 **왜** 막혔는지 말할 수 있어야 하기 때문이다.
 */
export function validateScopeSelection(
  desired: readonly ScopeSelection[],
  delegatedPlannerIds: readonly string[],
): ScopeChangeValidation {
  const errors: ScopeChangeError[] = [];
  const seen = new Set<string>();

  for (const item of desired) {
    if (!isPlannerCategory(item.category)) {
      if (!errors.includes("category_unknown")) errors.push("category_unknown");
      continue;
    }

    if (seen.has(item.category)) {
      if (!errors.includes("category_duplicated")) errors.push("category_duplicated");
    }
    seen.add(item.category);

    if (!delegatedPlannerIds.includes(item.plannerId)) {
      if (!errors.includes("planner_not_delegated")) errors.push("planner_not_delegated");
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export type ScopeDiff = {
  /** 새 행으로 만들 것. */
  select: ScopeSelection[];
  /** `released` 로 옮길 것. **행을 지우지 않는다**(D-23). */
  release: ScopeSelection[];
  /** 그대로 두는 것. */
  unchanged: ScopeSelection[];
};

/**
 * 지금 상태와 원하는 상태의 차이.
 *
 * **플래너를 바꾸는 것은 해제 + 새 선택이다.** 같은 행의 `planner_id` 를 갈아 끼우면
 * "언제부터 언제까지 **누구에게** 맡겼는가" 가 하나의 행에 두 번 적히게 되고,
 * 정산 분쟁에서 그 구간을 나눌 수 없다(D-23 · 0070 트리거가 최종 경계다).
 */
export function diffScopes(
  current: readonly ScopeRow[],
  desired: readonly ScopeSelection[],
): ScopeDiff {
  const now = new Map<PlannerCategory, string>();

  for (const row of current) {
    if (row.status !== "selected" || !isPlannerCategory(row.category)) continue;
    now.set(row.category as PlannerCategory, row.plannerId);
  }

  const want = new Map<PlannerCategory, string>();
  for (const item of desired) {
    if (!isPlannerCategory(item.category)) continue;
    want.set(item.category, item.plannerId);
  }

  const diff: ScopeDiff = { select: [], release: [], unchanged: [] };

  for (const category of PLANNER_CATEGORIES) {
    const before = now.get(category) ?? null;
    const after = want.get(category) ?? null;

    if (before === null && after === null) continue;

    if (before === after && before !== null) {
      diff.unchanged.push({ category, plannerId: before });
      continue;
    }

    if (before !== null) diff.release.push({ category, plannerId: before });
    if (after !== null) diff.select.push({ category, plannerId: after });
  }

  return diff;
}

// =============================================================================
// 총액 영향 — **선택 즉시 반영**한다 (F-C-31)
// =============================================================================

/**
 * 카테고리 한 줄의 과금 미리보기.
 *
 * **`fee` 가 0인 것과 미정인 것은 다르다**(함정 2). 고르지 않았으면 0이고, 요율이
 * 해석되지 않으면 **미정**이다 — 미정을 0으로 접으면 총액이 실제보다 작게 보이고,
 * 고객은 "플래너를 써도 공짜" 로 읽는다.
 */
export type ScopeFeeLine = {
  category: PlannerCategory;
  selected: boolean;
  plannerId: string | null;
  /** 이 카테고리로 담긴 항목 수. */
  itemCount: number;
  /** 담긴 항목의 판매가 합계. */
  salePriceTotal: number;
  /** 적용될 요율. **없으면 null 이며 0으로 접지 않는다**(O-02 · §3.8). */
  rateBp: number | null;
  fee: Amount;
};

export function scopeFeeLine(input: {
  category: PlannerCategory;
  selected: boolean;
  plannerId: string | null;
  itemCount: number;
  salePriceTotal: number;
  rateBp: number | null;
}): ScopeFeeLine {
  const fee: Amount = !input.selected
    ? 0
    : input.rateBp === null
      ? AMOUNT_UNKNOWN
      : calculatePlannerFee({
          salePrice: input.salePriceTotal,
          feeRateBp: input.rateBp,
          selected: true,
        });

  return { ...input, fee };
}

/** 선택한 카테고리의 수수료 합계. 한 줄이라도 미정이면 합계도 미정이다. */
export function scopeFeeTotal(lines: readonly ScopeFeeLine[]): Amount {
  return sumAmounts(lines.map((line) => line.fee));
}

/**
 * **집행은 계약 발행 시점에 일어난다.**
 *
 * 이 선택은 화면의 표시가 아니라 **계약이 읽는 값**이다 — 계약 발행이 이 표를 보고
 * 플래너를 정하고, 그 순간 `bookings.applied_planner_fee_rate_bp` 로 요율이 스냅샷된다
 * (D-16 · D-17). 그래서 화면이 "언제 실제로 걸리는가" 를 적는다.
 */
export const SCOPE_ENFORCED_AT = "contract_issue" as const;

export const SCOPE_ENFORCEMENT_NOTICE =
  "여기서 고른 카테고리는 **계약을 발행할 때 그대로 적용돼요.** 업체가 계약서를 만들 때 이 설정을 읽어 플래너를 정하고, 그 시점의 요율이 계약에 박힙니다.";

/** 요율이 없을 때. **0원이라고 적지 않는다**(함정 2 · O-02). */
export const SCOPE_RATE_UNKNOWN_NOTICE =
  "플래너 수수료율이 아직 설정되지 않아 금액을 계산할 수 없어요. 0원이라는 뜻이 아닙니다.";

export const SCOPE_NO_DELEGATION_TITLE = "먼저 플래너에게 권한을 위임해 주세요";

export const SCOPE_NO_DELEGATION_BODY =
  "카테고리를 맡기려면 그 플래너가 우리 정보를 볼 수 있어야 해요. 보지도 못하는 플래너에게 수수료가 붙으면 안 되기 때문입니다.";

/** 두 축을 잇는 문구. 위임 화면의 짝이다(D-43). */
export const SCOPE_CROSS_AXIS_NOTICE =
  "열람 위임과 이 설정은 서로 다른 축이에요. 위임을 거둬도 여기서 고른 카테고리는 그대로 남고, 반대로 여기서 빼도 열람 권한은 그대로입니다.";

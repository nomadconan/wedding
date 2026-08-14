/**
 * 플래너 프로필 · 마켓 (S6-02 · 명세서 §2.1 F-C-18, §3.7 planners, §6.2 /planners,
 * D-03 · D-18 · D-25, O-13)
 *
 * 프레임워크도 DB 도 모르는 순수 모듈이다.
 *
 * ── 플래너는 선택적 보조자다 (D-18) ─────────────────────────────────────────
 * 마켓은 **고르는 화면**이지 파는 화면이 아니다. 그래서 이 파일에는 "추천" 도
 * "프리미엄" 도 없다 — 순서는 실적 지표로만 정하고(D-25) 그 기준을 화면이 공개한다.
 *
 * **여기 없는 것 셋.**
 *  1. **요금.** `planner_fee_rates`(S5-01)가 갖는다. 프로필에 숫자를 따로 두면
 *     요율의 진실이 둘이 되고, 계약 시 스냅샷되는 값과 화면이 어긋난다(D-16).
 *     그래서 `fee_json` 을 **쓰지 않는다**(아래 `PROFILE_FIELDS` 에 없다).
 *  2. **랭킹 가중치.** O-13 미결이며 지어내지 않는다 — `scope.ts` 의
 *     `rankingMetricAvailability` 가 "지금 셀 수 있는 것" 을 이미 판정한다.
 *  3. **리뷰 점수.** `reviews` 는 업체 대상이라 플래너 후기 구조가 없다(S8-11).
 *     `planners.rating_avg` 컬럼은 있지만 **채우는 경로가 없으므로 쓰지 않는다** —
 *     0으로 보여주면 "평가가 나쁘다" 로 읽힌다.
 */

import { PLANNER_CATEGORIES, type PlannerCategory } from "./scope";

/** 입력이 규약을 벗어날 때 던진다. */
export class PlannerProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlannerProfileError";
  }
}

// =============================================================================
// 값 집합 — DB CHECK 와 같아야 한다 (`db:rls` 가 정합을 본다)
// =============================================================================

/**
 * 등록 상태.
 *
 * **업체 입점(S2-01)보다 가볍다.** 업체는 사업자등록번호·통신판매업 신고번호·서류
 * 심사가 필요하지만(F-V-01) 플래너는 **프리랜서 개인**이고 명세 F-C-18 도
 * "프로필·요금·리뷰" 까지만 적었다. 그래서 **서류를 받지 않는다.**
 *
 * 다만 **등록 즉시 마켓에 나가지는 않는다** — `planners_select_public`(0005)이
 * `status='active'` 만 공개하도록 이미 쓰여 있다. 빈 프로필이 그대로 노출되면
 * 고객은 마켓 전체를 신뢰하지 않게 된다.
 */
export const PLANNER_STATUSES = ["pending", "active", "paused", "rejected"] as const;
export type PlannerStatus = (typeof PLANNER_STATUSES)[number];

export const PLANNER_STATUS_LABEL: Record<PlannerStatus, string> = {
  pending: "검토 중",
  active: "공개 중",
  paused: "잠시 내림",
  rejected: "공개 보류",
};

export const PLANNER_STATUS_DETAIL: Record<PlannerStatus, string> = {
  pending: "프로필을 확인하고 있어요. 공개되면 알려드릴게요.",
  active: "마켓에 공개돼 고객이 찾을 수 있어요.",
  paused: "직접 내려 둔 상태예요. 언제든 다시 공개할 수 있어요.",
  rejected: "지금은 공개하지 않았어요. 프로필을 보완하면 다시 검토합니다.",
};

/** 마켓에 보이는가. 저장된 상태 하나로 정해진다. */
export function isListed(status: PlannerStatus): boolean {
  return status === "active";
}

// =============================================================================
// 프로필 — 요금은 담지 않는다
// =============================================================================

export type PlannerProfile = {
  headline: string;
  bio: string;
  careerYears: number;
  categories: PlannerCategory[];
  regions: string[];
};

/** 화면·API 가 다루는 필드. **`fee_json` 이 없다** — 요금은 요율 표가 갖는다. */
export const PROFILE_FIELDS = [
  "headline",
  "bio",
  "careerYears",
  "categories",
  "regions",
] as const;

export const HEADLINE_MAX = 60;
export const BIO_MAX = 1_000;
export const CAREER_YEARS_MAX = 60;

export type ProfileValidation = { ok: true } | { ok: false; field: string; detail: string };

/**
 * 프로필 검증.
 *
 * **경력을 검증으로 증명하지 않는다.** 자기 신고값이고 서류를 받지 않으므로
 * (위 `PLANNER_STATUSES` 주석), 화면이 "본인이 적은 값" 임을 밝힌다. 여기서 막는
 * 것은 **입력 사고**(음수·비정수·비현실적 값)뿐이다.
 *
 * **전문 카테고리는 `PLANNER_CATEGORIES` 안에서만** 고른다 — 과금 축과 같은 집합이라
 * 프로필에 있는 카테고리는 실제로 위임·선택이 가능한 것들이다.
 */
export function validateProfile(input: Partial<PlannerProfile>): ProfileValidation {
  const headline = (input.headline ?? "").trim();

  if (headline === "") {
    return { ok: false, field: "headline", detail: "한 줄 소개를 적어 주세요." };
  }

  if (headline.length > HEADLINE_MAX) {
    return { ok: false, field: "headline", detail: `한 줄 소개는 ${HEADLINE_MAX}자 이내로 적어 주세요.` };
  }

  if ((input.bio ?? "").length > BIO_MAX) {
    return { ok: false, field: "bio", detail: `소개는 ${BIO_MAX}자 이내로 적어 주세요.` };
  }

  const years = input.careerYears ?? 0;

  if (!Number.isInteger(years) || years < 0 || years > CAREER_YEARS_MAX) {
    return {
      ok: false,
      field: "careerYears",
      detail: `경력은 0~${CAREER_YEARS_MAX}년 사이의 정수로 적어 주세요.`,
    };
  }

  const categories = input.categories ?? [];

  if (categories.length === 0) {
    return { ok: false, field: "categories", detail: "맡을 수 있는 카테고리를 하나 이상 고르세요." };
  }

  for (const category of categories) {
    if (!(PLANNER_CATEGORIES as readonly string[]).includes(category)) {
      return { ok: false, field: "categories", detail: `다룰 수 없는 카테고리입니다: ${category}` };
    }
  }

  if (new Set(categories).size !== categories.length) {
    return { ok: false, field: "categories", detail: "같은 카테고리를 두 번 고를 수 없어요." };
  }

  if ((input.regions ?? []).length === 0) {
    return { ok: false, field: "regions", detail: "활동 지역을 하나 이상 고르세요." };
  }

  return { ok: true };
}

/**
 * 공개 신청을 할 수 있는가.
 *
 * **완성되지 않은 프로필을 마켓에 올리지 않는다.** 빈 프로필이 섞이면 고객은 마켓
 * 전체를 신뢰하지 않게 되고, 그 손해는 성실히 적은 플래너가 함께 진다.
 */
export function canRequestListing(input: Partial<PlannerProfile>): boolean {
  return validateProfile(input).ok;
}

export const LISTING_REQUIREMENT_NOTICE =
  "한 줄 소개·경력·카테고리·활동 지역을 모두 채우면 공개를 신청할 수 있어요.";

export const SELF_REPORTED_NOTICE =
  "경력과 소개는 플래너 본인이 적은 내용이에요. 상담 전에 직접 확인해 주세요.";

// =============================================================================
// 마켓 정렬 — 실적 지표로만 (D-25 · O-13)
// =============================================================================

/**
 * 정렬 기준.
 *
 * **`recommended` 가 없다.** 광고·제휴가 순서에 끼어들 자리를 아예 만들지 않는다
 * (§2.2 가 업체 목록에 세운 것과 같은 규칙 · D-03). `contracts` 만이 지금 셀 수 있는
 * 실적이고(S6-01 `rankingMetricAvailability`), 나머지 두 기준은 **실적이 아니라
 * 사실**이라 광고와 무관하다.
 */
export const MARKET_SORTS = ["contracts", "career", "recent"] as const;
export type MarketSort = (typeof MARKET_SORTS)[number];

export const MARKET_SORT_LABEL: Record<MarketSort, string> = {
  contracts: "계약 성사 많은 순",
  career: "경력 많은 순",
  recent: "최근 등록 순",
};

/**
 * 정렬 기준 코드를 **응답과 화면에 함께 내보낸다**(§2.2 · CLAUDE.md §2.2).
 *
 * "유료 노출 없음" 을 말로 주장하는 대신 **정렬 기준을 보여주는 것**이 증명이다.
 */
export const MARKET_SORT_BASIS_NOTICE =
  "플래너 순서는 실적과 사실 정보로만 정합니다. 광고·제휴는 순서에 반영되지 않아요.";

export type MarketRow = {
  id: string;
  careerYears: number;
  contractCount: number;
  createdAt: string;
};

/**
 * 마켓 정렬.
 *
 * **동점 처리를 고정한다.** 같은 값이면 최근 등록 순으로 갈라서, 목록을 새로 고칠
 * 때마다 순서가 흔들리지 않게 한다 — 흔들리면 고객은 순서를 신뢰하지 않고,
 * 플래너는 "왜 어제와 다른가" 를 묻는다.
 */
export function sortMarket<T extends MarketRow>(rows: readonly T[], sort: MarketSort): T[] {
  const byRecent = (a: T, b: T) => b.createdAt.localeCompare(a.createdAt);

  return [...rows].sort((a, b) => {
    if (sort === "contracts" && a.contractCount !== b.contractCount) {
      return b.contractCount - a.contractCount;
    }

    if (sort === "career" && a.careerYears !== b.careerYears) {
      return b.careerYears - a.careerYears;
    }

    return byRecent(a, b);
  });
}

/** 카테고리·지역 필터. 목록이 길어지면 고객은 고르지 못한다. */
export function filterMarket<T extends { categories: string[]; regions: string[] }>(
  rows: readonly T[],
  filter: { category?: string | null; region?: string | null },
): T[] {
  return rows.filter((row) => {
    if (filter.category && !row.categories.includes(filter.category)) return false;
    if (filter.region && !row.regions.includes(filter.region)) return false;

    return true;
  });
}

// =============================================================================
// 실적 표시 — 못 세는 것을 0으로 적지 않는다 (S6-01 이 세운 규칙)
// =============================================================================

export type MetricDisplay =
  | { kind: "value"; value: number }
  | { kind: "pending"; reason: string; owner: string };

/**
 * 마켓 카드에 실적을 어떻게 적는가.
 *
 * **셀 수 없는 지표를 0으로 적지 않는다.** 0은 "해 봤는데 없다" 는 뜻이고 지금
 * 필요한 표현은 "**아직 세지 않는다**" 다 — S2-08·S3-11·S6-01 이 세운 같은 규칙이다.
 * 특히 리뷰를 0으로 적으면 **평가가 나쁜 것처럼** 읽힌다.
 */
export function contractMetric(count: number): MetricDisplay {
  if (!Number.isInteger(count) || count < 0) {
    throw new PlannerProfileError(`계약 건수가 규약을 벗어났습니다: ${count}`);
  }

  return { kind: "value", value: count };
}

export function reviewMetric(): MetricDisplay {
  return {
    kind: "pending",
    reason: "플래너 후기는 아직 모으지 않아요.",
    owner: "S8-11",
  };
}

export const NEW_PLANNER_NOTICE =
  "아직 계약 실적이 없는 플래너예요. 실적만으로 판단하기 어려우니 상담으로 확인해 보세요.";

// =============================================================================
// 화면 문구
// =============================================================================

export const MARKET_TITLE = "플래너 찾기";

export const MARKET_EMPTY_TITLE = "조건에 맞는 플래너가 없어요";

export const MARKET_EMPTY_BODY = "카테고리나 지역 조건을 넓혀 보세요.";

export const PROFILE_TITLE = "플래너 프로필";

export const PROFILE_EMPTY_TITLE = "아직 프로필이 없어요";

export const PROFILE_EMPTY_BODY =
  "한 줄 소개와 맡을 수 있는 카테고리를 적으면 마켓 공개를 신청할 수 있어요.";

/**
 * **요금을 프로필에 적지 않는다는 사실을 화면이 말한다.**
 *
 * 플래너가 "왜 내 요금을 못 적나" 를 묻기 전에 답한다 — 요율은 계약 시점에
 * 스냅샷되는 값이라(D-16) 프로필에 적으면 화면과 실제 청구가 어긋난다.
 */
export const FEE_NOT_HERE_NOTICE =
  "요금은 프로필이 아니라 요율 설정에서 관리해요. 계약 시점의 요율이 그대로 적용되며, 나중에 요율이 바뀌어도 지난 계약에는 소급되지 않습니다.";

export const DELEGATION_NEXT_NOTICE =
  "마음에 드는 플래너를 찾았다면 권한 위임에서 볼 수 있는 범위와 기간을 정할 수 있어요.";

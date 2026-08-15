/**
 * 조건 부합도 랭킹 (S7-02 · 명세서 §5.5 3단계)
 *
 * **랭킹 기준을 숨기지 않는다**(D-03 · CLAUDE.md §2.2). 그래서 이 파일은 순서만 정하지 않고
 * **왜 그 순서인지**(`explainFit`)를 함께 낸다 — 화면은 그 설명을 카드마다 적는다. 기준을
 * 말할 수 없는 정렬은 유료 노출과 구분되지 않는다는 것이 이 제품의 전제다.
 *
 * **점수는 필터가 못 잡는 차이에만 붙인다.**
 * 예산·카테고리는 조회(§5.5 2단계)가 이미 하드 필터로 걸러서 남은 것은 전원 통과다.
 * 거기에 점수를 매기면 "통과했다" 를 두 번 세는 일이 되고, 순서에는 아무 정보도 더하지
 * 않으면서 기준만 복잡해진다.
 *
 * **미등록을 감점하지 않는다.** 재고 캘린더·수용 인원은 업체 선택 사항이다(S2-05·S2-03).
 * 안 적은 것을 깎으면 "등록 여부가 순서를 정하는" 노출 비대칭이 생기고, 그건 업체가 한
 * 일이 아니라 우리 쪽 사정이다(`EXPLORE_SORT_PENDING` 이 정렬을 안 여는 이유와 같은 결).
 * 그래서 확인된 사실에만 **가점**하고, 확인되지 않은 것은 0점으로 두고 화면에 '확인되지
 * 않음' 이라고 적는다.
 */

export const SEARCH_RANKING_CODES = ["condition_fit", "price_asc"] as const;

export type SearchRankingCode = (typeof SEARCH_RANKING_CODES)[number];

export type RankAvailabilityKind = "available" | "full" | "blocked" | "unknown";

export type RankCandidate = {
  productId: string;
  basePrice: number;
  regionCode: string | null;
  styleTags: string[];
  capacityMin: number | null;
  capacityMax: number | null;
  availabilityKind: RankAvailabilityKind;
};

export type RankFilter = {
  region: string | null;
  guestCount: number | null;
  date: string | null;
  styleTags: string[];
};

export const FIT_CRITERIA = ["region", "date", "guestCount", "styleTags"] as const;

export type FitCriterion = (typeof FIT_CRITERIA)[number];

/**
 * 가점표. **화면이 이 표를 그대로 보여준다** — 가중치를 코드 안에만 두면 사용자는
 * 순서를 확인할 방법이 없고, 그러면 배지가 증거 노릇을 못 한다.
 */
export const FIT_RULES: { criterion: FitCriterion; points: number; label: string }[] = [
  { criterion: "region", points: 2, label: "지역이 정확히 같으면 2점 (일부만 겹치면 1점)" },
  { criterion: "date", points: 3, label: "그날 자리가 확인되면 3점" },
  { criterion: "guestCount", points: 2, label: "하객 수를 수용한다고 밝혔으면 2점 (한쪽만 밝혔으면 1점)" },
  { criterion: "styleTags", points: 2, label: "요청한 스타일 태그 하나마다 2점" },
];

/** 동점일 때의 순서. **가격 낮은 순**이고 그것도 같으면 id 순이라 결과가 흔들리지 않는다. */
export const FIT_TIE_BREAK = "동점이면 가격이 낮은 순, 그것도 같으면 등록 순서입니다.";

export type FitDetail = {
  criterion: FitCriterion;
  points: number;
  /** 조건은 걸렸는데 확인할 자료가 없는 경우 null 이다. '아니오' 와 '모른다' 는 다르다. */
  matched: boolean | null;
  note: string;
};

export type FitScore = {
  score: number;
  max: number;
  details: FitDetail[];
};

function regionFit(candidate: RankCandidate, region: string): FitDetail {
  const code = (candidate.regionCode ?? "").trim();

  if (code === "") {
    return { criterion: "region", points: 0, matched: null, note: "업체가 지역을 적지 않았어요." };
  }

  if (code === region) {
    return { criterion: "region", points: 2, matched: true, note: `지역이 '${region}' 로 같아요.` };
  }

  if (code.includes(region)) {
    return { criterion: "region", points: 1, matched: true, note: `'${code}' 안에 '${region}' 이 들어 있어요.` };
  }

  return { criterion: "region", points: 0, matched: false, note: `업체 지역은 '${code}' 예요.` };
}

function dateFit(candidate: RankCandidate): FitDetail {
  switch (candidate.availabilityKind) {
    case "available":
      return { criterion: "date", points: 3, matched: true, note: "그날 자리가 있다고 등록돼 있어요." };
    case "full":
      return { criterion: "date", points: 0, matched: false, note: "그날은 자리가 찼어요." };
    case "blocked":
      return { criterion: "date", points: 0, matched: false, note: "그날은 쉬는 날로 등록돼 있어요." };
    case "unknown":
      return {
        criterion: "date",
        points: 0,
        matched: null,
        // 감점이 아니라 0점이다. 캘린더 미등록은 업체가 한 일이 아니라 선택 사항이다.
        note: "업체가 캘린더를 등록하지 않아 그날 자리는 확인할 수 없어요.",
      };
  }
}

function guestFit(candidate: RankCandidate, guestCount: number): FitDetail {
  const { capacityMin, capacityMax } = candidate;

  if (capacityMin === null && capacityMax === null) {
    return {
      criterion: "guestCount",
      points: 0,
      matched: null,
      note: "업체가 수용 인원을 적지 않았어요.",
    };
  }

  const overMin = capacityMin === null || capacityMin <= guestCount;
  const underMax = capacityMax === null || capacityMax >= guestCount;

  if (!overMin || !underMax) {
    return {
      criterion: "guestCount",
      points: 0,
      matched: false,
      note: `수용 인원은 ${capacityMin ?? "?"}~${capacityMax ?? "?"}명이에요.`,
    };
  }

  // 양쪽을 다 밝히고 그 안에 드는 것이 가장 확실한 부합이다.
  const both = capacityMin !== null && capacityMax !== null;

  return {
    criterion: "guestCount",
    points: both ? 2 : 1,
    matched: true,
    note: both
      ? `${guestCount}명은 수용 범위(${capacityMin}~${capacityMax}명) 안이에요.`
      : `${guestCount}명을 수용할 수 있다고 한쪽만 밝혔어요.`,
  };
}

function styleFit(candidate: RankCandidate, wanted: string[]): FitDetail {
  const matched = wanted.filter((tag) => candidate.styleTags.includes(tag));

  return {
    criterion: "styleTags",
    points: matched.length * 2,
    matched: matched.length > 0,
    note:
      matched.length === 0
        ? "요청한 스타일 태그가 없어요."
        : `요청한 스타일 ${wanted.length}개 중 ${matched.length}개가 겹쳐요.`,
  };
}

/**
 * 조건 부합도.
 *
 * **걸린 조건만 채점한다.** 사용자가 말하지 않은 것으로 순서를 만들면 그 순서는 설명할 수
 * 없는 것이 된다.
 */
export function scoreFit(candidate: RankCandidate, filter: RankFilter): FitScore {
  const details: FitDetail[] = [];
  let max = 0;

  if (filter.region !== null) {
    details.push(regionFit(candidate, filter.region));
    max += 2;
  }

  if (filter.date !== null) {
    details.push(dateFit(candidate));
    max += 3;
  }

  if (filter.guestCount !== null) {
    details.push(guestFit(candidate, filter.guestCount));
    max += 2;
  }

  if (filter.styleTags.length > 0) {
    details.push(styleFit(candidate, filter.styleTags));
    max += filter.styleTags.length * 2;
  }

  return { score: details.reduce((sum, detail) => sum + detail.points, 0), max, details };
}

/** 채점할 조건이 하나라도 걸렸는가. 없으면 부합도는 전부 0이라 순서를 만들지 못한다. */
export function hasRankableCondition(filter: RankFilter): boolean {
  return (
    filter.region !== null ||
    filter.date !== null ||
    filter.guestCount !== null ||
    filter.styleTags.length > 0
  );
}

/**
 * 이 검색에 **실제로 적용된** 랭킹 기준 코드.
 *
 * 채점할 조건이 없는데 `condition_fit` 이라고 적으면 그건 거짓말이다 — 그때 순서를 정하는
 * 것은 가격이다. **응답과 배지에는 실제로 순서를 정한 기준을 싣는다**(§5.5 4단계).
 */
export function rankingCodeFor(filter: RankFilter): SearchRankingCode {
  return hasRankableCondition(filter) ? "condition_fit" : "price_asc";
}

/**
 * 순서. 반환값은 **상품 id 의 나열**이다 — 조회 계층(`lib/explore/query.ts`)이 이 순서로
 * 행을 다시 세운다. 여기서 DB 행 타입을 알 필요가 없어야 `lib/core` 가 프레임워크·DB 를
 * 모른 채로 남는다(CLAUDE.md §3.1).
 */
export function rankByFit(candidates: RankCandidate[], filter: RankFilter): string[] {
  const scored = candidates.map((candidate) => ({
    candidate,
    score: hasRankableCondition(filter) ? scoreFit(candidate, filter).score : 0,
  }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.candidate.basePrice !== b.candidate.basePrice) {
      return a.candidate.basePrice - b.candidate.basePrice;
    }

    return a.candidate.productId.localeCompare(b.candidate.productId);
  });

  return scored.map((entry) => entry.candidate.productId);
}

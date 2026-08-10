// 참가격 인덱스 산출 (S3-08 · 명세서 §2.1 F-C-09, §3.3 price_index)
//
//  * 순수 함수다. DB 도 React 도 모른다.
//  * **정수 연산만** 쓴다. 백분위는 보간하지 않으므로 나눗셈으로 만든 소수가 없다.
//  * 같은 표본이면 항상 같은 결과여야 한다 — 정렬과 순위 계산이 전순서다.
//
// ── 지금 넣을 수 있는 것과 없는 것 ───────────────────────────────────────────
// F-C-09 는 "거래 데이터 축적 후 **실거래가 기반 갱신**" 이라고 쓴다. 거래는 5단계라
// 지금 있는 표본은 **업체가 등록한 판매가**뿐이다. 그 둘은 다른 값이다 — 등록가는
// 업체가 부르는 값이고 실거래가는 실제로 오간 값이다.
//
// 그래서 이 모듈은 **어떤 표본으로 만든 지수인지를 값으로 갖는다**(`sourceType`).
// 화면은 그것을 큰 글씨로 말한다. 출처를 밝히지 않은 지수는 신뢰의 근거가 아니라
// 또 하나의 불투명한 숫자다.

/** 표본의 성격. `price_index.source_type` 에 그대로 들어간다. */
export const PRICE_INDEX_SOURCE_TYPES = ["registered_price", "transaction"] as const;

export type PriceIndexSourceType = (typeof PRICE_INDEX_SOURCE_TYPES)[number];

export const PRICE_INDEX_SOURCE_LABEL: Record<PriceIndexSourceType, string> = {
  registered_price: "업체가 등록한 판매가",
  transaction: "실제 거래된 금액",
};

/**
 * 출처별 한 줄 설명. **화면에서 접거나 숨기지 않는다.**
 * 지수를 보는 사람이 가장 먼저 알아야 할 사실이 "이게 무엇으로 만든 숫자인가" 다.
 */
export const PRICE_INDEX_SOURCE_NOTE: Record<PriceIndexSourceType, string> = {
  registered_price:
    "업체가 등록해 공개한 판매가를 모은 값입니다. 실제 계약 금액이 아니며, 할인·추가금에 따라 달라질 수 있어요.",
  transaction: "실제 체결된 계약 금액을 모은 값입니다.",
};

/**
 * 구간을 나누지 않았다는 표시.
 *
 * `price_index` 는 하객수·시즌 구간을 컬럼으로 갖지만(F-C-09), 등록 판매가에는 예식일도
 * 하객수도 없다. 상품의 수용 범위(100~300명)로 구간을 만들면 한 상품이 여러 구간에
 * 걸치므로 **없는 구분을 지어내는 일**이 된다. 실거래가 적재(5단계) 때 실제 예식일·
 * 하객수로 나눈다.
 */
export const PRICE_INDEX_ALL = "all";

/**
 * 표본 하한 5곳. S2-08 의 `PRICE_POSITION_MIN_SAMPLE` 과 **같은 값**이다.
 *
 * **다만 이유가 다르다.** S2-08 은 재식별 방지였다 — 표본이 적으면 분포에서 개별
 * 업체 가격을 역산할 수 있어서다. 여기서 숨길 것은 없다. 등록 판매가는 이미 탐색
 * 화면에서 누구나 보는 **공개 정보**이고, 그것을 모아 사분위를 내는 것이 F-C-09 다.
 *
 * 여기서 하한을 두는 이유는 **대표성**이다. 표본 두세 곳의 사분위는 통계가 아니라
 * 우연이고, 그것을 '참가격' 이라 부르면 우리가 없애려는 종류의 잘못된 가격 신호를
 * 우리가 만들게 된다. 값을 5로 맞춘 것은 같은 제품 안에서 "몇 곳부터 통계로
 * 말하는가" 의 답이 화면마다 달라지면 안 되기 때문이다.
 */
export const PRICE_INDEX_MIN_SAMPLE = 5;

/** 표본 한 건. 업체 단위로 접기 전의 원자료다. */
export type PriceSample = {
  vendorId: string;
  price: number;
  /** 표본 추적용(`price_sources`). 계산에는 쓰지 않는다. */
  productId?: string;
};

export type PriceIndexResult =
  | {
      ok: true;
      p25: number;
      p50: number;
      p75: number;
      /** 업체 수. 상품 수가 아니다. */
      sampleSize: number;
      /** 각 업체의 대표 표본. `price_sources` 에 그대로 남긴다. */
      representatives: PriceSample[];
    }
  | { ok: false; reason: "insufficient_sample"; sampleSize: number };

/**
 * **업체당 한 건만 표본에 넣는다**(S2-08 과 같은 방식).
 *
 * 한 업체가 상품을 열 개 올리면 그 업체 하나가 분포를 지배한다. 그러면 지수는
 * 시장이 아니라 부지런한 업체 한 곳을 말하게 된다.
 *
 * 대표값은 **그 업체의 최저 판매가**다 — 고객이 그 업체에서 낼 수 있는 가장 낮은
 * 총액이고, "이 지역에서 얼마부터 시작하나" 라는 질문에 답하는 값이다.
 * 같은 금액이면 `productId` 로 갈라 결과가 흔들리지 않게 한다.
 */
export function vendorRepresentatives(samples: readonly PriceSample[]): PriceSample[] {
  const byVendor = new Map<string, PriceSample>();

  for (const sample of samples) {
    if (!Number.isInteger(sample.price) || sample.price < 0) {
      throw new RangeError("표본 금액은 0 이상 정수여야 합니다.");
    }

    const current = byVendor.get(sample.vendorId);

    if (
      current === undefined ||
      sample.price < current.price ||
      (sample.price === current.price && (sample.productId ?? "") < (current.productId ?? ""))
    ) {
      byVendor.set(sample.vendorId, sample);
    }
  }

  return [...byVendor.values()].sort((a, b) =>
    a.price === b.price ? a.vendorId.localeCompare(b.vendorId) : a.price - b.price,
  );
}

/**
 * 백분위. **보간하지 않는다**(nearest-rank).
 *
 * 두 값의 중간을 취하면 아무도 부르지 않는 금액이 지수로 나간다. 여기서 내보내는
 * 사분위는 전부 **실제로 등록된 금액**이며, 그래야 "이 값이 어디서 왔나" 를 끝까지
 * 추적할 수 있다(`price_sources`). 정수 나눗셈만 쓰므로 부동소수점도 끼어들지 않는다.
 *
 * 순위 = ceil(percentileBp × n / 10000), 최소 1, 최대 n.
 */
export function percentileAt(sortedPrices: readonly number[], percentileBp: number): number {
  if (sortedPrices.length === 0) throw new RangeError("표본이 비어 있습니다.");
  if (percentileBp < 0 || percentileBp > 10_000) {
    throw new RangeError("백분위는 0 ~ 10000 bp 범위여야 합니다.");
  }

  const n = sortedPrices.length;
  const rank = Math.min(n, Math.max(1, Math.ceil((percentileBp * n) / 10_000)));

  return sortedPrices[rank - 1];
}

/**
 * 지수 한 칸을 만든다.
 *
 * 표본이 하한에 못 미치면 **값을 만들지 않는다.** 부족한 표본으로 낸 사분위를
 * 내보내면 화면이 "이 지역 시세는 이렇다" 고 말하게 되는데 그건 사실이 아니다.
 */
export function buildPriceIndex(samples: readonly PriceSample[]): PriceIndexResult {
  const representatives = vendorRepresentatives(samples);
  const sampleSize = representatives.length;

  if (sampleSize < PRICE_INDEX_MIN_SAMPLE) {
    return { ok: false, reason: "insufficient_sample", sampleSize };
  }

  const prices = representatives.map((sample) => sample.price);

  return {
    ok: true,
    p25: percentileAt(prices, 2500),
    p50: percentileAt(prices, 5000),
    p75: percentileAt(prices, 7500),
    sampleSize,
    representatives,
  };
}

export const INSUFFICIENT_SAMPLE_NOTICE =
  `표본이 ${PRICE_INDEX_MIN_SAMPLE}곳 이상 모이면 가격 분포를 보여드려요. 적은 표본으로 낸 값은 시세가 아니라 우연입니다.`;

// =============================================================================
// 지수 대비 편차 — /explore 의 price_index_gap 정렬 (S3-03 · F-C-10)
// =============================================================================

/**
 * 중앙값 대비 편차(bp). 음수면 지수보다 싸다.
 *
 * **기준이 없으면 값도 없다.** 지수가 없는 지역·카테고리의 업체에 0을 주면
 * "딱 중간값" 이라는 없는 사실을 말하게 되고, 정렬에서도 한가운데에 끼어든다.
 */
export function priceGapBp(price: number, p50: number | null): number | null {
  if (p50 === null || p50 <= 0) return null;
  if (!Number.isInteger(price) || price < 0) {
    throw new RangeError("금액은 0 이상 정수여야 합니다.");
  }

  return Math.round(((price - p50) * 10_000) / p50);
}

/**
 * 지수 대비 정렬. **기준이 없는 항목은 빼지 않고 맨 뒤에 둔다.**
 *
 * 빼면 "지수가 있는 지역의 업체가 유리해지는" 노출 비대칭이 생긴다. 지수가 없는 것은
 * 업체가 한 일이 아니라 아직 표본이 모이지 않았다는 우리 쪽 사정이다
 * (S3-03 에서 재고 캘린더를 안 올린 업체를 목록에서 빼지 않기로 한 것과 같은 판단).
 * 대신 화면이 '비교 기준 없음' 이라고 적는다.
 */
export function compareByGap<T extends { id: string; gapBp: number | null }>(
  a: T,
  b: T,
): number {
  if (a.gapBp === null && b.gapBp === null) return a.id < b.id ? -1 : 1;
  if (a.gapBp === null) return 1;
  if (b.gapBp === null) return -1;
  if (a.gapBp !== b.gapBp) return a.gapBp - b.gapBp;

  return a.id < b.id ? -1 : 1;
}

export const NO_INDEX_BASELINE_NOTE = "이 지역·카테고리는 아직 비교 기준이 없어요.";

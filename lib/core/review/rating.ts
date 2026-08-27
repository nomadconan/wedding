// 검증 후기 평점 산정 (S8-11 · F-C-17 · F-V-11 "평점 산정 기준 공개")
//
// ══════════════════════════════════════════════════════════════════════════
// **평균은 건수와 함께가 아니면 나가지 않는다.**
// ══════════════════════════════════════════════════════════════════════════
//
// 후기 한 건짜리 5.0 과 백 건짜리 4.6 을 같은 자리에 "5.0" · "4.6" 으로 적으면
// 화면은 앞의 업체가 더 낫다고 말한 것이 된다. 그래서 이 파일의 반환 타입에는
// 평균만 담긴 값이 없다 — `sampleSize` 가 항상 붙어 있고, 표본이 0이면 평균은
// `null` 이다. **0.0 을 만들지 않는다**(0점은 "최악" 으로 읽힌다 · D-96·D-108 과
// 같은 규칙이며 `planners.rating_avg` 를 쓰지 않기로 한 이유이기도 하다).
//
// **표본 하한을 두지 않았다.** "몇 건부터 믿을 만한가" 는 우리가 정할 근거가 없는
// 숫자이고, 하한을 두면 그 아래 업체의 평점이 **없는 것처럼** 보인다. 대신 건수를
// 숨기지 않는다 — 판단은 보는 사람이 한다.
//
// **가중치를 정하지 않았다.** 세 축(가격 투명성·응대·이행)을 균등하게 본다.
// 어느 축을 더 무겁게 두는 순간 그 선택이 랭킹에 개입하고, 우리는 광고를 받지 않는
// 대신 순서의 근거를 밝히기로 한 서비스다(D-03 · CLAUDE.md §2.2). 균등 가중은
// "가중치를 정하지 않았다" 의 가장 정직한 표현이며, **그 사실을 코드가 밝힌다**
// (`RATING_BASIS`). 화면과 API 가 이 기준을 값과 함께 내보낸다.

/** 평점 축. 순서가 화면 표시 순서다. */
export const RATING_AXES = ["price", "response", "fulfillment"] as const;
export type RatingAxis = (typeof RATING_AXES)[number];

export const RATING_AXIS_LABEL: Record<RatingAxis, string> = {
  price: "가격 투명성",
  response: "응대",
  fulfillment: "이행",
};

export const RATING_MIN = 1;
export const RATING_MAX = 5;

/**
 * 산정 기준 (F-V-11 "평점 산정 기준 공개").
 *
 * **코드를 붙인다.** 규칙이 바뀌면 코드가 바뀌고, 그러면 "그때 무엇으로 냈나" 를
 * 답할 수 있다(정렬 기준 코드를 응답에 싣는 규칙과 같은 결이다).
 */
export const RATING_BASIS = {
  code: "verified_equal_weight_v1",
  label: "검증 후기 · 균등 가중",
  rules: [
    "확정·이행된 예약이 있는 사람만 후기를 쓸 수 있습니다(작성 자격은 DB 가 강제합니다).",
    "공개 상태이고 작성자가 거두지 않은 후기만 셉니다.",
    "가격 투명성·응대·이행 세 축을 균등하게(1:1:1) 봅니다.",
    "표본 하한을 두지 않습니다. 대신 건수를 항상 함께 표시합니다.",
    "운영자가 비공개한 후기는 셈에서 빠집니다.",
    "광고·제휴로 평점이 올라가는 경로는 없습니다.",
  ],
} as const;

/** 셈에 쓰는 후기 한 건. 본문·작성자는 평점과 무관하므로 받지 않는다. */
export type RatingSample = {
  scorePrice: number | null;
  scoreResponse: number | null;
  scoreFulfillment: number | null;
};

/** 축 하나의 셈 결과. 평균만 따로 꺼내 쓸 수 없게 건수와 한 덩어리다. */
export type AxisRating = {
  axis: RatingAxis;
  /** 표본이 없으면 null. **0 이 아니다.** */
  average: number | null;
  /** 이 축에 점수를 남긴 후기 수. 축마다 다를 수 있다(점수는 선택 입력이다). */
  sampleSize: number;
};

export type VendorRating = {
  /** 세 축 균등. 어느 축도 점수가 없으면 null. */
  overall: number | null;
  /** 종합의 분모 — **후기 수**다(축별 표본 수의 합이 아니다). */
  reviewCount: number;
  axes: AxisRating[];
  basis: typeof RATING_BASIS;
};

/** 소수 첫째 자리. 표시용 반올림을 셈 단계에서 한 번만 한다. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function axisValue(sample: RatingSample, axis: RatingAxis): number | null {
  if (axis === "price") return sample.scorePrice;
  if (axis === "response") return sample.scoreResponse;

  return sample.scoreFulfillment;
}

/** 유효한 점수인가. 범위 밖·정수 아님은 DB CHECK 이 막지만 여기서도 세지 않는다. */
function usable(score: number | null): score is number {
  return score !== null && Number.isInteger(score) && score >= RATING_MIN && score <= RATING_MAX;
}

function rateAxis(samples: readonly RatingSample[], axis: RatingAxis): AxisRating {
  const scores = samples.map((sample) => axisValue(sample, axis)).filter(usable);

  if (scores.length === 0) return { axis, average: null, sampleSize: 0 };

  const sum = scores.reduce((acc, score) => acc + score, 0);

  return { axis, average: round1(sum / scores.length), sampleSize: scores.length };
}

/**
 * 후기 묶음에서 평점을 낸다.
 *
 * **종합은 후기 하나를 먼저 축약한 뒤 평균 낸다** — 축별 평균을 다시 평균 내면
 * 축마다 응답 수가 다를 때 응답이 적은 축이 과대 대표된다(응대에만 답한 한 사람이
 * 종합의 1/3 을 가져간다). 후기 단위로 먼저 접으면 **한 사람이 한 표**다.
 *
 * 점수를 하나도 남기지 않은 후기는 종합의 분모에서 빠진다 — 본문만 쓴 후기이며
 * 평가로 셀 값이 없다.
 */
export function rateVendor(samples: readonly RatingSample[]): VendorRating {
  const axes = RATING_AXES.map((axis) => rateAxis(samples, axis));

  const perReview = samples
    .map((sample) => {
      const scores = RATING_AXES.map((axis) => axisValue(sample, axis)).filter(usable);
      if (scores.length === 0) return null;

      return scores.reduce((acc, score) => acc + score, 0) / scores.length;
    })
    .filter((value): value is number => value !== null);

  return {
    overall: perReview.length === 0
      ? null
      : round1(perReview.reduce((acc, value) => acc + value, 0) / perReview.length),
    reviewCount: perReview.length,
    axes,
    basis: RATING_BASIS,
  };
}

/**
 * 화면이 평균 옆에 반드시 적어야 하는 문장.
 *
 * **평균만 그리는 화면을 만들 수 없게** 문장까지 여기서 만든다 — 문구를 화면마다
 * 손으로 적으면 한 곳이 빠지고, 빠진 화면은 표본 하나짜리 평점을 확정된 사실처럼
 * 보여준다.
 */
export function ratingCaption(rating: VendorRating): string {
  if (rating.reviewCount === 0) return "아직 검증 후기가 없습니다.";

  return `검증 후기 ${rating.reviewCount}건 기준 · ${RATING_BASIS.label}`;
}

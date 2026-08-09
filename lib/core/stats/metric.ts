// 지표 값 (S2-08 · 명세서 §2.2 F-V-12)
//
// **"0건"과 "아직 측정하지 않음"은 다르다.**
// F-V-12 는 노출→문의→상담→계약 퍼널을 요구하지만 문의(4단계)·계약(5단계)이 아직 없다.
// 이때 0을 보여주면 업체는 "문의가 0건 왔다"고 읽는다. 실제로는 **문의를 받을 수단이
// 아직 없는 것**이고, 그 둘은 업체가 내릴 판단이 완전히 다르다.
// (S2-04 의 '추가금 없음' vs '미등록' 과 같은 원칙이다.)
//
// 그래서 지표는 숫자가 아니라 **상태를 가진 값**이다.
//   measured    지금 실제로 센 값
//   not_yet     아직 측정할 수단이 없다. 어느 단계에서 채워지는지 함께 적는다
//   restricted  권한이 없어 가리는 값(정산 등, §3.9)

export type MetricValue<T = number> =
  | { status: "measured"; value: T }
  /** `filledBy` 는 이 지표가 채워지는 태스크 ID 다. 화면이 근거로 그대로 보여준다. */
  | { status: "not_yet"; reason: string; filledBy: string }
  | { status: "restricted"; reason: string };

export function measured<T>(value: T): MetricValue<T> {
  return { status: "measured", value };
}

export function notYet<T = number>(reason: string, filledBy: string): MetricValue<T> {
  return { status: "not_yet", reason, filledBy };
}

export function restricted<T = number>(reason: string): MetricValue<T> {
  return { status: "restricted", reason };
}

export function isMeasured<T>(metric: MetricValue<T>): metric is { status: "measured"; value: T } {
  return metric.status === "measured";
}

/**
 * 슬롯 소진율.
 *
 * (정원 합 - 잔여 합) / 정원 합 을 **basis point 정수**로 돌려준다.
 * 정원이 0이면 나눌 수 없으므로 **측정 불가**다 — 0%로 적으면 "다 비어 있다"로 읽힌다.
 *
 * 막힌(blocked) 슬롯은 제외한다. 팔 수 없는 자리를 분모에 넣으면 소진율이 실제보다 낮게 나온다.
 */
export function slotUtilizationBp(
  slots: { capacity: number; remaining: number; status: string }[],
): MetricValue<number> {
  const sellable = slots.filter((slot) => slot.status !== "blocked");
  const capacity = sellable.reduce((sum, slot) => sum + slot.capacity, 0);

  if (capacity === 0) {
    return notYet("판매 가능한 슬롯이 없어 소진율을 계산할 수 없습니다.", "S2-05");
  }

  const remaining = sellable.reduce((sum, slot) => sum + slot.remaining, 0);

  return measured(Math.round(((capacity - remaining) * 10_000) / capacity));
}

/** 프로필에서 채워야 할 항목. 대시보드가 "지금 할 일"로 보여준다. */
export type ProfileGap = { field: string; label: string };

export function profileGaps(profile: {
  address: string | null;
  capacityMax: number | null;
  facilities: string[] | null;
  intro: string | null;
  mediaCount: number;
}): ProfileGap[] {
  const gaps: ProfileGap[] = [];

  if (!profile.address) gaps.push({ field: "address", label: "주소를 입력해 주세요." });
  if (profile.capacityMax === null) {
    gaps.push({ field: "capacityMax", label: "수용 인원을 입력해 주세요." });
  }
  if (!profile.facilities || profile.facilities.length === 0) {
    gaps.push({ field: "facilities", label: "시설·포함 서비스를 선택해 주세요." });
  }
  if (!profile.intro) gaps.push({ field: "intro", label: "소개문을 작성해 주세요." });
  if (profile.mediaCount === 0) gaps.push({ field: "media", label: "사진을 1장 이상 올려 주세요." });

  return gaps;
}

/**
 * 지역 내 가격 포지션 — **표본이 적으면 보여주지 않는다.**
 *
 * §7.7: 타 업체를 특정하지 않는다. 표본이 3~4건이면 분포에서 개별 업체의 가격을
 * 역산하기 쉽다. 그래서
 *   * **자기를 뺀 표본이 5건 이상**일 때만 계산하고,
 *   * 결과로 **백분위 위치와 표본 수만** 돌려준다. 개별 가격도, 중앙값 금액도 내보내지 않는다.
 *     (n=5 에서 중앙값을 노출하면 그것이 곧 특정 업체의 가격이다.)
 */
export const PRICE_POSITION_MIN_SAMPLE = 5;

export function pricePositionBp(
  myPrice: number,
  otherPrices: number[],
): MetricValue<{ percentileBp: number; sampleSize: number }> {
  if (otherPrices.length < PRICE_POSITION_MIN_SAMPLE) {
    return notYet(
      `같은 지역·카테고리에 비교할 업체가 ${PRICE_POSITION_MIN_SAMPLE}곳 이상 있어야 표시합니다. 지금은 ${otherPrices.length}곳입니다.`,
      "S3-03",
    );
  }

  const cheaper = otherPrices.filter((price) => price < myPrice).length;

  return measured({
    // 내 가격보다 싼 업체의 비율. 100% 에 가까울수록 비싼 편이다.
    percentileBp: Math.round((cheaper * 10_000) / otherPrices.length),
    sampleSize: otherPrices.length,
  });
}

/** bp 를 사람이 읽는 퍼센트로. 표시 전용이다. */
export function bpToPercent(bp: number): number {
  return Math.round(bp / 100);
}

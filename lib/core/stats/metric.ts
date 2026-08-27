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
//   undecided   **셀 수는 있지만 무엇을 셀지가 안 정해졌다**(S8-01 이 더했다)
//   no_basis    **모수가 없어 비율을 만들 수 없다**(S8-01 이 더했다)
//
// ── S8-01 이 둘을 더한 이유 ─────────────────────────────────────────────────
// 운영자 대시보드에서 **셋이 화면에서 같은 얼굴로 겹쳐 읽힌다**:
//   (가) 실제로 0건이었다
//   (나) 기준이 미결이라 계산 자체를 하지 않는다 (수수료 수익 · O-15 `settlement.fee_basis`)
//   (다) 분모가 0이라 비율이 정의되지 않는다 (문의 0건일 때의 문의→예약 전환율)
// (가)를 (나)로 읽으면 운영자는 멀쩡한 지표를 고장으로 본다. (나)를 (가)로 읽으면
// **미결정이 조용히 확정된다** — "수수료 수익 0원" 은 요율 기준이 정해졌다는 뜻이 된다
// (CLAUDE.md §7.6 · O-15). (다)를 0% 로 적으면 "아무도 예약 안 했다" 로 읽힌다.
// `not_yet`(기능이 아직 없다)과도 다르다 — 여기는 **기능은 서 있다.**

export type MetricValue<T = number> =
  | { status: "measured"; value: T }
  /** `filledBy` 는 이 지표가 채워지는 태스크 ID 다. 화면이 근거로 그대로 보여준다. */
  | { status: "not_yet"; reason: string; filledBy: string }
  | { status: "restricted"; reason: string }
  /** `openIssue` 는 O-번호다. 값이 정해지면 계산이 그대로 돈다. */
  | { status: "undecided"; reason: string; openIssue: string }
  /** `basisLabel` 은 없는 그 모수의 이름이다("문의" 등). */
  | { status: "no_basis"; reason: string; basisLabel: string };

export function measured<T>(value: T): MetricValue<T> {
  return { status: "measured", value };
}

export function notYet<T = number>(reason: string, filledBy: string): MetricValue<T> {
  return { status: "not_yet", reason, filledBy };
}

export function restricted<T = number>(reason: string): MetricValue<T> {
  return { status: "restricted", reason };
}

/**
 * 기준이 미결이라 계산하지 않는 값.
 *
 * **0 을 돌려주지 않는다.** 0 은 "정해진 기준으로 계산했더니 0" 이라는 뜻이고,
 * 그렇게 적는 순간 미결정이 확정된 것처럼 보인다(CLAUDE.md §7.6).
 */
export function undecided<T = number>(reason: string, openIssue: string): MetricValue<T> {
  return { status: "undecided", reason, openIssue };
}

/**
 * 분모가 0이라 정의되지 않는 비율.
 *
 * **0% 로 적지 않는다.** "문의 0건 중 0건 예약" 을 0% 로 적으면 "문의는 왔는데 아무도
 * 예약하지 않았다" 로 읽힌다 — 정반대의 판단을 부른다.
 */
export function noBasis<T = number>(reason: string, basisLabel: string): MetricValue<T> {
  return { status: "no_basis", reason, basisLabel };
}

export function isMeasured<T>(metric: MetricValue<T>): metric is { status: "measured"; value: T } {
  return metric.status === "measured";
}

/** 화면이 붙일 배지 문구. 다섯 상태가 각각 다른 얼굴을 갖게 한다. */
export const METRIC_STATUS_LABEL: Record<MetricValue["status"], string> = {
  measured: "집계됨",
  not_yet: "집계 대상 없음",
  restricted: "권한 없음",
  undecided: "기준 미확정",
  no_basis: "모수 없음",
};

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

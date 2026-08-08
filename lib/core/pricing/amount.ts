// 금액 값 (S5-02)
//
//  * 금액은 원 단위 **정수**다. 부동소수점 누산을 하지 않는다.
//  * "아직 정해지지 않았다"는 `0` 과 **다른 값**이다. 확정된 0원과 미정을 같은 값으로 다루면
//    화면에서 "추가금 없음" 과 "업체가 등록하지 않았다" 가 구별되지 않는다.
//  * 미정을 `null`·`undefined` 로 표현하지 않는다 — 값을 안 넘긴 실수와 구별되지 않아
//    누락이 조용히 미정으로 흘러간다. 미정은 **명시적으로 선언**해야 한다.
//
// 화면(`components/domain/PriceDisplay`)이 이 sentinel 을 그대로 받는다.

/** 미정 금액 sentinel. */
export const AMOUNT_UNKNOWN = "unknown";

/** 금액 값. 확정된 정수이거나 명시적 미정이다. */
export type Amount = number | typeof AMOUNT_UNKNOWN;

/** 미정인가. `0` 은 확정된 값이므로 false 다. */
export function isUnknownAmount(value: Amount): value is typeof AMOUNT_UNKNOWN {
  return value === AMOUNT_UNKNOWN;
}

/**
 * 금액을 더한다. **하나라도 미정이면 합계도 미정**이다.
 *
 * 미정을 0으로 취급해 더하면 총액이 실제보다 작게 나온다.
 * 가격 정찰제에서 이 방향의 오차는 고객을 오인시키므로 허용하지 않는다.
 */
export function sumAmounts(values: readonly Amount[]): Amount {
  let total = 0;

  for (const value of values) {
    if (isUnknownAmount(value)) return AMOUNT_UNKNOWN;
    total += value;
  }

  return total;
}

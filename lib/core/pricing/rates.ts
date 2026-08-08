// 요율 해석 엔진 (S5-02 · 명세서 §3.8 요율 해석 규칙, D-16 · D-17)
//
//  * **순수 함수다.** DB 에 접근하지 않고 요율 레코드를 인자로 받는다.
//  * **요율 값을 이 파일에 쓰지 않는다.** 전역 기본값조차 코드가 아니라 DB(app_settings)에서
//    읽는다(O-02). 후보가 없으면 임의 기본값을 만들지 않고 **명시적으로 실패**를 반환한다.
//  * 계산은 basis point 정수 연산만 쓴다 — penalty.ts 와 같은 방식이다.
//
// 해석 규칙(§3.8)
//   1) 좁은 범위가 넓은 범위를 이긴다.  vendor(planner) → category → global
//   2) 적용 구간은 [effectiveFrom, effectiveTo) 반개구간이다. effectiveTo=null 이면 무기한.
//   3) 요율 변경은 새 행 추가이므로, 과거 시점으로 조회하면 그때의 요율이 그대로 나온다.

import {
  PlannerFeeInputSchema,
  RateQuerySchema,
  RateRecordSchema,
  SettlementInputSchema,
  type PlannerFeeInput,
  type RateQuery,
  type RateRecord,
  type RateScope,
  type SettlementInput,
  type SettlementResult,
} from "../schemas/rates";

export {
  COMMISSION_SCOPE_ORDER,
  PLANNER_FEE_SCOPE_ORDER,
  RATE_SCOPES,
  type RateQuery,
  type RateRecord,
  type RateScope,
} from "../schemas/rates";

/** 금액·요율 입력이 규약을 벗어날 때 던진다. */
export class RateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateError";
  }
}

/** 요율 해석 실패 사유. */
export type RateResolutionFailure =
  /** 어느 스코프에서도 유효 요율이 없다. 계약 확정을 막고 운영자에게 경보한다(§3.8). */
  | "no_matching_rate"
  /** 같은 스코프·같은 구체성에서 기간이 겹치는 행이 둘 이상이다. DB EXCLUDE 가 막지만 방어한다. */
  | "ambiguous_rate";

export type RateResolution =
  | {
      ok: true;
      feeRateBp: number;
      scopeType: RateScope;
      scopeKey: string | null;
      record: RateRecord;
    }
  | {
      ok: false;
      reason: RateResolutionFailure;
      /** 사람이 읽는 설명. 화면에 그대로 쓰지 말고 로그·운영 경보에 쓴다. */
      detail: string;
      /** ambiguous_rate 일 때 충돌한 레코드. 운영이 어느 행을 지울지 판단하는 근거다. */
      conflicts?: RateRecord[];
    };

/** 시점이 [from, to) 안에 드는가. to 가 null 이면 무기한이다. */
function isEffectiveAt(record: RateRecord, atMs: number): boolean {
  const from = Date.parse(record.effectiveFrom);
  if (atMs < from) return false;

  if (record.effectiveTo === null) return true;

  return atMs < Date.parse(record.effectiveTo);
}

/**
 * 서비스 등급 일치 판정.
 *
 * 등급을 지정해 조회하면 **등급이 정확히 같은 행이 등급 무관(null) 행을 이긴다.**
 * 등급을 지정하지 않으면 등급 무관 행만 후보다 — 지정하지 않은 조회가
 * 특정 등급 요율을 집어오면 조회 조건과 다른 값이 나간다.
 */
function serviceLevelRank(record: RateRecord, serviceLevel: string | null): number | null {
  const recordLevel = record.serviceLevel ?? null;

  if (serviceLevel !== null && recordLevel === serviceLevel) return 0;
  if (recordLevel === null) return 1;

  return null;
}

/**
 * 적용 요율을 해석한다.
 *
 * @param records 후보 요율 레코드. commission_rates 또는 planner_fee_rates 의 행.
 * @param query   후보 스코프(우선순위 순)·스코프별 키·조회 시점·서비스 등급.
 */
export function resolveRate(records: readonly RateRecord[], query: RateQuery): RateResolution {
  const parsedQuery = RateQuerySchema.parse(query);
  const parsedRecords = records.map((record) => RateRecordSchema.parse(record));

  const atMs = Date.parse(parsedQuery.at);
  const serviceLevel = parsedQuery.serviceLevel ?? null;

  for (const scopeType of parsedQuery.scopeCandidates) {
    const scopeKey = scopeType === "global" ? null : (parsedQuery.scopeKeys[scopeType] ?? null);

    // global 이 아닌 스코프인데 조회 키가 없으면 그 단계는 건너뛴다.
    // (예: 카테고리를 모르는 조회에서 category 단계를 조용히 넘어간다)
    if (scopeType !== "global" && scopeKey === null) continue;

    const matched = parsedRecords.filter(
      (record) =>
        record.scopeType === scopeType &&
        record.scopeKey === scopeKey &&
        isEffectiveAt(record, atMs) &&
        serviceLevelRank(record, serviceLevel) !== null,
    );

    if (matched.length === 0) continue;

    // 등급 일치(0) 가 등급 무관(1) 을 이긴다.
    const bestRank = Math.min(...matched.map((record) => serviceLevelRank(record, serviceLevel) ?? 1));
    const finalists = matched.filter(
      (record) => (serviceLevelRank(record, serviceLevel) ?? 1) === bestRank,
    );

    if (finalists.length > 1) {
      // 어느 요율이 적용될지 비결정적인 상태다. 하나를 골라 넘기면 정산 분쟁이 된다.
      return {
        ok: false,
        reason: "ambiguous_rate",
        detail: `스코프 ${scopeType}(${scopeKey ?? "-"}) 에서 ${parsedQuery.at} 시점에 유효한 요율이 ${finalists.length}건입니다. 기간이 겹치는 행을 정리해야 합니다.`,
        conflicts: finalists,
      };
    }

    const record = finalists[0];

    return {
      ok: true,
      feeRateBp: record.feeRateBp,
      scopeType: record.scopeType,
      scopeKey: record.scopeKey,
      record,
    };
  }

  return {
    ok: false,
    reason: "no_matching_rate",
    detail: `${parsedQuery.at} 시점에 적용할 요율이 없습니다. 후보 스코프: ${parsedQuery.scopeCandidates.join(" → ")}. 기본값을 임의로 만들지 않습니다.`,
  };
}

/** basis point 를 적용한다. 정수 안전 범위를 벗어나면 계산하지 않고 던진다. */
function applyBasisPoint(amount: number, rateBp: number): number {
  const product = amount * rateBp;

  if (!Number.isSafeInteger(product)) {
    throw new RateError(
      `금액 ${amount} 에 요율 ${rateBp}bp 를 적용하면 정수 안전 범위를 벗어납니다. 입력을 확인하세요.`,
    );
  }

  // penalty.ts 와 같은 방식. 0.5 는 올림(+∞ 방향)이다.
  return Math.round(product / 10_000);
}

/**
 * 업체 정산액을 계산한다.
 *
 * D-16: 업체가 등록한 판매가가 **그대로 고객 노출가**이며, 플랫폼이 수수료를 제하고 정산한다.
 * 즉 수수료는 고객이 더 내는 돈이 아니라 판매가에서 **차감**되는 몫이다.
 */
export function calculateSettlement(input: SettlementInput): SettlementResult {
  const { salePrice, feeRateBp } = SettlementInputSchema.parse(input);

  const feeAmount = applyBasisPoint(salePrice, feeRateBp);

  return {
    salePrice,
    feeRateBp,
    feeAmount,
    netAmount: salePrice - feeAmount,
  };
}

/**
 * 플래너 수수료를 계산한다.
 *
 * D-17: 플래너는 **카테고리별 부분 선택**이며 선택한 항목에만 부과된다.
 * 요율이 있어도 미선택이면 0원이다 — 상담만 받고 계약하지 않으면 수수료가 발생하지 않는다.
 */
export function calculatePlannerFee(input: PlannerFeeInput): number {
  const { salePrice, feeRateBp, selected } = PlannerFeeInputSchema.parse(input);

  if (!selected) return 0;

  return applyBasisPoint(salePrice, feeRateBp);
}

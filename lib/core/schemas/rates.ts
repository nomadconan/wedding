// 요율·정산 입출력 스키마 (명세서 §3.8 요율 해석 규칙, §3.4, D-16 · D-17)
//
//  * 요율은 **basis point 정수**(1% = 100bp)다. 부동소수점을 쓰지 않는다.
//  * **요율 값을 이 파일에 쓰지 않는다.** O-02 미확정이며 값은 DB(commission_rates ·
//    planner_fee_rates · app_settings)가 가진다. 여기 있는 10000 은 100% 라는
//    스키마 수준 sanity bound 이지 업무 요율이 아니다(마이그레이션 CHECK 와 같은 값).
//  * 요율 레코드는 **주입**받는다. lib/core 는 DB 에 접근하지 않는다.

import { z } from "zod";

/** 원 단위 정수 금액. */
export const MoneySchema = z
  .number()
  .int("금액은 원 단위 정수여야 합니다.")
  .min(0, "금액은 0 이상이어야 합니다.")
  .finite();

/** basis point 정수 (1% = 100bp, 100% = 10000bp). */
export const BasisPointSchema = z
  .number()
  .int("요율은 basis point 정수여야 합니다.")
  .min(0, "요율은 0bp 이상이어야 합니다.")
  .max(10_000, "요율은 10000bp(100%)를 넘을 수 없습니다.")
  .finite();

/** ISO 8601 시점. 요율 구간은 시각까지 비교한다(timestamptz). */
export const InstantSchema = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "시점 형식이 올바르지 않습니다(ISO 8601).",
  });

/**
 * 요율 스코프.
 * `vendor`·`planner` 는 각 요율 테이블에서만 쓰이지만, 해석 엔진은 두 테이블에
 * 같은 규칙을 적용하므로 하나의 집합으로 둔다.
 */
export const RATE_SCOPES = ["global", "category", "vendor", "planner"] as const;
export type RateScope = (typeof RATE_SCOPES)[number];
export const RateScopeSchema = z.enum(RATE_SCOPES);

/**
 * 우선순위 순 후보. **앞이 좁은 범위**이며 좁은 범위가 넓은 범위를 이긴다(§3.8).
 * 값(요율)이 아니라 **해석 순서**이므로 코드에 두어도 O-02 와 무관하다.
 */
export const COMMISSION_SCOPE_ORDER = ["vendor", "category", "global"] as const;
export const PLANNER_FEE_SCOPE_ORDER = ["planner", "category", "global"] as const;

/**
 * 요율 레코드 하나. commission_rates / planner_fee_rates 의 행을 그대로 옮긴 형태다.
 * 적용 구간은 **[effectiveFrom, effectiveTo)** 반개구간이며 DB 의 tstzrange 와 같다.
 */
export const RateRecordSchema = z
  .object({
    id: z.string().min(1).optional(),
    scopeType: RateScopeSchema,
    /** global 이면 null. category 면 카테고리 코드, vendor·planner 면 대상 id. */
    scopeKey: z.string().min(1).nullable(),
    /** 플래너 요율의 서비스 등급. null 이면 등급 무관이다. */
    serviceLevel: z.string().min(1).nullable().optional(),
    feeRateBp: BasisPointSchema,
    effectiveFrom: InstantSchema,
    /** null 이면 무기한. */
    effectiveTo: InstantSchema.nullable(),
  })
  .refine(
    (record) => (record.scopeType === "global" ? record.scopeKey === null : record.scopeKey !== null),
    { message: "global 스코프는 scopeKey 가 없어야 하고, 나머지는 있어야 합니다." },
  )
  .refine(
    (record) =>
      record.effectiveTo === null || Date.parse(record.effectiveTo) > Date.parse(record.effectiveFrom),
    { message: "effectiveTo 는 effectiveFrom 보다 뒤여야 합니다." },
  );

export type RateRecord = z.infer<typeof RateRecordSchema>;

/**
 * 요율 조회 조건.
 *
 * 명세서 §3.8 의 `요율 조회(대상, 카테고리, 시점)` 을 그대로 옮긴 것이다.
 * `scopeCandidates` 가 해석 순서이고, `scopeKeys` 가 각 스코프의 조회 키다.
 */
export const RateQuerySchema = z.object({
  /** 우선순위 순 후보(앞이 좁은 범위). 예: ["vendor", "category", "global"] */
  scopeCandidates: z.array(RateScopeSchema).min(1, "후보 스코프가 최소 하나는 필요합니다."),
  /** 스코프별 조회 키. global 은 키가 없으므로 넣지 않는다. */
  scopeKeys: z.record(RateScopeSchema, z.string().min(1)).default({}),
  /** 조회 시점. 계약 확정 시점을 넣으면 그 시점의 요율이 나온다. */
  at: InstantSchema,
  /** 서비스 등급. 지정하면 등급 일치 행이 등급 무관(null) 행보다 우선한다. */
  serviceLevel: z.string().min(1).nullable().optional(),
});

/**
 * 호출자용 타입.
 *
 * `z.input` 을 그대로 쓰지 않는 이유: zod 가 만드는 배열 타입은 가변이라
 * `COMMISSION_SCOPE_ORDER` 같은 `as const` 상수를 그대로 넘길 수 없다.
 * 해석 순서는 읽기 전용으로 다루는 편이 안전하므로 여기서 readonly 로 넓힌다.
 */
export type RateQuery = {
  scopeCandidates: readonly RateScope[];
  scopeKeys?: Partial<Record<RateScope, string>>;
  at: string;
  serviceLevel?: string | null;
};

/** 정산 계산 입력 — 업체 수수료는 판매가에서 **차감**된다(D-16). */
export const SettlementInputSchema = z.object({
  salePrice: MoneySchema,
  feeRateBp: BasisPointSchema,
});

export type SettlementInput = z.infer<typeof SettlementInputSchema>;

export const SettlementResultSchema = z.object({
  salePrice: MoneySchema,
  feeRateBp: BasisPointSchema,
  feeAmount: MoneySchema,
  netAmount: MoneySchema,
});

export type SettlementResult = z.infer<typeof SettlementResultSchema>;

/** 플래너 수수료 계산 입력 — 선택한 항목에만 **가산**된다(D-17). */
export const PlannerFeeInputSchema = z.object({
  salePrice: MoneySchema,
  feeRateBp: BasisPointSchema,
  /** false 면 요율이 있어도 0원이다. 상담만 받고 계약하지 않으면 수수료가 없다. */
  selected: z.boolean(),
});

export type PlannerFeeInput = z.infer<typeof PlannerFeeInputSchema>;

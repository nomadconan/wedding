// 위약금 시뮬레이터 입출력 스키마 (명세서 §5.3, §3.5 penalty_rules)
//
//  * 금액은 전부 **정수(원)** 다. 부동소수점을 쓰지 않는다.
//  * 요율은 **basis point(1% = 100bp)** 정수로 다룬다. 0.1% 단위까지 오차 없이 표현된다.
//  * 룰 데이터(구간·요율)는 코드에 박지 않고 주입받는다 — penalty_rules 시드가
//    나중에 확정돼도 엔진 코드가 바뀌지 않게 하기 위해서다.

import { z } from "zod";

/**
 * 위약금 카테고리.
 * penalty_rules.category(text)에 그대로 들어가는 코드값이며 vendors.category 와 맞춘다.
 */
export const PENALTY_CATEGORIES = ["hall", "studio", "dress", "makeup", "video", "agency"] as const;
export type PenaltyCategory = (typeof PENALTY_CATEGORIES)[number];

export const PenaltyCategorySchema = z.enum(PENALTY_CATEGORIES);

/** 원 단위 정수 금액. */
const AmountSchema = z
  .number()
  .int("금액은 원 단위 정수여야 합니다.")
  .min(0, "금액은 0 이상이어야 합니다.")
  .finite();

/** basis point 정수 (1% = 100bp, 100% = 10000bp). */
const BasisPointSchema = z
  .number()
  .int("요율은 basis point 정수여야 합니다.")
  .min(0)
  .max(10_000)
  .finite();

/** 'YYYY-MM-DD' 또는 ISO 8601. 시각 성분은 무시하고 날짜만 사용한다. */
const DateStringSchema = z
  .string()
  .min(10)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "날짜 형식이 올바르지 않습니다(YYYY-MM-DD 또는 ISO 8601).",
  });

/**
 * 취소 시점 구간.
 * daysBeforeEvent(예식일까지 남은 일수)가 [min, max] 안에 들면 이 구간을 적용한다.
 * 경계값은 **양끝 모두 포함**이다.
 */
export const PenaltyBandSchema = z
  .object({
    code: z.string().min(1),
    label: z.string().min(1),
    /** 남은 일수 하한(포함). */
    minDaysBeforeEvent: z.number().int().min(0),
    /** 남은 일수 상한(포함). null 이면 무제한. */
    maxDaysBeforeEvent: z.number().int().min(0).nullable(),
    /** 총액 대비 기준 위약률(bp). */
    rateBp: BasisPointSchema,
    /** 이 구간에서 계약금이 반환되는가. */
    refundDeposit: z.boolean(),
  })
  .refine(
    (band) => band.maxDaysBeforeEvent === null || band.minDaysBeforeEvent <= band.maxDaysBeforeEvent,
    { message: "minDaysBeforeEvent 는 maxDaysBeforeEvent 이하여야 합니다." },
  );

export type PenaltyBand = z.infer<typeof PenaltyBandSchema>;

export const PenaltyRuleSetSchema = z.object({
  category: PenaltyCategorySchema,
  version: z.string().min(1),
  basisRef: z.string().min(1),
  /** 법무 검수 전 가정치인지 여부. true 면 출력에 '가정치' 경고가 붙는다. */
  isDraft: z.boolean(),
  /** 예식일 이전 구간. 남은 일수가 큰 순서로 정렬돼 있을 필요는 없다. */
  bands: z.array(PenaltyBandSchema).min(1),
  /** 예식일이 지난 뒤 취소한 경우. */
  afterEvent: PenaltyBandSchema,
});

export type PenaltyRuleSet = z.infer<typeof PenaltyRuleSetSchema>;

/**
 * 계약서가 정한 위약 규정.
 *  - rate: 총액 대비 요율
 *  - forfeit_deposit: 계약금 전액 몰취(R-02 가 잡아내는 전형적 조항)
 *  - none: 계약서에 위약 규정이 없음
 */
export const ContractPenaltyTermSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rate"), rateBp: BasisPointSchema }),
  z.object({ kind: z.literal("forfeit_deposit") }),
  z.object({ kind: z.literal("none") }),
]);

export type ContractPenaltyTerm = z.infer<typeof ContractPenaltyTermSchema>;

export const PenaltyInputSchema = z.object({
  category: PenaltyCategorySchema,
  /** 계약 총액(원). */
  totalAmount: AmountSchema,
  /** 계약금(원). */
  depositAmount: AmountSchema,
  /** 예식일. */
  eventDate: DateStringSchema,
  /** 취소 시점. */
  cancelDate: DateStringSchema,
  /** 계약서에 규정된 위약 조건. */
  contractTerm: ContractPenaltyTermSchema,
});

export type PenaltyInput = z.infer<typeof PenaltyInputSchema>;

export const PenaltySettlementSchema = z.object({
  /** 적용된 위약금(원). */
  penalty: z.number().int().min(0),
  /** 돌려받는 계약금(원). */
  depositRefund: z.number().int().min(0),
  /** 계약금으로 부족해 추가로 내야 하는 금액(원). */
  balanceDue: z.number().int().min(0),
});

export type PenaltySettlement = z.infer<typeof PenaltySettlementSchema>;

export const PenaltyResultSchema = z.object({
  /** 예식일까지 남은 일수. 예식일이 지났으면 음수. */
  daysBeforeEvent: z.number().int(),
  /** 적용된 구간. */
  bandCode: z.string(),
  bandLabel: z.string(),
  /** 기준(소비자분쟁해결기준) 적용 결과. */
  standard: PenaltySettlementSchema,
  /** 계약서 조항 적용 결과. */
  contract: PenaltySettlementSchema,
  /** 계약서 위약금 - 기준 위약금. 음수가 되지 않는다(기준보다 낮으면 0). */
  excessPenalty: z.number().int().min(0),
  /** 계약금이 기준상 반환 대상인가. */
  depositRefundable: z.boolean(),
  /** 근거 출처. */
  basisRef: z.string(),
  /** 룰 세트 버전. */
  ruleVersion: z.string(),
  /** 이의 제기 문구. 비교값만 담고 확정적 결론을 담지 않는다. */
  objectionScript: z.string(),
  /** 비정상 입력·가정치 사용 등 경고. */
  notes: z.array(z.string()),
  /** 상시 고정 고지. */
  disclaimer: z.string(),
});

export type PenaltyResult = z.infer<typeof PenaltyResultSchema>;

/** 퍼센트를 basis point 정수로 바꾼다. 10.5% → 1050bp */
export function percentToBp(percent: number): number {
  return Math.round(percent * 100);
}

/** basis point 를 퍼센트로 바꾼다. 1050bp → 10.5 */
export function bpToPercent(bp: number): number {
  return bp / 100;
}

/**
 * 시뮬레이터 요청 (S7-04 · 명세서 §4.2 `POST /api/penalty/simulate`)
 *
 * **저장은 기본이 아니다.** 계산은 입력만으로 성립하고 아무것도 남기지 않는다 —
 * 화면을 열 때마다 행이 쌓이면 `penalty_simulations` 는 기록이 아니라 로그가 된다.
 * 남기고 싶을 때 사용자가 누른다(D-73 과 같은 판단).
 *
 * `save: true` 는 **로그인 + 커플**을 요구한다. 계산 자체는 커플 데이터를 읽지 않으므로
 * 로그인 없이도 된다 — 계약서에 서명하기 **전에** 확인하는 것이 이 도구의 쓸모다.
 */
export const PenaltySimulateRequestSchema = PenaltyInputSchema.extend({
  save: z.boolean().default(false),
}).strict();

export type PenaltySimulateRequest = z.infer<typeof PenaltySimulateRequestSchema>;

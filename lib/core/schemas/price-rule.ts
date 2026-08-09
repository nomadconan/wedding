// 다이내믹 프라이싱 룰 스키마 (S2-06 · 명세서 §2.2 F-V-06, §3.3 price_rules, §4.3)
//
// 가격은 정산·계약과 직결된다. **같은 입력이면 항상 같은 결과**여야 하므로
//  * 값은 전부 정수다. 비율은 basis point(1% = 100bp) — penalty.ts·rates.ts 와 같은 방식이다.
//  * 조건은 rule_type 별로 모양이 정해져 있다. 자유 JSON 을 그대로 받지 않는다.
//
// **요율 숫자를 여기 쓰지 않는다.** 할인율은 업체가 정하는 값이며 코드에 기본값이 없다.

import { z } from "zod";

/** §3.3 `price_rule_type` 열거와 값이 같다. */
export const PRICE_RULE_TYPES = ["season", "weekday", "leadtime", "occupancy"] as const;
export type PriceRuleType = (typeof PRICE_RULE_TYPES)[number];

export const PRICE_RULE_TYPE_LABEL: Record<PriceRuleType, string> = {
  season: "시즌",
  weekday: "요일",
  leadtime: "리드타임",
  occupancy: "잔여율",
};

export const PRICE_RULE_TYPE_DESCRIPTION: Record<PriceRuleType, string> = {
  season: "지정한 기간의 예식일에 적용합니다.",
  weekday: "지정한 요일의 예식일에 적용합니다.",
  leadtime: "예식일까지 남은 일수로 적용합니다. **조회 시점이 기준이라 같은 룰도 날마다 결과가 달라집니다.**",
  occupancy: "그날 남은 자리의 비율로 적용합니다. 재고(S2-05)를 기준으로 계산합니다.",
};

/** 조정 방식. DB CHECK 와 값이 같다. */
export const ADJUST_TYPES = ["percent_bp", "amount_krw"] as const;
export type AdjustType = (typeof ADJUST_TYPES)[number];

export const ADJUST_TYPE_LABEL: Record<AdjustType, string> = {
  percent_bp: "비율(%)",
  amount_krw: "금액(원)",
};

const DateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 YYYY-MM-DD 형식으로 입력해 주세요.");

const RatioBpSchema = z
  .number()
  .int("비율은 basis point 정수로 입력해 주세요.")
  .min(0)
  .max(10_000);

/**
 * 조건. rule_type 마다 모양이 다르다 — 그래서 판별 유니온이다.
 *
 * 각 멤버는 **순수 객체**여야 한다. zod 의 `discriminatedUnion` 은 멤버가 `ZodObject` 일 때만
 * 판별자를 찾는데, `.refine()` 을 붙이면 `ZodEffects` 로 감싸여 판별이 깨진다.
 * 그래서 교차 필드 검증(기간 역전 등)은 **유니온 바깥**에서 한 번에 한다.
 */
const SeasonConditionSchema = z.object({
  ruleType: z.literal("season"),
  from: DateStringSchema,
  to: DateStringSchema,
});

const WeekdayConditionSchema = z.object({
  ruleType: z.literal("weekday"),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1, "요일을 하나 이상 선택해 주세요."),
});

const LeadtimeConditionSchema = z.object({
  ruleType: z.literal("leadtime"),
  /** 예식일까지 남은 일수. 양끝 포함이다. */
  minDays: z.number().int().min(0).nullable().default(null),
  maxDays: z.number().int().min(0).nullable().default(null),
});

const OccupancyConditionSchema = z.object({
  ruleType: z.literal("occupancy"),
  /** 잔여율(bp). 3000 = 30%. 양끝 포함이다. */
  minRatioBp: RatioBpSchema.nullable().default(null),
  maxRatioBp: RatioBpSchema.nullable().default(null),
});

export const PriceRuleConditionSchema = z
  .discriminatedUnion("ruleType", [
    SeasonConditionSchema,
    WeekdayConditionSchema,
    LeadtimeConditionSchema,
    OccupancyConditionSchema,
  ])
  .superRefine((condition, ctx) => {
    if (condition.ruleType === "season" && condition.from > condition.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "종료일이 시작일보다 빠릅니다.",
      });
    }

    if (condition.ruleType === "leadtime") {
      if (condition.minDays === null && condition.maxDays === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "최소 또는 최대 일수 중 하나는 입력해야 합니다.",
        });
      } else if (
        condition.minDays !== null &&
        condition.maxDays !== null &&
        condition.minDays > condition.maxDays
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["maxDays"],
          message: "최대 일수가 최소 일수보다 작습니다.",
        });
      }
    }

    if (condition.ruleType === "occupancy") {
      if (condition.minRatioBp === null && condition.maxRatioBp === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "최소 또는 최대 잔여율 중 하나는 입력해야 합니다.",
        });
      } else if (
        condition.minRatioBp !== null &&
        condition.maxRatioBp !== null &&
        condition.minRatioBp > condition.maxRatioBp
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["maxRatioBp"],
          message: "최대 잔여율이 최소보다 작습니다.",
        });
      }
    }
  });

export type PriceRuleCondition = z.infer<typeof PriceRuleConditionSchema>;

const MoneySchema = z.number().int().min(0).max(10_000_000_000);

export const PriceRuleInputSchema = z
  .object({
    ruleType: z.enum(PRICE_RULE_TYPES),
    condition: PriceRuleConditionSchema,
    adjustType: z.enum(ADJUST_TYPES),
    /** percent_bp 면 bp(-1000 = -10%), amount_krw 면 원 단위 정수. 둘 다 음수가 할인이다. */
    adjustValue: z
      .number({ required_error: "조정 값을 입력해 주세요.", invalid_type_error: "조정 값은 숫자로 입력해 주세요." })
      .int("조정 값은 정수로 입력해 주세요."),
    floorPrice: MoneySchema.nullable().default(null),
    capPrice: MoneySchema.nullable().default(null),
    priority: z.number().int().min(0).max(9999).default(100),
    isActive: z.boolean().default(true),
    productId: z.string().uuid().nullable().default(null),
  })
  .refine((input) => input.ruleType === input.condition.ruleType, {
    message: "조건이 룰 종류와 맞지 않습니다.",
    path: ["condition"],
  })
  .refine(
    (input) => input.adjustType !== "percent_bp" || Math.abs(input.adjustValue) <= 10_000,
    { message: "비율은 -100% ~ +100% 안에서 입력해 주세요.", path: ["adjustValue"] },
  )
  .refine((input) => input.adjustValue !== 0, {
    message: "조정 값이 0이면 아무 일도 하지 않습니다.",
    path: ["adjustValue"],
  })
  .refine(
    (input) => input.floorPrice === null || input.capPrice === null || input.floorPrice <= input.capPrice,
    { message: "하한가가 상한가보다 큽니다.", path: ["capPrice"] },
  );

export type PriceRuleInput = z.input<typeof PriceRuleInputSchema>;

/** 시뮬레이션 입력. "지금"에 해당하는 값들을 **명시적으로** 받는다. */
export const PriceSimulationInputSchema = z.object({
  basePrice: z.number().int().positive("총액은 0원보다 커야 합니다."),
  /** 예식일. 시즌·요일 조건이 이 날짜를 본다. */
  eventDate: DateStringSchema,
  /** 예식일까지 남은 일수. 조회 시점 기준이라 호출자가 넘긴다. */
  leadTimeDays: z.number().int().min(0),
  /** 잔여율(bp). 재고가 없으면 null — 잔여율 조건은 평가하지 않는다. */
  occupancyRatioBp: RatioBpSchema.nullable().default(null),
  productId: z.string().uuid().nullable().default(null),
});

export type PriceSimulationInput = z.input<typeof PriceSimulationInputSchema>;

/** 'YYYY-MM-DD' 의 요일(0=일). UTC 자정 기준이라 타임존이 끼어들지 않는다. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

import { z } from "zod";

import { BUDGET_CATEGORIES } from "../budget/budget";

/**
 * 예산 입출력 (S7-07 · 명세서 §4.2 `GET/PUT /api/budget` · CLAUDE.md §6)
 *
 * §4.2 는 이 경로 하나에 **"예산 배분 조회·갱신, 실지출 등록"** 셋을 얹었다. 그래서
 * PUT 은 **행위 union** 이다(`/api/tasks` 와 같은 모양) — 하나의 몸통에 여러 뜻을
 * 섞으면 어떤 필드가 무엇을 바꾸는지 스키마가 말하지 못한다.
 *
 * **금액은 정수 원**이다. 소수를 받으면 반올림 자리를 API 가 정하게 되고, 그 자리는
 * 화면·정산과 어긋난다.
 */
const AmountSchema = z
  .number()
  .int("금액은 정수여야 합니다.")
  .min(0, "금액은 0 이상이어야 합니다.")
  // 원 단위 bigint 컬럼이지만 JS 안전 정수 범위를 넘는 값은 입력 사고다.
  .max(Number.MAX_SAFE_INTEGER);

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 YYYY-MM-DD 형식이어야 합니다.");

export const BudgetCategorySchema = z.enum(
  BUDGET_CATEGORIES as unknown as [string, ...string[]],
);

export const EXPENSE_MEMO_MAX_LENGTH = 60;

/**
 * 총예산.
 *
 * **`null` 을 받는다 — 그것이 '미정' 이다.** 0 으로 지우게 하면 "예산 0원" 과
 * "아직 안 정함" 이 같은 값이 되고, 화면은 담는 즉시 '초과' 를 띄운다.
 *
 * 저장 위치는 **`couples.total_budget` 하나**다(장바구니 기준선과 같은 값 · D-77).
 */
export const BudgetTotalSchema = z
  .object({
    action: z.literal("set_total"),
    totalBudget: AmountSchema.nullable(),
  })
  .strict();

/** 카테고리별 계획. **부분 갱신**이며 보내지 않은 카테고리는 건드리지 않는다. */
export const BudgetPlanSchema = z
  .object({
    action: z.literal("set_plan"),
    allocations: z
      .array(
        z
          .object({
            category: BudgetCategorySchema,
            /** `null` 이면 그 카테고리의 계획을 지운다 — 0원 계획과 다르다. */
            plannedAmount: AmountSchema.nullable(),
          })
          .strict(),
      )
      .min(1, "바꿀 카테고리를 하나 이상 적어 주세요.")
      .max(BUDGET_CATEGORIES.length),
  })
  .strict();

/**
 * 권장을 계획으로 옮긴다.
 *
 * **사용자가 누른다**(D-73 과 같은 판단 — 체크리스트 자동 생성). 조회할 때마다 조용히
 * 계획을 덮으면 사용자가 손으로 고친 값이 사라지고, 그 순간 이 화면은 **자기가 정하지
 * 않은 숫자를 보여주는 화면**이 된다.
 */
export const BudgetApplyRecommendationSchema = z
  .object({
    action: z.literal("apply_recommendation"),
    /** 이미 계획이 있는 카테고리도 덮을 것인가. 기본은 **덮지 않는다.** */
    overwrite: z.boolean().default(false),
  })
  .strict();

/** 실지출 등록. 계약 금액은 자동으로 잡히므로 여기 적을 일이 아니다(화면이 말한다). */
export const ExpenseAddSchema = z
  .object({
    action: z.literal("add_expense"),
    category: BudgetCategorySchema,
    amount: AmountSchema,
    paidAt: DateSchema.nullable().default(null),
    /** 커플이 자기 행에 적는 짧은 메모. **증적에는 넣지 않는다**(§7.3). */
    memo: z.string().trim().max(EXPENSE_MEMO_MAX_LENGTH).nullable().default(null),
  })
  .strict();

export const ExpenseRemoveSchema = z
  .object({
    action: z.literal("remove_expense"),
    expenseId: z.string().uuid(),
  })
  .strict();

export const BudgetUpdateSchema = z.union([
  BudgetTotalSchema,
  BudgetPlanSchema,
  BudgetApplyRecommendationSchema,
  ExpenseAddSchema,
  ExpenseRemoveSchema,
]);

export type BudgetUpdateInput = z.infer<typeof BudgetUpdateSchema>;

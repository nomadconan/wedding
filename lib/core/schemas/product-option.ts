// 추가금 사전 등록 스키마 (S2-04 · 명세서 §2.2 F-V-04, §3.3 product_options, §4.3)
//
// F-V-04: "발생 가능한 **모든** 추가금을 사전 항목화. **사전 미등록 항목은 사후 청구 불가**"
//
// 그래서 이 파일이 지키는 것은 둘이다.
//   1. 등록된 항목이 **고객이 이해할 수 있는 형태**여야 한다 — 이름·금액·발생 조건.
//      조건을 모르면 "언제 내는 돈인지" 알 수 없고, 그건 사전 등록이 아니다.
//   2. **'없음'과 '아직 안 적음'을 구분**한다. 0건 확정은 진술이고, 미확정은 공백이다.
//
// 금액은 원 단위 정수. 요율·정산은 lib/core/pricing 의 몫이며 여기에 요율 숫자가 없다.

import { z } from "zod";

import { findPriceEvasionPhrase } from "./product";

/** 항목 이름·조건에도 가격 회피 문구를 허용하지 않는다(F-V-03 과 같은 이유). */
const NoPriceEvasion = (label: string) =>
  z.string().superRefine((value, ctx) => {
    const found = findPriceEvasionPhrase(value);
    if (!found) return;

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${label}에 '${found}' 같은 표현을 쓸 수 없습니다. 금액을 숫자로 등록해 주세요.`,
    });
  });

/**
 * 추가금 한 건.
 *
 * `isMandatory` 가 참이면 **항상 발생**하므로 조건이 필요 없다.
 * 거짓이면 **발생 조건 설명이 필수**다 — DB CHECK 와 같은 규칙이다.
 */
export const ProductOptionInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "추가금 항목 이름을 적어 주세요.")
      .max(60)
      .pipe(NoPriceEvasion("항목 이름")),
    /** 0원도 허용한다 — '무료 제공이지만 항목으로는 존재한다'가 사실인 경우가 있다. */
    price: z
      .number({ required_error: "금액을 입력해 주세요.", invalid_type_error: "금액은 숫자로 입력해 주세요." })
      .int("금액은 원 단위 정수로 입력해 주세요.")
      .min(0, "금액은 0원 이상이어야 합니다.")
      .max(1_000_000_000, "금액을 다시 확인해 주세요."),
    /** 항상 발생하는 필수 추가금인가. */
    isMandatory: z.boolean().default(false),
    /** 조건부일 때의 발생 조건. 예: "토요일·공휴일 예식", "하객 250명 초과 시". */
    conditionDescription: z
      .string()
      .trim()
      .max(200)
      .nullable()
      .default(null)
      .transform((value) => (value === "" ? null : value)),
  })
  .superRefine((input, ctx) => {
    if (input.isMandatory) return;

    if (!input.conditionDescription) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["conditionDescription"],
        message: "조건부 추가금은 언제 발생하는지 적어야 합니다. 항상 발생하면 '필수'로 표시하세요.",
      });

      return;
    }

    const found = findPriceEvasionPhrase(input.conditionDescription);
    if (found) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["conditionDescription"],
        message: `발생 조건에 '${found}' 같은 표현을 쓸 수 없습니다.`,
      });
    }
  });

export type ProductOptionInput = z.input<typeof ProductOptionInputSchema>;

/** 부분 수정(PATCH). 최소 한 필드는 있어야 한다. */
export const ProductOptionPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(60).pipe(NoPriceEvasion("항목 이름")).optional(),
    price: z.number().int().min(0).max(1_000_000_000).optional(),
    isMandatory: z.boolean().optional(),
    conditionDescription: z.string().trim().max(200).nullable().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, { message: "변경할 내용이 없습니다." });

/** 업체당 상품 하나에 등록할 수 있는 항목 수. 무제한이면 비교표가 읽히지 않는다. */
export const PRODUCT_OPTION_MAX = 40;

/**
 * 추가금 사전 등록 상태.
 *
 * 화면(`PriceDisplay.addOns`)이 그대로 받는 모양이며, **'없음'과 '미등록'을 구분**한다.
 *  - `unknown`  아직 확정하지 않았다. 총액이 늘어날 수 있다는 뜻이다.
 *  - `none`     0건으로 확정했다. "추가금이 없다"는 업체의 진술이다.
 *  - `listed`   n건 확정. 합계는 **모두 발생했을 때의 상한**이다.
 */
export type AddOnSummary =
  | { kind: "unknown" }
  | { kind: "none" }
  | { kind: "listed"; count: number; total: number };

export function summarizeAddOns(
  declaredAt: string | null,
  options: { price: number }[],
): AddOnSummary {
  if (!declaredAt) return { kind: "unknown" };
  if (options.length === 0) return { kind: "none" };

  return {
    kind: "listed",
    count: options.length,
    total: options.reduce((sum, option) => sum + option.price, 0),
  };
}

/**
 * 확정 이후에 항목이 바뀌면 **다시 확정해야 한다.**
 * 확정 시각보다 나중에 만들어지거나 수정된 항목이 있으면 그 확정은 현재 목록을 담보하지 않는다.
 */
export function needsRedeclaration(
  declaredAt: string | null,
  options: { updatedAt: string }[],
): boolean {
  if (!declaredAt) return false;

  const declared = Date.parse(declaredAt);

  return options.some((option) => Date.parse(option.updatedAt) > declared);
}

/** 게시 차단 사유에 추가금 확정을 더한다(F-V-04). 문구는 화면·API 가 공유한다. */
export const ADD_ONS_PUBLISH_BLOCKER = {
  code: "ADD_ONS_NOT_DECLARED",
  message:
    "추가금 사전 등록을 확정해 주세요. 발생 가능한 항목이 없으면 '추가금 없음'으로 확정합니다.",
} as const;

/** 고객에게 보이는 안내. 사전 미등록 항목은 사후 청구할 수 없다는 정책의 표현이다. */
export const ADD_ONS_POLICY_NOTICE =
  "여기에 등록하지 않은 항목은 계약 이후에 청구할 수 없습니다. 발생 가능한 추가금을 빠짐없이 적어 주세요.";

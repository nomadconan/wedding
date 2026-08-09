// 상품·판매가 입출력 스키마 (S2-03 · 명세서 §2.2 F-V-03, §3.3 products, §4.3, D-16)
//
// **총액 표기 강제가 이 파일의 존재 이유다.**
//   "총액 표기 강제 — '별도 문의' 가격 등록 불가"(F-V-03)
//   등록 판매가가 **그대로 고객 노출가**이며, 플랫폼은 여기서 수수료를 제하고 정산한다(D-16).
//   그래서 판매가는 숫자 하나로만 받는다. 자유 텍스트 가격 필드를 만들지 않는다.
//
// 금액은 원 단위 정수만 다룬다. 요율·정산 계산은 `lib/core/pricing` 의 몫이고
// 이 파일에는 **요율 숫자가 없다**(O-02).

import { z } from "zod";

import { VendorCategorySchema } from "./vendor";

/** 상품 게시 상태. DB `products.status` CHECK 와 값이 같다. */
export const PRODUCT_STATUSES = ["draft", "published", "archived"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export const ProductStatusSchema = z.enum(PRODUCT_STATUSES);

export const PRODUCT_STATUS_LABEL: Record<ProductStatus, string> = {
  draft: "작성 중",
  published: "고객 노출 중",
  archived: "내림",
};

/**
 * 가격을 회피하는 문구.
 *
 * 총액을 숫자로 받는 것만으로는 부족하다. 최소 금액을 형식적으로 넣어 두고
 * 이름·포함 항목에 "가격 별도 문의" 를 적으면 정찰제가 그대로 무력화된다.
 * 그래서 **가격 회피 문구 자체를 입력 단계에서 막는다**(F-V-03, D-16).
 *
 * 공백을 지운 문자열에서 검사한다 — '별도 문의' 와 '별도문의' 를 같이 잡기 위해서다.
 */
export const PRICE_EVASION_PATTERNS = [
  "별도문의",
  "가격문의",
  "전화문의",
  "문의요망",
  "문의바랍니다",
  "상담후결정",
  "상담후안내",
  "추후협의",
  "별도협의",
  "가격협의",
  "협의후",
] as const;

/** 가격 회피 문구가 들어 있는가. 들어 있으면 그 문구를 돌려준다. */
export function findPriceEvasionPhrase(value: string): string | null {
  const compact = value.replace(/\s+/g, "");

  return PRICE_EVASION_PATTERNS.find((pattern) => compact.includes(pattern)) ?? null;
}

const NoPriceEvasion = (label: string) =>
  z.string().superRefine((value, ctx) => {
    const found = findPriceEvasionPhrase(value);
    if (!found) return;

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${label}에 '${found}' 같은 가격 문의 표현을 쓸 수 없습니다. 총액을 숫자로 등록해 주세요.`,
    });
  });

/** 포함 항목. 무엇이 총액에 들어 있는지 고객이 비교할 수 있어야 한다(F-V-03). */
export const IncludedItemSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1, "포함 항목 이름을 적어 주세요.")
    .max(60)
    .pipe(NoPriceEvasion("포함 항목")),
  /** 수량·범위 등 부연. 금액을 적는 칸이 아니다. */
  note: z.string().trim().max(120).nullable().default(null),
});

export type IncludedItem = z.infer<typeof IncludedItemSchema>;

const CapacitySchema = z.number().int().min(0).max(100_000).nullable();

/**
 * 판매가.
 *
 * **양의 정수만 받는다.** 0원·음수·소수·문자열은 전부 422 다.
 * `.positive()` 가 "별도 문의" 를 0원으로 우회하는 경로를 막는 층이다.
 */
export const BasePriceTotalSchema = z
  .number({ required_error: "총액을 입력해 주세요.", invalid_type_error: "총액은 숫자로 입력해 주세요." })
  .int("총액은 원 단위 정수로 입력해 주세요.")
  .positive("총액은 0원보다 커야 합니다. '별도 문의'로는 등록할 수 없습니다.")
  .max(10_000_000_000, "총액을 다시 확인해 주세요.");

/**
 * 필드 정의(ZodObject).
 * `partial()` 을 쓰려면 refine 이 붙기 전의 객체 스키마가 필요하다 —
 * PATCH 는 일부 필드만 보내기 때문이다.
 */
export const ProductInputFieldsSchema = z.object({
    name: z.string().trim().min(2, "상품명을 2자 이상 입력해 주세요.").max(100).pipe(NoPriceEvasion("상품명")),
    category: VendorCategorySchema,
    basePriceTotal: BasePriceTotalSchema,
    includedItems: z.array(IncludedItemSchema).max(50, "포함 항목은 50개까지 등록할 수 있습니다.").default([]),
    capacityMin: CapacitySchema.default(null),
    capacityMax: CapacitySchema.default(null),
});

/** 수용 인원 하한 <= 상한. 두 값이 다 있을 때만 본다(부분 수정에서도 같은 규칙). */
export const capacityRangeIsValid = (input: {
  capacityMin?: number | null;
  capacityMax?: number | null;
}): boolean =>
  input.capacityMin === null ||
  input.capacityMin === undefined ||
  input.capacityMax === null ||
  input.capacityMax === undefined ||
  input.capacityMin <= input.capacityMax;

export const ProductInputSchema = ProductInputFieldsSchema.refine(capacityRangeIsValid, {
  message: "수용 인원 하한이 상한보다 큽니다.",
  path: ["capacityMax"],
});

export type ProductInput = z.input<typeof ProductInputSchema>;

/** 상태 변경 요청. 게시는 조건을 만족해야만 통과한다. */
export const ProductStatusChangeSchema = z.object({
  status: ProductStatusSchema,
});

/**
 * 게시 차단 사유.
 *
 * 화면의 체크리스트와 API 검증이 **같은 함수**를 쓴다. 두 곳에 따로 적으면
 * 화면은 통과인데 서버가 막는(또는 반대) 상황이 생긴다.
 */
export type PublishBlocker = { code: string; message: string };

export function productPublishBlockers(product: {
  name?: string | null;
  basePriceTotal?: number | null;
  includedItems?: unknown[] | null;
}): PublishBlocker[] {
  const blockers: PublishBlocker[] = [];

  if (!product.name || product.name.trim().length < 2) {
    blockers.push({ code: "NAME_REQUIRED", message: "상품명을 2자 이상 입력해 주세요." });
  }

  if (typeof product.basePriceTotal !== "number" || product.basePriceTotal <= 0) {
    blockers.push({
      code: "PRICE_REQUIRED",
      message: "총액을 0원보다 크게 입력해 주세요. '별도 문의'로는 게시할 수 없습니다.",
    });
  }

  if (!product.includedItems || product.includedItems.length === 0) {
    blockers.push({
      code: "INCLUDED_ITEMS_REQUIRED",
      message: "포함 항목을 최소 1개 등록해 주세요. 무엇이 총액에 들어 있는지 밝혀야 합니다.",
    });
  }

  return blockers;
}

/** 게시 가능한가. 체크리스트가 비어야 게시할 수 있다. */
export function canPublishProduct(product: Parameters<typeof productPublishBlockers>[0]): boolean {
  return productPublishBlockers(product).length === 0;
}

/**
 * 화면·API 공통 고지 문구(F-V-03).
 * "등록 화면에 상시 표시한다" 가 요구사항이라 문구를 코드 한 곳에 둔다.
 */
export const VENDOR_PRICING_NOTICE =
  "여기에 등록한 판매가가 고객에게 그대로 노출되며, 이 금액에서 수수료를 제한 금액이 정산됩니다.";

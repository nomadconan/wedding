import { z } from "zod";

import { PenaltyInputSchema } from "../schemas/penalty";
import { SEARCH_FIELDS } from "../schemas/search";
import { STYLE_TAGS } from "../schemas/onboarding";
import { VENDOR_CATEGORIES } from "../schemas/vendor";
import { PLANNER_CATEGORIES } from "../planner/scope";

/**
 * 툴 입력 스키마 (S7-20 · 명세서 §5.6 · CLAUDE.md §6)
 *
 * **두 벌을 함께 둔다.** zod 는 서버가 인자를 검증할 때 쓰고, JSON Schema 는 모델에게
 * 툴 모양을 알려줄 때 쓴다. 손으로 두 벌을 적는 이유는 zod→JSON Schema 변환기를
 * 새 의존성으로 들이지 않기 위해서다 — 대신 **두 벌이 어긋나지 않는지 테스트가 본다**
 * (필드 이름·필수 목록 대조).
 *
 * **커플 스코프는 인자가 아니다.** `coupleId` 를 모델이 넘기게 두면 그 값이 곧 권한
 * 경계가 되고, 모델이 남의 id 를 적어 넣는 순간 조회가 열린다. 스코프는 세션에서 오며
 * 핸들러가 붙인다(`lib/ai/tools/context.ts`).
 *
 * **`search_vendors` 는 조건 검색과 같은 입력 모양을 쓴다**(§5.5 — 파서를 두 벌 두지
 * 않는다). 필드 목록을 `SEARCH_FIELDS` 에서 그대로 가져오므로 조건이 늘면 양쪽이 함께
 * 는다.
 */

// =============================================================================
// JSON Schema — 모델에게 주는 툴 모양
// =============================================================================

export type JsonSchemaProperty = {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description: string;
  enum?: readonly string[];
  items?: { type: "string"; enum?: readonly string[] };
  properties?: Record<string, JsonSchemaProperty>;
  required?: readonly string[];
};

export type JsonSchema = {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required: readonly string[];
};

const EMPTY_INPUT: JsonSchema = { type: "object", properties: {}, required: [] };

// =============================================================================
// 툴별 입력
// =============================================================================

const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 YYYY-MM-DD 형식이어야 합니다.");

const CoupleContextInput = z.object({}).strict();

const PriceIndexInput = z
  .object({
    region: z.string().trim().min(1).max(40),
    category: z.enum(VENDOR_CATEGORIES),
  })
  .strict();

const SearchVendorsInput = z
  .object({
    query: z.string().trim().max(200).default(""),
    region: z.string().trim().min(1).max(40).optional(),
    category: z.enum(VENDOR_CATEGORIES).optional(),
    date: DateSchema.optional(),
    guestCount: z.number().int().min(1).max(2_000).optional(),
    budgetMin: z.number().int().min(0).optional(),
    budgetMax: z.number().int().min(0).optional(),
    styleTags: z.array(z.enum(STYLE_TAGS)).max(STYLE_TAGS.length).optional(),
    page: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const VendorAvailabilityInput = z
  .object({
    vendorId: z.string().uuid("업체 id 형식이 아닙니다."),
    date: DateSchema,
  })
  .strict();

const CartSummaryInput = z.object({}).strict();

const CompareCartsInput = z.object({}).strict();

/** 위약금은 **이미 있는 입력 스키마를 그대로 쓴다.** 툴이 두 번째 정의를 만들지 않는다. */
const SimulatePenaltyInput = PenaltyInputSchema;

const PaymentScheduleInput = z
  .object({
    totalAmount: z.number().int().min(0),
    eventDate: DateSchema.optional(),
  })
  .strict();

const PlannerFeeInput = z
  .object({
    category: z.enum(PLANNER_CATEGORIES),
    amount: z.number().int().min(0),
  })
  .strict();

const SearchPlannersInput = z
  .object({
    category: z.enum(PLANNER_CATEGORIES).optional(),
    region: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

const ListCouponsInput = z
  .object({
    orderAmount: z.number().int().min(0).optional(),
  })
  .strict();

// =============================================================================
// 등록표
// =============================================================================

export type ToolInputDefinition = {
  schema: z.ZodTypeAny;
  jsonSchema: JsonSchema;
};

export const TOOL_INPUTS: Record<string, ToolInputDefinition> = {
  get_couple_context: { schema: CoupleContextInput, jsonSchema: EMPTY_INPUT },
  search_price_index: {
    schema: PriceIndexInput,
    jsonSchema: {
      type: "object",
      properties: {
        region: { type: "string", description: "지역 코드 또는 지역 이름. 예: 강남" },
        category: {
          type: "string",
          description: "업체 카테고리 코드",
          enum: VENDOR_CATEGORIES,
        },
      },
      required: ["region", "category"],
    },
  },
  search_vendors: {
    schema: SearchVendorsInput,
    jsonSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "사용자가 말한 조건 문장 그대로. 서버가 같은 파서로 해석한다. 조건을 직접 필드로 넘길 수도 있다.",
        },
        region: { type: "string", description: "지역" },
        category: { type: "string", description: "카테고리 코드", enum: VENDOR_CATEGORIES },
        date: { type: "string", description: "예식일 YYYY-MM-DD" },
        guestCount: { type: "integer", description: "하객 수" },
        budgetMin: { type: "integer", description: "예산 하한(원)" },
        budgetMax: { type: "integer", description: "예산 상한(원)" },
        styleTags: {
          type: "array",
          description: "스타일 태그",
          items: { type: "string", enum: STYLE_TAGS },
        },
        page: { type: "integer", description: "페이지 번호(1부터)" },
      },
      required: [],
    },
  },
  get_vendor_availability: {
    schema: VendorAvailabilityInput,
    jsonSchema: {
      type: "object",
      properties: {
        vendorId: {
          type: "string",
          description: "업체 id. search_vendors 결과에 있는 값만 쓴다.",
        },
        date: { type: "string", description: "확인할 날짜 YYYY-MM-DD" },
      },
      required: ["vendorId", "date"],
    },
  },
  get_cart_summary: { schema: CartSummaryInput, jsonSchema: EMPTY_INPUT },
  compare_carts: { schema: CompareCartsInput, jsonSchema: EMPTY_INPUT },
  simulate_penalty: {
    schema: SimulatePenaltyInput,
    jsonSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "위약금 카테고리",
          enum: ["hall", "studio", "dress", "makeup", "video", "agency"],
        },
        totalAmount: { type: "integer", description: "계약 총액(원)" },
        depositAmount: { type: "integer", description: "계약금(원)" },
        eventDate: { type: "string", description: "예식일 YYYY-MM-DD" },
        cancelDate: { type: "string", description: "취소 시점 YYYY-MM-DD" },
        contractTerm: {
          type: "object",
          description: "계약서가 정한 위약 규정",
          properties: {
            kind: {
              type: "string",
              description: "rate=요율, forfeit_deposit=계약금 몰취, none=규정 없음",
              enum: ["rate", "forfeit_deposit", "none"],
            },
            rateBp: { type: "integer", description: "kind=rate 일 때 요율(bp, 1%=100)" },
          },
          required: ["kind"],
        },
      },
      required: ["category", "totalAmount", "depositAmount", "eventDate", "cancelDate", "contractTerm"],
    },
  },
  preview_payment_schedule: {
    schema: PaymentScheduleInput,
    jsonSchema: {
      type: "object",
      properties: {
        totalAmount: { type: "integer", description: "계약 총액(원)" },
        eventDate: { type: "string", description: "예식일 YYYY-MM-DD. 기한 계산에 쓴다." },
      },
      required: ["totalAmount"],
    },
  },
  explain_planner_fee: {
    schema: PlannerFeeInput,
    jsonSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "플래너 이용 카테고리",
          enum: PLANNER_CATEGORIES,
        },
        amount: { type: "integer", description: "그 카테고리의 금액(원)" },
      },
      required: ["category", "amount"],
    },
  },
  search_planners: {
    schema: SearchPlannersInput,
    jsonSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "카테고리", enum: PLANNER_CATEGORIES },
        region: { type: "string", description: "지역" },
      },
      required: [],
    },
  },
  list_coupons: {
    schema: ListCouponsInput,
    jsonSchema: {
      type: "object",
      properties: {
        orderAmount: {
          type: "integer",
          description: "적용해 볼 결제 금액(원). 없으면 조건만 확인한다.",
        },
      },
      required: [],
    },
  },
};

export function hasToolSchema(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_INPUTS, name);
}

/** 조건 검색과 공유하는 필드. 테스트가 이 목록으로 두 입구의 어긋남을 잡는다. */
export const SEARCH_TOOL_SHARED_FIELDS = SEARCH_FIELDS;

export type ToolArgsResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; message: string };

/**
 * 모델이 넘긴 인자를 검증한다.
 *
 * **실패를 모델에게 그대로 돌려준다.** 서버가 조용히 고쳐 주면 모델은 자기가 잘못
 * 넘겼다는 사실을 모른 채 다음 턴에도 같은 모양을 낸다. 다만 돌려주는 것은 zod 메시지
 * 뿐이며 사용자 입력·조회 결과를 실어 보내지 않는다(§5.3).
 */
export function parseToolArgs(name: string, raw: unknown): ToolArgsResult {
  const definition = TOOL_INPUTS[name];

  if (definition === undefined) {
    return { ok: false, message: `등록되지 않은 툴입니다: ${name}` };
  }

  const parsed = definition.schema.safeParse(raw ?? {});

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join(" / ");

    return { ok: false, message: detail };
  }

  return { ok: true, args: parsed.data as Record<string, unknown> };
}

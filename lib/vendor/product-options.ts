import type { ProductOptionInput } from "@/lib/core/schemas/product-option";

/**
 * 추가금 Route Handler·화면 공통 조각 (S2-04)
 *
 * `route.ts` 는 HTTP 메서드 외의 export 를 허용하지 않으므로 공유물을 여기에 둔다.
 */

export const OPTION_COLUMNS =
  "id, product_id, name, price, is_mandatory, trigger_condition, created_at, updated_at";

export type ProductOptionRow = {
  id: string;
  product_id: string;
  name: string;
  price: number;
  is_mandatory: boolean;
  trigger_condition: { description?: string | null } | null;
  created_at: string;
  updated_at: string;
};

/** 화면·요약 계산이 함께 쓰는 형태. `updatedAt` 은 재확정 판정에 쓴다. */
export type ProductOption = {
  id: string;
  name: string;
  price: number;
  isMandatory: boolean;
  conditionDescription: string | null;
  updatedAt: string;
};

/**
 * 최소 인터페이스만 요구한다.
 * Supabase 빌더 타입을 그대로 받으면 체인이 깊어 `TS2589`(instantiation too deep)가 난다.
 * 세션·서비스롤 클라이언트 양쪽을 받을 수 있어야 하므로 호출 지점에서 좁힌다.
 */
type OptionReader = { from: (table: string) => unknown };

type OptionQuery = {
  select: (columns: string) => {
    eq: (
      column: string,
      value: string,
    ) => {
      order: (
        column: string,
        options: { ascending: boolean },
      ) => PromiseLike<{ data: ProductOptionRow[] | null; error: unknown }>;
    };
  };
};

export function toProductOption(row: ProductOptionRow): ProductOption {
  return {
    id: row.id,
    name: row.name,
    price: row.price,
    isMandatory: row.is_mandatory,
    conditionDescription: row.trigger_condition?.description ?? null,
    updatedAt: row.updated_at,
  };
}

/** 상품의 추가금 목록. 금액 큰 순 — 고객이 먼저 봐야 할 것이 위에 온다. */
export async function loadOptions(client: OptionReader, productId: string): Promise<ProductOption[]> {
  const query = client.from("product_options") as OptionQuery;
  const { data } = await query
    .select(OPTION_COLUMNS)
    .eq("product_id", productId)
    .order("price", { ascending: false });

  return (data ?? []).map(toProductOption);
}

/**
 * 입력을 DB 행으로 옮긴다.
 * 발생 조건은 `trigger_condition.description` 에 담는다 — §3.3 이 정한 컬럼이며
 * 조건이 없는 필수 추가금은 빈 객체다(DB CHECK 가 이 규칙을 강제한다).
 */
export function toOptionRow(productId: string, input: Required<Pick<ProductOptionInput, "name" | "price">> & {
  isMandatory?: boolean;
  conditionDescription?: string | null;
}) {
  const isMandatory = input.isMandatory ?? false;

  return {
    product_id: productId,
    name: input.name,
    price: input.price,
    is_mandatory: isMandatory,
    trigger_condition:
      isMandatory || !input.conditionDescription ? {} : { description: input.conditionDescription },
  };
}

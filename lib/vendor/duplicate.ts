import { recordEvent } from "@/lib/audit/record";
import {
  copyRemainingSteps,
  draftCopyOf,
  type DuplicateSource,
} from "@/lib/core/vendor/product-duplicate";
import { createClient } from "@/lib/supabase/server";

import { PRODUCT_COLUMNS } from "./products";

/**
 * 상품 복제 (C-3 · F-V-03 · `POST /api/vendor/products/[id]/duplicate`)
 *
 * ── 세션 클라이언트로 읽고 쓴다 ────────────────────────────────────────────
 * `products` 는 **가격 테이블이라 RLS 가 owner 전용**으로 막고 있고(§3.9) 그것이
 * 최종 경계다. 서비스롤로 복제하면 **스태프가 부른 요청도 성공한다** — 화면에서만
 * 숨기는 상태가 되고, 그건 경계가 아니라 장식이다.
 *
 * 원본을 읽는 것도 세션으로 한다. 남의 업체 상품 id 를 넣으면 **RLS 가 0행을 주고**
 * 우리는 404 로 답한다 — **없는 것과 못 보는 것을 같게 답한다.**
 *
 * ── 왜 트랜잭션이 아닌가 ───────────────────────────────────────────────────
 * PostgREST 는 요청 하나가 트랜잭션 하나다. 상품과 추가금을 **두 번에 나눠 쓰므로**
 * 추가금 쪽이 실패하면 **추가금 없는 사본**이 남는다. 그래서 그 상태를 결함이 아니라
 * **정상 상태로 설계했다** — 사본은 어차피 `draft` 이고 `add_ons_declared_at` 이
 * 비어 있어 **게시될 수 없다**(DB CHECK). 업체는 목록에서 사본을 보고 추가금을
 * 채우거나 지운다. 절반 쓰인 사본이 고객에게 새어 나갈 길은 없다.
 */

export type DuplicateFailure = { status: number; code: string; message: string };
export type DuplicateResult = {
  productId: string;
  copiedOptionCount: number;
  /** 사본이 게시되기까지 남은 일. 화면이 그대로 적는다. */
  remainingSteps: string[];
};

export function isDuplicateFailure(
  value: DuplicateResult | DuplicateFailure,
): value is DuplicateFailure {
  return "code" in value;
}

const fail = (status: number, code: string, message: string): DuplicateFailure => ({
  status,
  code,
  message,
});

export async function duplicateProduct(input: {
  sourceId: string;
  actorId: string;
  actorRole: string | null;
}): Promise<DuplicateResult | DuplicateFailure> {
  const supabase = await createClient();

  const { data: sourceRow } = await supabase
    .from("products")
    .select(PRODUCT_COLUMNS)
    .eq("id", input.sourceId)
    .maybeSingle();

  const source = sourceRow as
    | {
        id: string;
        vendor_id: string;
        category: string;
        name: string;
        base_price_total: number;
        included_items_json: unknown[] | null;
        capacity_min: number | null;
        capacity_max: number | null;
        price_includes_vat: boolean | null;
      }
    | null;

  // **없는 것과 못 보는 것을 같게 답한다.**
  if (!source) {
    return fail(404, "VENDOR_PRODUCT_NOT_FOUND", "상품을 찾을 수 없습니다.");
  }

  const draftInput: DuplicateSource = {
    name: source.name,
    category: source.category,
    basePriceTotal: source.base_price_total,
    includedItems: source.included_items_json ?? [],
    capacityMin: source.capacity_min,
    capacityMax: source.capacity_max,
    priceIncludesVat: source.price_includes_vat ?? true,
  };
  const draft = draftCopyOf(draftInput);

  const { data: createdRow, error: createError } = await supabase
    .from("products")
    .insert({
      vendor_id: source.vendor_id,
      category: draft.category,
      name: draft.name,
      base_price_total: draft.basePriceTotal,
      included_items_json: draft.includedItems,
      capacity_min: draft.capacityMin,
      capacity_max: draft.capacityMax,
      price_includes_vat: draft.priceIncludesVat,
      status: draft.status,
      // **비우는 칸을 명시한다.** 기본값에 기대면 나중에 기본값이 바뀔 때 조용히 샌다.
      published_at: draft.publishedAt,
      add_ons_declared_at: draft.addOnsDeclaredAt,
    })
    .select("id")
    .maybeSingle();

  /**
   * **INSERT 의 RLS 위반은 에러(42501)로 온다** — UPDATE 처럼 0행이 아니다.
   * 500 으로 뭉뚱그리면 "권한 없음" 이 "서버 오류" 로 보이고, 스태프는 자기가
   * 뭘 잘못한 줄 안다(`/api/vendor/products` 의 같은 주석 참조).
   */
  if (createError?.code === "42501" || !createdRow) {
    return fail(
      403,
      "VENDOR_PRODUCT_FORBIDDEN",
      "상품·가격은 업체 대표 계정만 등록할 수 있습니다.",
    );
  }
  if (createError) {
    return fail(500, "VENDOR_PRODUCT_DUPLICATE_FAILED", "상품을 복제하지 못했습니다.");
  }

  const newId = (createdRow as { id: string }).id;

  // ── 추가금은 **항목만** 옮긴다. 확정은 옮기지 않는다(D-06) ────────────────
  const { data: optionRows } = await supabase
    .from("product_options")
    .select("name, price, is_mandatory, trigger_condition")
    .eq("product_id", source.id);

  const options = (optionRows ?? []) as {
    name: string;
    price: number;
    is_mandatory: boolean;
    trigger_condition: unknown;
  }[];

  let copiedOptionCount = 0;
  if (options.length > 0) {
    const { error: optionError } = await supabase.from("product_options").insert(
      options.map((option) => ({
        product_id: newId,
        name: option.name,
        price: option.price,
        is_mandatory: option.is_mandatory,
        trigger_condition: option.trigger_condition ?? {},
      })),
    );

    // **실패해도 사본은 남긴다**(머리말 참조). 다만 **몇 개를 옮겼는지 거짓으로
    // 세지 않는다** — 0 을 적고 화면이 "등록하고 확정해 주세요" 를 말하게 한다.
    copiedOptionCount = optionError ? 0 : options.length;
  }

  /**
   * 상태 변경을 증적으로 남긴다. **원본 내용을 이벤트에 담지 않는다**(§5.3 계열) —
   * 상품명·금액은 `products` 가 갖고 있고 이벤트는 "언제 누가 무엇에서 무엇을
   * 만들었는가" 만 든다.
   */
  await recordEvent({
    entityType: "product",
    entityId: newId,
    eventType: "product_duplicated",
    afterState: "draft",
    actor: { id: input.actorId, role: input.actorRole },
    memo: `from:${source.id}`,
  });

  return {
    productId: newId,
    copiedOptionCount,
    remainingSteps: copyRemainingSteps({ copiedOptionCount }),
  };
}

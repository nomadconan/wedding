import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, failValidation, ok } from "@/lib/api/response";
import { DYNAMIC_PRICE_NEEDS_DATE, availabilityOf } from "@/lib/core/schemas/explore";
import { priceProductsForDate } from "@/lib/explore/customer-price";
import { createPublicClient } from "@/lib/explore/query";

/**
 * GET /api/vendors/[id]/availability — 날짜별 잔여 슬롯 + 그 조건 가격
 * (F-C-11 · F-C-12, 명세서 §4.2)
 *
 * **비로그인도 부른다.** 익명 클라이언트로 조회하므로 승인되지 않은 업체(`status<>'active'`)나
 * 게시되지 않은 상품은 RLS 가 애초에 돌려주지 않는다.
 *
 * 가격 계산에 쓴 기준일(`asOf`)과 남은 일수를 **응답에 함께 싣는다** — 그래야 고객이 본
 * 금액을 나중에 재현할 수 있다(S2-06 의 결정성 판단과 같은 결).
 */
const QuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 YYYY-MM-DD 형식으로 입력해 주세요."),
});

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const parsed = QuerySchema.safeParse({ date: request.nextUrl.searchParams.get("date") ?? "" });
  if (!parsed.success) return failValidation(parsed.error.issues);

  const { date } = parsed.data;
  const client = createPublicClient();

  const { data: vendor } = await client
    .from("vendors")
    .select("id, name")
    .eq("id", params.id)
    .eq("status", "active")
    .maybeSingle();

  // 승인되지 않은 업체는 **존재 여부도 알리지 않는다.**
  if (!vendor) return fail(404, "VENDOR_NOT_FOUND", "업체를 찾을 수 없습니다.");

  const { data: slotRows } = await client
    .from("inventory_slots")
    .select("slot_time, product_id, capacity, remaining, status")
    .eq("vendor_id", params.id)
    .eq("slot_date", date)
    .order("slot_time", { ascending: true, nullsFirst: true });

  const slots = (slotRows ?? []) as {
    slot_time: string | null;
    product_id: string | null;
    capacity: number;
    remaining: number;
    status: string;
  }[];

  /**
   * 이 상품에 달린 슬롯 + 상품을 지정하지 않은 업체 전체 슬롯.
   * 다른 상품의 자리를 이 상품 자리라고 말하지 않기 위해 상품별로 갈라 본다(S2-05).
   */
  const slotsOf = (productId: string) =>
    slots.filter((slot) => slot.product_id === productId || slot.product_id === null);

  const { data: productRows } = await client
    .from("products")
    .select("id, name, base_price_total, price_includes_vat")
    .eq("vendor_id", params.id)
    .eq("status", "published")
    .not("add_ons_declared_at", "is", null);

  const products = (productRows ?? []) as {
    id: string;
    name: string;
    base_price_total: number;
    price_includes_vat: boolean;
  }[];

  // 기준일은 여기서 한 번만 만들고 계산·응답이 같은 값을 쓴다.
  const asOf = new Date().toISOString().slice(0, 10);

  // 잔여율 룰은 **그 상품의 잔여**로 판정해야 한다. 그래서 상품마다 따로 계산한다.
  let priced;
  try {
    priced = new Map(
      await Promise.all(
        products.map(async (product) => {
          const single = await priceProductsForDate(
            params.id,
            [{ productId: product.id, basePrice: product.base_price_total }],
            date,
            asOf,
            slotsOf(product.id),
          );

          return [product.id, single.get(product.id) ?? null] as const;
        }),
      ),
    );
  } catch {
    return fail(500, "VENDOR_PRICE_FAILED", "그날 가격을 계산하지 못했습니다.");
  }

  return ok({
    vendorId: vendor.id,
    date,
    // 업체 전체의 그날 상태. 상품별 상태는 아래 products[].availability 가 갖는다.
    availability: availabilityOf(slots),
    slots: slots.map((slot) => ({
      time: slot.slot_time,
      productId: slot.product_id,
      capacity: slot.capacity,
      remaining: slot.remaining,
      status: slot.status,
    })),
    products: products.map((product) => ({
      productId: product.id,
      name: product.name,
      priceIncludesVat: product.price_includes_vat,
      availability: availabilityOf(slotsOf(product.id)),
      price: priced.get(product.id) ?? null,
    })),
    notice: DYNAMIC_PRICE_NEEDS_DATE,
  });
}

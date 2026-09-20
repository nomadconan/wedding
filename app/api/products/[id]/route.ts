import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/response";
import { PENDING_SECTION_NOTE } from "@/lib/core/product/detail";
import { loadProductDetail } from "@/lib/products/detail-query";

/**
 * GET /api/products/[id] — 상품 한 개의 **공개** 상세 (C-2c · F-C-38 · §4.2)
 *
 * ── 로그인을 요구하지 않는다 ────────────────────────────────────────────────
 * 탐색은 비로그인도 가능해야 한다(§1.4). 그래서 세션을 보지 않고 **익명
 * 클라이언트**로 읽으며 **RLS 가 그대로 경계**다 — 게시되지 않은 상품·심사 중
 * 업체의 상품은 여기서 404 다(그 사실을 구분해 알려 주지 않는다).
 *
 * ── 업체를 쿼리로 받는다 ────────────────────────────────────────────────────
 * `?vendor=` 가 있으면 **그 업체의 상품일 때만** 돌려준다. 화면 경로가
 * `/explore/[vendorId]/[productId]` 라 같은 짝을 API 도 확인할 수 있어야
 * 한다 — 없으면 화면만 짝을 보고 API 는 안 보는 상태가 된다.
 * 없으면 상품이 가리키는 업체를 그대로 쓴다.
 *
 * ── 정렬 기준 배지가 없다 ───────────────────────────────────────────────────
 * 이 응답에는 **정렬도 추천도 없다**(상품 하나다). §2.2 가 요구하는 정렬 기준
 * 코드는 목록 API(`GET /api/vendors`)의 몫이며 여기서 붙이면 **없는 정렬이
 * 있는 것처럼** 보인다.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const requestedVendor = request.nextUrl.searchParams.get("vendor");

  // 업체를 안 받았으면 상품이 가리키는 업체로 한 번 더 읽는다. 두 번 읽는 대신
  // 로더에 업체를 넘겨야 하므로, 먼저 상품의 업체를 알아낸다.
  const vendorId = requestedVendor ?? (await vendorOf(id));
  if (!vendorId) return fail(404, "PRODUCT_NOT_FOUND", "상품을 찾을 수 없습니다.");

  const detail = await loadProductDetail({ vendorId, productId: id });
  if (!detail) return fail(404, "PRODUCT_NOT_FOUND", "상품을 찾을 수 없습니다.");

  return ok({
    product: detail,
    /**
     * **아직 열지 않은 자리를 응답이 말한다.** 빈 배열로 두면 "후기가 0건" 과
     * "후기 기능이 아직 없다" 가 같은 모양이 된다(C-2a 가 어휘에서 가른 것과 같다).
     */
    pending: PENDING_SECTION_NOTE,
  });
}

/** 상품이 가리키는 업체. 익명 정책이 공개 상품만 준다. */
async function vendorOf(productId: string): Promise<string | null> {
  const { createPublicClient } = await import("@/lib/explore/query");

  const { data } = await createPublicClient()
    .from("products")
    .select("vendor_id")
    .eq("id", productId)
    .maybeSingle();

  return (data as { vendor_id: string } | null)?.vendor_id ?? null;
}

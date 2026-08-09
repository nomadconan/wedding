import { ADD_ONS_PUBLISH_BLOCKER } from "@/lib/core/schemas/product-option";
import { productPublishBlockers } from "@/lib/core/schemas/product";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 상품 Route Handler 공통 조각 (S2-03)
 *
 * Route 파일(`route.ts`)은 HTTP 메서드 외의 export 를 허용하지 않으므로
 * 두 핸들러가 함께 쓰는 것들을 여기에 둔다.
 */

/** 화면·API 가 함께 읽는 컬럼 집합. 한 곳에서 관리해야 응답 모양이 갈라지지 않는다. */
export const PRODUCT_COLUMNS =
  "id, vendor_id, category, name, base_price_total, included_items_json, capacity_min, capacity_max, status, published_at, price_includes_vat, add_ons_declared_at, created_at, updated_at";

/**
 * 세션 사용자가 속한 업체.
 * **클라이언트가 보낸 vendor_id 를 신뢰하지 않는다** — 서비스롤로 조회하되 대상은
 * 항상 세션에서 확인한 user id 로 좁힌다.
 */
export async function findMemberVendor(
  userId: string,
): Promise<{ id: string; category: string } | null> {
  const admin = createAdminClient();

  const { data: member } = await admin
    .from("vendor_members")
    .select("vendor_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  if (!member) return null;

  const { data: vendor } = await admin
    .from("vendors")
    .select("id, category")
    .eq("id", member.vendor_id)
    .maybeSingle();

  return vendor ?? null;
}

/**
 * DB 행을 게시 체크리스트 입력으로 옮긴다. 화면·API·DB 가 같은 조건을 본다.
 *
 * 추가금 확정(F-V-04)이 조건에 들어 있는 이유: 사전 미등록 항목은 사후 청구할 수 없으므로
 * **미확정 상품이 고객에게 보이면 안 된다.** 고객이 본 총액이 나중에 늘어날 수 있다는 뜻이다.
 */
export function publishBlockersOf(row: {
  name: string;
  base_price_total: number;
  included_items_json: unknown;
  add_ons_declared_at?: string | null;
}) {
  const blockers = productPublishBlockers({
    name: row.name,
    basePriceTotal: row.base_price_total,
    includedItems: Array.isArray(row.included_items_json) ? row.included_items_json : [],
  });

  if (!row.add_ons_declared_at) blockers.push({ ...ADD_ONS_PUBLISH_BLOCKER });

  return blockers;
}

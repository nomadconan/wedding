import {
  CANDIDATE_REASON_ORDER,
  type InquiryCandidate,
  type InquiryCandidateReason,
} from "@/lib/core/inquiry/request-form";
import { createClient } from "@/lib/supabase/server";

/**
 * 문의 후보 업체 — **서버 전용 로더** (FIX-66 · F-C-13)
 *
 * ── 왜 검색이 아니라 후보인가 ──────────────────────────────────────────────
 * 표준 요청 폼 안에 업체 **검색**을 넣으면 `/explore` 를 한 번 더 만드는 셈이다.
 * 커플은 이미 마음에 드는 곳을 **찜하거나 장바구니에 담아** 두었고, 그 둘이 곧
 * "같은 조건으로 비교하고 싶은 후보" 다. 그래서 여기서는 **이미 고른 것**을 모은다.
 *
 * 업체 상세에서 오는 길(`?vendor=`)은 그 업체를 후보에 **더해서** 넘긴다 —
 * 찜하지 않았어도 지금 보고 있던 곳이면 후보다.
 *
 * ── 승인된 업체만 담는다 ───────────────────────────────────────────────────
 * 서버(`createInquiry`)가 **`status='active'` 인 업체만 남긴다.** 화면이 심사 중인
 * 업체를 후보로 그리면 **고를 수 있는데 안 가는 자리**가 되고, 그건 화면이 시스템이
 * 거부할 일을 시키는 것이다. 여기서 같은 조건으로 미리 거른다.
 *
 * ── 타입·라벨은 여기 없다 ──────────────────────────────────────────────────
 * `lib/core/inquiry/request-form.ts` 에 있다. **폼이 클라이언트 컴포넌트**라 여기서
 * 가져가면 `lib/supabase/server.ts` 를 통해 `next/headers` 가 클라이언트 번들로
 * 끌려온다 — `tsc` 는 통과하고 **Next 가 런타임에 500 을 낸다.** 실제로 그랬다.
 *
 * ── 계산 가능한 값을 저장하지 않는다 ───────────────────────────────────────
 * 후보 목록을 표로 만들지 않는다. `wishlists`·`cart_items` 가 이미 갖고 있고
 * 이 함수는 **읽어서 합칠 뿐**이다.
 */
export async function loadInquiryCandidates(input: {
  coupleId: string;
  /** 업체 상세에서 온 경우 그 업체. 후보에 없더라도 더한다. */
  viewingVendorId?: string | null;
}): Promise<InquiryCandidate[]> {
  const supabase = await createClient();

  // RLS 가 자기 커플 것만 보여준다.
  const [{ data: wishRows }, { data: cartRows }] = await Promise.all([
    supabase.from("wishlists").select("vendor_id").eq("couple_id", input.coupleId),
    supabase.from("cart_items").select("vendor_id"),
  ]);

  const reasons = new Map<string, InquiryCandidateReason>();
  for (const row of (cartRows ?? []) as { vendor_id: string }[]) {
    reasons.set(row.vendor_id, "cart");
  }
  // 찜이 장바구니를 덮는다 — 둘 다면 '찜' 으로 적는다(고객이 먼저 한 표시다).
  for (const row of (wishRows ?? []) as { vendor_id: string }[]) {
    reasons.set(row.vendor_id, "wishlist");
  }
  if (input.viewingVendorId) reasons.set(input.viewingVendorId, "viewing");

  if (reasons.size === 0) return [];

  const { data: vendorRows } = await supabase
    .from("vendors")
    .select("id, name, category")
    .in("id", [...reasons.keys()])
    // **승인된 곳만.** 서버가 어차피 거르므로 화면도 같은 조건으로 그린다.
    .eq("status", "active")
    .order("name");

  return ((vendorRows ?? []) as { id: string; name: string; category: string }[])
    .map((vendor) => ({
      id: vendor.id,
      name: vendor.name,
      category: vendor.category,
      reason: reasons.get(vendor.id) ?? ("cart" as InquiryCandidateReason),
    }))
    .sort(
      (a, b) =>
        CANDIDATE_REASON_ORDER[a.reason] - CANDIDATE_REASON_ORDER[b.reason] ||
        a.name.localeCompare(b.name),
    );
}

import { CartActions } from "@/components/domain/CartActions";
import { choicesFor, loadCartTargets } from "@/lib/cart/loader";
import { findMyCouple } from "@/lib/couple/membership";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * 상품 상세의 찜·장바구니 (C-2c · F-C-38)
 *
 * **`VendorProducts` 와 같은 함수를 쓴다.** 목록과 상세가 다른 방식으로 세면
 * "담김" 표시가 두 화면에서 갈린다 — 같은 상품인데 한쪽은 담겼다고 하고 한쪽은
 * 아니라고 한다. 경계는 RLS 다(세션으로 읽는다).
 *
 * 세션이 필요해서 페이지에서 떼어 냈다. 이 조각이 페이지 안에 있으면 상품 상세가
 * 통째로 동적이 되고, 그러면 비로그인에게도 캐시가 안 된다.
 */
export async function ProductCartActions({
  vendorId,
  productId,
}: {
  vendorId: string;
  productId: string;
}) {
  const user = await getSessionUser();

  if (!user) {
    // **비로그인에게도 버튼을 보인다.** 누르면 로그인으로 보내고 돌아온다 —
    // 숨기면 "이 상품은 담을 수 없나?" 로 읽힌다.
    return (
      <CartActions
        productId={productId}
        vendorId={vendorId}
        inCart={false}
        carts={[]}
        inWishlist={false}
        signedIn={false}
        next={`/explore/${vendorId}/${productId}`}
      />
    );
  }

  const membership = await findMyCouple(user.id);
  const targets = membership ? await loadCartTargets(await createClient(), membership.coupleId) : null;

  const wished = membership ? await wishedProducts(membership.coupleId, productId) : false;

  return (
    <CartActions
      productId={productId}
      vendorId={vendorId}
      inCart={(targets?.productCarts.get(productId) ?? []).length > 0}
      carts={targets ? choicesFor(targets, productId) : []}
      inWishlist={wished}
      signedIn
      next={`/explore/${vendorId}/${productId}`}
    />
  );
}

/** 이 상품이 우리 커플의 찜 목록에 있는가. 버튼 표시에만 쓴다. */
async function wishedProducts(coupleId: string, productId: string): Promise<boolean> {
  const { data } = await createAdminClient()
    .from("wishlists")
    .select("product_id")
    .eq("couple_id", coupleId)
    .eq("product_id", productId)
    .maybeSingle();

  return Boolean(data);
}

export default ProductCartActions;

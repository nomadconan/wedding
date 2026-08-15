import { choicesFor, loadCartTargets } from "@/lib/cart/loader";
import { findMyCouple } from "@/lib/couple/membership";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * 목록에 붙는 **보는 사람의 상태** — 담김·찜 (S3-03 · S7-02)
 *
 * 목록 화면이 둘이 됐다(`/explore` · `/search`). 카드가 같으면 카드에 넘길 상태도 같아야
 * 하는데, 그걸 화면마다 따로 만들면 **한쪽만 고치는 날**이 온다(장바구니가 여러 개가 된
 * IDEA-01 때 실제로 그런 종류의 수정이 있었다). 그래서 여기로 옮겼다.
 *
 * **세션으로 읽는다.** 서비스롤로 읽으면 "내 커플 것만 보인다" 는 경계가 RLS 가 아니라
 * `eq("couple_id", ...)` 를 잊지 않는 코드가 된다.
 */
type CartTargets = Awaited<ReturnType<typeof loadCartTargets>>;

export type ViewerState = {
  targets: CartTargets | null;
  wished: Set<string>;
};

export const EMPTY_VIEWER: ViewerState = { targets: null, wished: new Set<string>() };

export async function loadViewerState(userId: string | null): Promise<ViewerState> {
  if (userId === null) return EMPTY_VIEWER;

  const membership = await findMyCouple(userId);
  if (membership === null) return EMPTY_VIEWER;

  const targets = await loadCartTargets(await createClient(), membership.coupleId);

  const admin = createAdminClient();
  const { data } = await admin
    .from("wishlists")
    .select("product_id")
    .eq("couple_id", membership.coupleId)
    .not("product_id", "is", null);

  return {
    targets,
    wished: new Set((data ?? []).map((row) => (row as { product_id: string }).product_id)),
  };
}

/** 카드에 넘길 담기 선택지. 비로그인·미연동이면 빈 목록이다. */
export function cartChoicesFor(state: ViewerState, productId: string) {
  return state.targets ? choicesFor(state.targets, productId) : [];
}

export function isInCart(state: ViewerState, productId: string): boolean {
  return (state.targets?.productCarts.get(productId) ?? []).length > 0;
}

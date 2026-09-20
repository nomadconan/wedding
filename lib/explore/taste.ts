import { normalizeStyleTags } from "@/lib/core/product/concept";
import { findMyCouple } from "@/lib/couple/membership";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/supabase/auth";

/**
 * 온보딩 취향 읽기 (C-2d · F-C-10 확장 · B-1 §1-2)
 *
 * **비로그인에게는 아무것도 하지 않는다.** 취향은 커플에 붙은 값이라 세션이 없으면
 * 빈 배열이고, 그러면 `/explore` 는 지금까지와 똑같이 동작한다 — 검색으로 들어온
 * 사람의 화면이 바뀌지 않는다.
 *
 * `couples` 는 커플 구성원만 읽는 표라 **서비스롤로 읽되 대상은 세션에서 확인한
 * 커플 하나로 좁힌다**(`findMyCouple` 이 그 판정을 한다 — 다른 로더들과 같은 방식).
 */
export async function myStyleTags(): Promise<string[]> {
  const user = await getSessionUser();
  if (!user) return [];

  const membership = await findMyCouple(user.id);
  if (!membership) return [];

  const { data } = await createAdminClient()
    .from("couples")
    .select("style_tags")
    .eq("id", membership.coupleId)
    .maybeSingle();

  // 어휘 밖 값은 여기서 걸러진다 — 필터로 넘어가면 0건이 나오고 이유를 알 수 없다.
  return normalizeStyleTags(((data?.style_tags ?? []) as string[]) ?? []);
}

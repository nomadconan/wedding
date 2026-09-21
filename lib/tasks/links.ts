import {
  taskLinks,
  vendorCategoriesForTask,
  type BridgeGap,
  type TaskLinks,
} from "@/lib/core/task/links";
import type { VendorCategory } from "@/lib/core/schemas/vendor";
import { createClient } from "@/lib/supabase/server";

/**
 * 준비 항목 → 정보·상품 다리를 **세어서** 만든다 (C-4c · F-C-39)
 *
 * 순수 판정은 `lib/core/task/links.ts` 가 하고 여기서는 **읽기만** 한다.
 *
 * ── 세션 클라이언트로 읽는다 ────────────────────────────────────────────────
 * 상품·가이드·커뮤니티 글은 전부 **공개 데이터**이고 공개 정책이 이미 초안·비공개·
 * 삭제된 것을 가린다. 서비스롤로 읽으면 **아직 공개되지 않은 것까지 세게 되고**,
 * 그 수는 사용자가 목록에서 보는 수와 달라진다 — 세는 것과 보이는 것이 다르면
 * 그 수는 거짓말이다.
 *
 * ── 카테고리 단위로 한 번씩만 읽는다 ────────────────────────────────────────
 * 체크리스트에는 태스크가 스물다섯 개 넘게 있고 그중 다수가 **같은 카테고리**다.
 * 태스크마다 질의하면 같은 답을 스물다섯 번 세게 된다. 그래서 화면은 **카테고리
 * 집합**을 넘기고 여기서 한 번씩만 읽는다.
 */

export type TaskLinksByCategory = Readonly<Record<string, TaskLinks>>;

/** 가이드 다리에 몇 편까지 보여 줄지. 목록이 아니라 **다리**라 짧게 끊는다. */
const GUIDE_LIMIT = 3;

/**
 * 준비 카테고리 여러 개에 대한 다리를 한 번에 만든다.
 *
 * `narrowed` 는 `tasks.vendor_category` 로 **행마다 좁혀진** 카테고리다(C-2a).
 * 좁힌 태스크는 준비 카테고리가 같아도 다른 곳으로 가므로 키를 따로 갖는다 —
 * 키 형식은 `<prep>` 또는 `<prep>:<vendor>` 이며 `linkKeyFor()` 가 만든다.
 */
export function linkKeyFor(input: {
  category: string;
  vendorCategory?: string | null;
}): string {
  return input.vendorCategory ? `${input.category}:${input.vendorCategory}` : input.category;
}

export async function loadTaskLinks(
  keys: readonly { category: string; vendorCategory?: string | null }[],
): Promise<TaskLinksByCategory> {
  const unique = new Map<string, { category: string; vendorCategory: string | null }>();

  for (const key of keys) {
    unique.set(linkKeyFor(key), {
      category: key.category,
      vendorCategory: key.vendorCategory ?? null,
    });
  }

  if (unique.size === 0) return {};

  const supabase = await createClient();

  // ── 무엇을 세어야 하는지 먼저 정한다 ──────────────────────────────────────
  const resolved = new Map<string, readonly VendorCategory[] | BridgeGap>();
  const vendorCategories = new Set<VendorCategory>();
  const prepCategories = new Set<string>();

  for (const [key, value] of unique) {
    const answer = vendorCategoriesForTask(value);

    resolved.set(key, answer);
    prepCategories.add(value.category);

    if (!("kind" in answer)) for (const code of answer) vendorCategories.add(code);
  }

  // ── 상품 수 ───────────────────────────────────────────────────────────────
  //
  // **행을 받아서 센다.** `count: "exact", head: true` 는 카테고리별로 나눌 수
  // 없어 질의가 카테고리 수만큼 늘어난다. 공개 상품은 지금 한 자리 수준이고,
  // 늘면 뷰나 집계로 옮긴다.
  const productCounts = new Map<string, number>();

  for (const code of vendorCategories) productCounts.set(code, 0);

  if (vendorCategories.size > 0) {
    /**
     * **`status`·업체 상태를 명시해서 센다.**
     *
     * 공개 정책만 믿으면 안 된다 — `products_select_member` 가 **업체 멤버에게는
     * 자기 초안까지** 보여 준다. 업체 대표도 자기 체크리스트를 보는데, 그때 이
     * 수가 `/explore` 가 보여 주는 수보다 커진다. **세는 것과 보이는 것이 다르면
     * 그 수는 거짓말이다.**
     */
    const { data } = await supabase
      .from("products")
      .select("category, vendors!inner(status)")
      .in("category", [...vendorCategories])
      .eq("status", "published")
      .eq("vendors.status", "active");

    for (const row of (data ?? []) as { category: string }[]) {
      productCounts.set(row.category, (productCounts.get(row.category) ?? 0) + 1);
    }
  }

  // ── 가이드 ────────────────────────────────────────────────────────────────
  //
  // 공개 정책이 초안·발행 예약을 가린다. 여기서 `published_at` 을 다시 거르지
  // 않는 이유는 **두 곳에서 같은 판정을 하면 한쪽만 고쳐지기** 때문이다.
  const guidesByPrep = new Map<string, { slug: string; title: string }[]>();

  for (const prep of prepCategories) guidesByPrep.set(prep, []);

  if (prepCategories.size > 0) {
    const { data } = await supabase
      .from("content_posts")
      .select("slug, title, prep_category, published_at")
      .in("prep_category", [...prepCategories])
      .order("published_at", { ascending: false });

    for (const row of (data ?? []) as {
      slug: string;
      title: string;
      prep_category: string | null;
    }[]) {
      if (row.prep_category === null) continue;

      const list = guidesByPrep.get(row.prep_category);

      if (list && list.length < GUIDE_LIMIT) list.push({ slug: row.slug, title: row.title });
    }
  }

  // ── 커뮤니티 글 수 ────────────────────────────────────────────────────────
  //
  // **조회수·좋아요로 줄 세우지 않는다**(D-26). 여기서는 세기만 하고, 순서는
  // 목적지 화면이 자기 정렬 기준으로 정한다.
  const communityCounts = new Map<string, number>();

  for (const prep of prepCategories) communityCounts.set(prep, 0);

  if (prepCategories.size > 0) {
    const { data } = await supabase
      .from("community_posts")
      .select("category")
      .in("category", [...prepCategories])
      .eq("status", "published");

    for (const row of (data ?? []) as { category: string | null }[]) {
      if (row.category === null) continue;

      communityCounts.set(row.category, (communityCounts.get(row.category) ?? 0) + 1);
    }
  }

  // ── 묶는다 ────────────────────────────────────────────────────────────────
  const out: Record<string, TaskLinks> = {};

  for (const [key, value] of unique) {
    out[key] = taskLinks({
      category: value.category,
      vendorCategories: resolved.get(key) as readonly VendorCategory[] | BridgeGap,
      productCounts,
      guides: guidesByPrep.get(value.category) ?? [],
      communityPostCount: communityCounts.get(value.category) ?? 0,
    });
  }

  return out;
}

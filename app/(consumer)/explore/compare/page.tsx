import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { buildCartCompare, buildCompare } from "@/lib/cart/compare";
import { loadCarts, pickCartBySeq } from "@/lib/cart/loader";
import {
  CART_COMPARE_MODES,
  SINGLE_CART_NOTICE,
  defaultCompareMode,
  type CartCompareMode,
} from "@/lib/core/cart/multi-cart";
import {
  COMPARE_EMPTY_TITLE,
  COMPARE_EXCLUDED_NOTICE,
  COMPARE_PLANNER_BASES,
  type ComparePlannerBasis,
} from "@/lib/core/schemas/compare";
import { findMyCouple } from "@/lib/couple/membership";
import { createPublicClient } from "@/lib/explore/query";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { CartCompareTable } from "./CartCompareTable";
import { CompareControls } from "./CompareControls";
import { CompareTable } from "./CompareTable";

export const metadata: Metadata = {
  title: "업체 비교 — 웨딩클리어",
};

/**
 * /explore/compare (F-C-10, §6.2 — "장바구니 기반 병렬 비교표, 실총액 기준 정렬")
 *
 * 로그인이 필요하다. 미인증 차단은 **미들웨어**가 한다 — 화면의 `requireUser()` 는
 * 스트리밍이 시작된 뒤라 상태 코드를 바꾸지 못한다(S3-01).
 *
 * 로딩 상태는 `loading.tsx` 가 아니라 **페이지 안쪽 Suspense** 다. 라우트 파일로 두면
 * 그 경계가 형제 세그먼트(`/explore/[vendorId]`)의 `notFound()` 까지 삼킨다(S3-03).
 *
 * ── 두 층위 (IDEA-01) ───────────────────────────────────────────────────────
 * **항목 단위 비교를 장바구니 단위로 대체하지 않는다.** 둘은 다른 질문에 답한다 —
 * "어느 상품이 조건에 맞나"(항목)와 "어느 조합이 예산에 맞나"(장바구니). 대체하면
 * 드레스 A·B 를 견주는 일이 불가능해지고 그것은 F-C-10 의 본래 요구다.
 *
 * 그래서 `?mode=` 로 갈라 둘을 다 남기고, **어느 쪽을 먼저 보일지만** 정한다 —
 * 활성 장바구니가 둘 이상이면 조합끼리, 하나면 항목끼리다(`defaultCompareMode`).
 * 장바구니를 여러 개 만든 사람은 조합을 견주려고 만든 것이다.
 *
 * 항목 모드에서 **어느 장바구니의 항목인가**는 `?cart=<순번>` 이 갖는다 — `/cart` 와
 * 같은 파라미터라 두 화면을 오갈 때 선택이 유지된다.
 */
export default async function ComparePage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  await requireUser("/explore/compare");

  const rawBasis = typeof searchParams.basis === "string" ? searchParams.basis : "";
  const basis: ComparePlannerBasis = (COMPARE_PLANNER_BASES as readonly string[]).includes(rawBasis)
    ? (rawBasis as ComparePlannerBasis)
    : "as_selected";

  const rawMode = typeof searchParams.mode === "string" ? searchParams.mode : "";
  const mode: CartCompareMode | null = (CART_COMPARE_MODES as readonly string[]).includes(rawMode)
    ? (rawMode as CartCompareMode)
    : null;

  const selected = Array.isArray(searchParams.items)
    ? searchParams.items
    : typeof searchParams.items === "string"
      ? [searchParams.items]
      : [];

  const rawSeq = typeof searchParams.cart === "string" ? Number(searchParams.cart) : NaN;
  const seq = Number.isInteger(rawSeq) && rawSeq >= 1 ? rawSeq : null;

  return (
    <ConsumerShell
      title="비교"
      headerAction={
        <Link href="/cart" className="text-caption font-medium text-brand-600">
          장바구니
        </Link>
      }
    >
      <Suspense
        key={`${mode ?? "auto"}:${basis}:${seq ?? ""}:${selected.join(",")}`}
        fallback={<LoadingState label="비교표를 만드는 중" rows={4} variant="block" />}
      >
        <CompareSection basis={basis} mode={mode} selected={selected} seq={seq} />
      </Suspense>
    </ConsumerShell>
  );
}

async function CompareSection({
  basis,
  mode,
  selected,
  seq,
}: {
  basis: ComparePlannerBasis;
  mode: CartCompareMode | null;
  selected: string[];
  seq: number | null;
}) {
  const user = await requireUser("/explore/compare");
  const membership = await findMyCouple(user.id);

  if (!membership) {
    return (
      <ErrorState
        code="COUPLE_NOT_FOUND"
        title="먼저 온보딩을 마쳐 주세요"
        description="비교는 커플 장바구니를 기준으로 해요."
      />
    );
  }

  const admin = createAdminClient();
  const { data: members } = await admin
    .from("couple_members")
    .select("user_id")
    .eq("couple_id", membership.coupleId)
    .in("member_role", ["owner", "partner"]);

  const supabase = await createClient();

  // 장바구니와 **같은 함수**로 읽는다. 두 화면이 다른 금액을 말하지 않게 하는 유일한 방법이다.
  const view = await loadCarts(supabase, createPublicClient(), {
    coupleId: membership.coupleId,
    viewerId: user.id,
    memberIds: (members ?? []).map((row) => (row as { user_id: string }).user_id),
  });

  const effectiveMode = mode ?? defaultCompareMode(view.carts.length);

  if (view.carts.length === 0) {
    return (
      <EmptyState
        assetId="explore.empty"
        title={COMPARE_EMPTY_TITLE}
        description="장바구니에 담으면 담은 만큼 나란히 견줄 수 있어요."
        action={
          <Link href="/explore" className="text-sm font-medium text-brand-600">
            업체 둘러보기
          </Link>
        }
      />
    );
  }

  // ── 장바구니끼리 ──────────────────────────────────────────────────────────
  if (effectiveMode === "carts") {
    const compare = buildCartCompare(view, { basis, selected: [] });

    return (
      <div className="space-y-5" data-testid="compare-view" data-mode="carts">
        <CompareControls
          mode="carts"
          basis={compare.basis}
          plannerMixed={false}
          items={[]}
          selected={[]}
          cartCount={view.carts.length}
        />

        {view.carts.length < 2 ? (
          <p className="text-caption text-muted-foreground" data-testid="single-cart-notice">
            {SINGLE_CART_NOTICE}
          </p>
        ) : null}

        <CartCompareTable view={compare} />
      </div>
    );
  }

  // ── 담은 항목끼리 (S3-07 의 표를 그대로 쓴다) ─────────────────────────────
  const cart = pickCartBySeq(view, seq);

  if (cart === null) {
    return (
      <EmptyState
        assetId="explore.empty"
        title={COMPARE_EMPTY_TITLE}
        description="장바구니에 담으면 담은 만큼 나란히 견줄 수 있어요."
      />
    );
  }

  const compare = buildCompare(cart, { basis, selected });

  if (compare.totalItemCount === 0) {
    return (
      <div className="space-y-5" data-testid="compare-view" data-mode="items">
        <CompareControls
          mode="items"
          basis={basis}
          plannerMixed={false}
          items={[]}
          selected={[]}
          cartCount={view.carts.length}
        />
        <EmptyState
          assetId="explore.empty"
          title={COMPARE_EMPTY_TITLE}
          description={
            compare.excludedCount > 0
              ? COMPARE_EXCLUDED_NOTICE
              : `${cart.label}에 담은 것이 없어요. 담으면 담은 만큼 나란히 견줄 수 있어요.`
          }
          action={
            <Link href="/explore" className="text-sm font-medium text-brand-600">
              업체 둘러보기
            </Link>
          }
        />
      </div>
    );
  }

  const pickerItems = cart.items
    .filter((item) => item.visibility.kind === "visible")
    .map((item) => ({
      itemId: item.itemId,
      label: `${item.vendorName ?? "업체"} · ${item.productName ?? "상품"}`,
    }));

  return (
    <div className="space-y-5" data-testid="compare-view" data-mode="items">
      <CompareControls
        mode="items"
        basis={compare.basis}
        plannerMixed={compare.plannerMixed}
        items={pickerItems}
        selected={compare.selected}
        cartCount={view.carts.length}
      />

      {/* 어느 장바구니의 항목을 보고 있는지 밝힌다 — 여러 개가 되면 표만 보고는 알 수 없다. */}
      <p className="text-caption text-muted-foreground" data-testid="compare-source-cart">
        {cart.seq}. {cart.label}에 담은 항목을 견주고 있어요.
      </p>

      {compare.groups.length === 0 ? (
        <EmptyState
          assetId="explore.empty"
          title="고른 항목이 없어요"
          description="위에서 비교할 항목을 골라 주세요."
        />
      ) : (
        compare.groups.map((group) => <CompareTable key={group.category} group={group} />)
      )}

      {/* 뺐다는 사실을 감추지 않는다. 조용히 빼면 왜 안 보이는지 알 수 없다(S3-05 와 같은 결). */}
      {compare.excludedCount > 0 ? (
        <p className="text-caption text-warning" data-testid="compare-excluded">
          지금은 볼 수 없는 항목 {compare.excludedCount}건은 비교에서 뺐어요.{" "}
          {COMPARE_EXCLUDED_NOTICE}
        </p>
      ) : null}
    </div>
  );
}

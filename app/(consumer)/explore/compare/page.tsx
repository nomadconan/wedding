import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { buildCompare } from "@/lib/cart/compare";
import { loadCart } from "@/lib/cart/loader";
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

  const selected = Array.isArray(searchParams.items)
    ? searchParams.items
    : typeof searchParams.items === "string"
      ? [searchParams.items]
      : [];

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
        key={`${basis}:${selected.join(",")}`}
        fallback={<LoadingState label="비교표를 만드는 중" rows={4} variant="block" />}
      >
        <CompareSection basis={basis} selected={selected} />
      </Suspense>
    </ConsumerShell>
  );
}

async function CompareSection({
  basis,
  selected,
}: {
  basis: ComparePlannerBasis;
  selected: string[];
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
  const cart = await loadCart(supabase, createPublicClient(), {
    coupleId: membership.coupleId,
    viewerId: user.id,
    memberIds: (members ?? []).map((row) => (row as { user_id: string }).user_id),
  });

  const compare = buildCompare(cart, { basis, selected });

  if (compare.totalItemCount === 0) {
    return (
      <EmptyState
        assetId="explore.empty"
        title={COMPARE_EMPTY_TITLE}
        description={
          compare.excludedCount > 0
            ? COMPARE_EXCLUDED_NOTICE
            : "장바구니에 담으면 담은 만큼 나란히 견줄 수 있어요."
        }
        action={
          <Link href="/explore" className="text-sm font-medium text-brand-600">
            업체 둘러보기
          </Link>
        }
      />
    );
  }

  const pickerItems = cart.items
    .filter((item) => item.visibility.kind === "visible")
    .map((item) => ({
      itemId: item.itemId,
      label: `${item.vendorName ?? "업체"} · ${item.productName ?? "상품"}`,
    }));

  return (
    <div className="space-y-5" data-testid="compare-view">
      <CompareControls
        basis={compare.basis}
        plannerMixed={compare.plannerMixed}
        items={pickerItems}
        selected={compare.selected}
      />

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

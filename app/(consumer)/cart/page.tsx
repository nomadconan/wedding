import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { loadCarts, pickCartBySeq } from "@/lib/cart/loader";
import { findMyCouple } from "@/lib/couple/membership";
import { createPublicClient } from "@/lib/explore/query";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { CartWorkspace } from "./CartWorkspace";

export const metadata: Metadata = {
  title: "장바구니 — 웨딩클리어",
};

/**
 * /cart (F-C-25, §6.2) — 여러 장바구니 (IDEA-01)
 *
 * 로그인이 필요하다. 미인증 차단은 **미들웨어**가 한다 — 화면의 `requireUser()` 만으로는
 * 스트리밍이 시작된 뒤라 상태 코드를 바꾸지 못한다(S3-01 에서 확인).
 *
 * 로딩 상태는 `loading.tsx` 가 아니라 **페이지 안쪽 Suspense** 다. 라우트 파일로 두면
 * 그 경계가 자식 라우트까지 감싸 `notFound()`·리다이렉트의 상태 코드를 삼킨다(S3-03).
 *
 * **어느 장바구니를 볼지는 `?cart=<순번>` 이 갖는다.** 순번을 쓴 이유는 링크가 읽히기
 * 때문이다("/cart?cart=2"). 활성 장바구니끼리 순번이 유일하므로(0027 `uq_carts_couple_seq`)
 * 가리키는 대상은 하나뿐이며, 낡은 링크는 첫 번째 장바구니로 떨어진다.
 */
export default async function CartPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  await requireUser("/cart");

  const raw = typeof searchParams.cart === "string" ? Number(searchParams.cart) : NaN;
  const seq = Number.isInteger(raw) && raw >= 1 ? raw : null;

  return (
    <ConsumerShell
      title="장바구니"
      headerAction={
        <Link href="/wishlist" className="text-caption font-medium text-brand-600">
          찜
        </Link>
      }
    >
      <Suspense
        key={String(seq)}
        fallback={<LoadingState label="장바구니를 불러오는 중" rows={3} variant="list" />}
      >
        <CartSection seq={seq} />
      </Suspense>
    </ConsumerShell>
  );
}

async function CartSection({ seq }: { seq: number | null }) {
  const user = await requireUser("/cart");
  const membership = await findMyCouple(user.id);

  if (!membership) {
    return (
      <ErrorState
        code="COUPLE_NOT_FOUND"
        title="먼저 온보딩을 마쳐 주세요"
        description="장바구니는 커플 단위로 공유돼요."
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

  const view = await loadCarts(supabase, createPublicClient(), {
    coupleId: membership.coupleId,
    viewerId: user.id,
    memberIds: (members ?? []).map((row) => (row as { user_id: string }).user_id),
  });

  return <CartWorkspace view={view} selected={pickCartBySeq(view, seq)} />;
}

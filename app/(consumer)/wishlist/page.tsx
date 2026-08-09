import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { loadWishlist } from "@/lib/cart/wishlist";
import { findMyCouple } from "@/lib/couple/membership";
import { createPublicClient } from "@/lib/explore/query";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { WishlistView } from "./WishlistView";

export const metadata: Metadata = {
  title: "찜 — 웨딩클리어",
};

/** /wishlist (F-C-26, §6.2). 미인증 차단은 미들웨어가 한다(S3-01). */
export default async function WishlistPage() {
  await requireUser("/wishlist");

  return (
    <ConsumerShell
      title="찜"
      headerAction={
        <Link href="/cart" className="text-caption font-medium text-brand-600">
          장바구니
        </Link>
      }
    >
      <Suspense fallback={<LoadingState label="찜을 불러오는 중" rows={3} variant="list" />}>
        <WishlistSection />
      </Suspense>
    </ConsumerShell>
  );
}

async function WishlistSection() {
  const user = await requireUser("/wishlist");
  const membership = await findMyCouple(user.id);

  if (!membership) {
    return (
      <ErrorState
        code="COUPLE_NOT_FOUND"
        title="먼저 온보딩을 마쳐 주세요"
        description="찜은 커플 단위로 공유돼요."
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

  const { items, unavailableCount } = await loadWishlist(supabase, createPublicClient(), {
    viewerId: user.id,
    memberIds: (members ?? []).map((row) => (row as { user_id: string }).user_id),
  });

  return <WishlistView items={items} unavailableCount={unavailableCount} />;
}

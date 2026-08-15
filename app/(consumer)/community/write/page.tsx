import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { COMMUNITY_FLAG, isFeatureEnabled } from "@/lib/flags";
import { createPublicClient } from "@/lib/explore/query";
import { requireUser } from "@/lib/supabase/auth";

export const metadata: Metadata = {
  title: "글쓰기 — 웨딩클리어",
};

import { WriteView } from "./WriteView";

/**
 * /community/write — 글쓰기 (F-C-32·33 · 명세서 §6.2)
 *
 * **업체 목록을 서버에서 내려준다.** 본문 필터가 클라이언트에서 돌아야 타이핑 중에
 * 제안할 수 있고, 그러려면 등록 업체명이 필요하다. **승인된 업체만** 익명 클라이언트로
 * 읽으므로(RLS) 심사 중인 업체 이름이 새어 나가지 않는다.
 *
 * 목록이 커지면 이 방식은 무거워진다 — 그때는 서버 제안(디바운스 조회)으로 옮긴다.
 * 지금 그렇게 하지 않는 이유는 타이핑마다 왕복이 생기고, 초기 업체 수가 적기 때문이다.
 */
export default async function CommunityWritePage() {
  if (!(await isFeatureEnabled(COMMUNITY_FLAG))) notFound();

  await requireUser("/community/write");

  const { data } = await createPublicClient()
    .from("vendors")
    .select("id, name")
    .eq("status", "active")
    .limit(500);

  return (
    <ConsumerShell title="글쓰기" activeTab="/home">
      <WriteView vendors={(data ?? []) as { id: string; name: string }[]} />
    </ConsumerShell>
  );
}

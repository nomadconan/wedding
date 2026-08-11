import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ContactPathGuide } from "@/components/domain/ContactPathGuide";
import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { loadQnaPosts, loadVendorName } from "@/lib/qna/loader";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { QnaBoardView } from "./QnaBoardView";

export const metadata: Metadata = {
  title: "문의게시판 — 웨딩클리어",
};

/**
 * /qna/[vendorId] (F-C-28, §6.2)
 *
 * **로그인 없이도 읽는다.** 공개글은 anon SELECT 가 열려 있고(0021), 비공개글은
 * 작성자·해당 업체만 보인다 — 그 판정은 RLS 가 하므로 여기서 다시 거르지 않는다.
 * 쓰기만 로그인이 필요하고, 그 안내는 화면이 한다.
 *
 * 업체 조회를 **Suspense 밖**에 둔다. 응답이 흘러나가면 상태 코드가 200 으로 굳어
 * `notFound()` 가 404 를 못 만든다(업체 상세와 같은 판단).
 */
export default async function QnaBoardPage({ params }: { params: { vendorId: string } }) {
  const supabase = await createClient();
  const vendor = await loadVendorName(supabase, params.vendorId);

  // 없는 것과 못 보는 것을 구분해 알려 주지 않는다 — 심사 중 업체의 존재도 정보다.
  if (!vendor) notFound();

  const user = await getSessionUser();
  const posts = await loadQnaPosts(supabase, {
    vendorId: vendor.id,
    viewerId: user?.id ?? null,
  });

  return (
    <ConsumerShell title={`${vendor.name} 문의`}>
      <div className="space-y-4">
        <ContactPathGuide current="qna" vendorId={vendor.id} />

        <QnaBoardView
          vendorId={vendor.id}
          initialPosts={posts}
          signedIn={user !== null}
          viewerId={user?.id ?? null}
        />
      </div>
    </ConsumerShell>
  );
}

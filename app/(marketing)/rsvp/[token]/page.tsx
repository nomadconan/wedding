import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import type { RsvpStatus } from "@/lib/core/guest/guest";

import { RsvpForm } from "./RsvpForm";

/**
 * /rsvp/[token] — 하객 참석 응답 (F-C-22 · §6.2 신설)
 *
 * **로그인 없이 열린다.** 토큰을 가진 것이 곧 권한이며(S7-12 의 공유 화면과 같은
 * 모양), 그래서 지켜야 하는 것이 둘이다 —
 *
 *  1. **정적으로 굳지 않는다.** 쿠키를 읽지 않는 경로라 Next 가 캐시할 수 있고,
 *     그러면 **회수된 링크가 계속 열린다**(FIX-22 계열). `force-dynamic` + `no-store`.
 *  2. **없는 링크는 404 다.** 소프트 404(200 + '없어요')를 내보내면 검색엔진에 빈
 *     페이지가 쌓이고, 무엇보다 **틀린 주소와 회수된 링크를 구분할 수 없게** 된다.
 *
 * **하단 탭을 숨긴다.** 이 화면에 온 사람은 우리 서비스의 사용자가 아니라 **하객**이며,
 * 답을 하러 왔다. 탭을 보이면 우리 앱을 쓰라는 권유가 되고 그건 이 화면의 일이 아니다.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "참석 여부 알려주기 — 웨딩클리어",
  // **색인하지 않는다.** 초대 링크는 검색 결과에 나올 값이 아니다.
  robots: { index: false, follow: false, nocache: true },
};

type Context = {
  guest_name: string;
  wedding_date: string | null;
  rsvp_status: string;
  party_size: number;
  closed: boolean;
};

/** 자기 클라이언트를 만들고 `no-store` 를 못 박는다(라우트와 같은 이유). */
function createRsvpClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) throw new Error("Supabase 공개 환경변수가 설정되지 않았습니다.");

  return createSupabaseClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      fetch: (input, init) => fetch(input as RequestInfo, { ...init, cache: "no-store" }),
    },
  });
}

export default async function RsvpPage({ params }: { params: { token: string } }) {
  const { data } = await createRsvpClient()
    .rpc("invite_context", { p_token: params.token })
    .maybeSingle();

  const context = (data ?? null) as Context | null;

  if (context === null) notFound();

  return (
    <ConsumerShell title="참석 여부" hideTabBar>
      <RsvpForm
        guestName={context.guest_name}
        weddingDate={context.wedding_date}
        initialStatus={context.rsvp_status as RsvpStatus}
        initialPartySize={context.party_size}
        closed={context.closed}
      />
    </ConsumerShell>
  );
}

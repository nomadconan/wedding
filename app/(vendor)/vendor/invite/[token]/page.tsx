import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getSessionUser } from "@/lib/supabase/auth";
import { previewInvite } from "@/lib/vendor/invites";

import { AcceptInviteView } from "./AcceptInviteView";

export const metadata: Metadata = {
  title: "업체 초대 — 웨딩클리어",
};

/**
 * /vendor/invite/[token] (S2-09)
 *
 * 초대 메일의 링크가 여기로 온다.
 *
 * ── 셸을 쓰지 않는다 ────────────────────────────────────────────────────────
 * `AdminShell` 은 업체 내비게이션을 그리는데, 이 화면에 오는 사람은 **아직 멤버가
 * 아니다**. 가리킬 수 없는 메뉴를 띄우면 눌러도 아무 데도 못 간다. 그래서 한 화면
 * 한 일만 하는 단독 레이아웃이다(온보딩이 `hideTabBar` 를 쓴 것과 같은 판단).
 *
 * **로그인 없이도 열린다** — 어느 업체가 불렀는지 먼저 보여주고 로그인으로 보낸다.
 * 이메일은 마스킹해서 내려온다(토큰만으로 남의 이메일을 알 수 없게).
 */
export default async function VendorInvitePage({ params }: { params: { token: string } }) {
  const invite = await previewInvite(params.token, new Date());

  // 없는 토큰과 남의 토큰을 구분해 알려 주지 않는다 — 404 로 통일한다.
  if (!invite) notFound();

  const user = await getSessionUser();

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-consumer flex-col justify-center px-gutter py-10">
      <AcceptInviteView
        token={params.token}
        invite={invite}
        signedIn={user !== null}
        accountEmail={user?.email ?? null}
      />
    </main>
  );
}

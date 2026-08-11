import type { Metadata } from "next";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { loadRooms, loadSlaThreshold } from "@/lib/chat/loader";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { ChatRoomsView } from "./ChatRoomsView";

export const metadata: Metadata = {
  title: "채팅 — 웨딩클리어",
};

/**
 * /chat (F-C-27, §6.2)
 *
 * 로그인이 필요하다. 미인증 차단은 미들웨어가 한다(S3-01).
 * 로딩 상태는 `loading.tsx` 가 아니라 페이지 안쪽 Suspense 다(S3-03).
 *
 * 하단 탭에 넣지 않았다 — 탭은 다섯이 상한이고 이미 찼다(BottomTabNav 주석).
 * 진입은 홈의 '최근 대화' 와 업체 상세의 '문의하기' 두 곳이다.
 */
export default async function ChatPage() {
  await requireUser("/chat");

  return (
    <ConsumerShell title="채팅">
      <Suspense fallback={<LoadingState label="대화를 불러오는 중" rows={4} variant="list" />}>
        <ChatRoomsSection />
      </Suspense>
    </ConsumerShell>
  );
}

async function ChatRoomsSection() {
  const user = await requireUser("/chat");
  const supabase = await createClient();

  try {
    // RLS 가 자기 커플의 방만 보여준다 — 여기서 couple_id 로 다시 거르지 않는다.
    const rooms = await loadRooms(supabase, {
      viewerId: user.id,
      side: "couple",
      threshold: await loadSlaThreshold(),
      now: new Date(),
    });

    return <ChatRoomsView initialRooms={rooms} />;
  } catch {
    return (
      <ErrorState
        code="CHAT_ROOMS_LOAD_FAILED"
        title="대화를 불러오지 못했어요"
        description="잠시 후 다시 시도해 주세요."
      />
    );
  }
}

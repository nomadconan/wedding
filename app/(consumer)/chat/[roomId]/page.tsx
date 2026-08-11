import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BrokerNotice } from "@/components/domain/BrokerNotice";
import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { loadMessages, loadMyLastRead, loadRoom } from "@/lib/chat/loader";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { ChatRoomView } from "./ChatRoomView";

export const metadata: Metadata = {
  title: "대화 — 웨딩클리어",
};

/**
 * /chat/[roomId] (F-C-27, §6.2)
 *
 * 방 조회를 **Suspense 밖**에 둔다. 응답이 한 번 흘러나가면 상태 코드가 200 으로
 * 굳어 `notFound()` 가 404 를 못 만든다(업체 상세와 같은 판단).
 *
 * **없는 것과 못 보는 것을 구분해 알려 주지 않는다** — 남의 대화방이 존재한다는
 * 사실 자체가 정보다. RLS 가 걸러 준 결과를 그대로 404 로 만든다.
 */
export default async function ChatRoomPage({ params }: { params: { roomId: string } }) {
  const user = await requireUser(`/chat/${params.roomId}`);
  const supabase = await createClient();

  const loaded = await loadRoom(supabase, params.roomId);
  if (!loaded) notFound();

  const [messages, lastReadAt] = await Promise.all([
    loadMessages(supabase, params.roomId),
    loadMyLastRead(supabase, params.roomId),
  ]);

  return (
    <ConsumerShell
      title={loaded.vendorName}
      headerAction={
        <Link
          href={`/explore/${loaded.room.vendor_id}`}
          className="text-caption font-medium text-brand-600"
        >
          업체 보기
        </Link>
      }
    >
      <div className="space-y-3">
        <ChatRoomView
          roomId={params.roomId}
          status={loaded.room.status}
          viewerId={user.id}
          initialMessages={messages}
          initialLastReadAt={lastReadAt}
        />

        {/* 거래로 이어지는 화면이므로 중개자 지위를 고지한다(D-24 · §6). */}
        <BrokerNotice variant="inline" />
      </div>
    </ConsumerShell>
  );
}

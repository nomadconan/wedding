import type { Metadata } from "next";
import Link from "next/link";

import { AdminShell } from "@/components/layout/AdminShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { loadRooms, loadSlaThreshold } from "@/lib/chat/loader";
import { SLA_UNSET_NOTE, inboxOrder } from "@/lib/core/chat/chat";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { loadVendorMembers } from "@/lib/vendor/members";
import { findMemberVendor } from "@/lib/vendor/products";

import { VendorChatView } from "./VendorChatView";

export const metadata: Metadata = {
  title: "채팅 응대 — 웨딩클리어",
};

/**
 * /vendor/chat (F-V-15, §6.3)
 *
 * **staff 도 들어온다.** S2-07 이 staff 에게서 막은 것은 가격·정산이고 고객 응대는
 * 그 둘이 아니다 — 담당자를 배정해 놓고 대표만 답할 수 있으면 배정이 무의미하다.
 * DB 도 같은 판단이다: 0021 의 정책은 `is_vendor_member` 이지 `is_vendor_owner` 가
 * 아니다.
 *
 * 인박스는 **미응답이 위**다(F-V-15). 정렬 규칙은 `lib/core` 의 순수 함수가 갖고
 * 화면·API 가 같은 함수를 쓴다.
 */
export default async function VendorChatPage() {
  const user = await requireUser("/vendor/chat");
  const vendor = await findMemberVendor(user.id);

  if (!vendor) {
    return (
      <AdminShell role="vendor" title="채팅 응대">
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              assetId="vendor.dashboard.empty"
              title="아직 등록된 업체가 없어요"
              description="입점 신청을 마치면 고객 문의를 받을 수 있습니다."
              action={
                <Button size="touch" asChild>
                  <Link href="/vendor/apply">입점 신청하러 가기</Link>
                </Button>
              }
            />
          </CardContent>
        </Card>
      </AdminShell>
    );
  }

  const supabase = await createClient();
  const threshold = await loadSlaThreshold();

  try {
    const rooms = inboxOrder(
      await loadRooms(supabase, {
        viewerId: user.id,
        side: "vendor",
        vendorId: vendor.id,
        threshold,
        now: new Date(),
      }),
    );

    const members = (await loadVendorMembers(vendor.id)).map((member) => ({
      userId: member.userId,
      displayName: member.displayName,
      role: member.role,
    }));

    return (
      <AdminShell
        role="vendor"
        title="채팅 응대"
        description={
          threshold
            ? `응답 기준 ${threshold.minutes}분. 미응답 대화가 위에 옵니다.`
            : SLA_UNSET_NOTE
        }
      >
        <VendorChatView
          initialRooms={rooms}
          members={members}
          viewerId={user.id}
          slaConfigured={threshold !== null}
        />
      </AdminShell>
    );
  } catch {
    return (
      <AdminShell role="vendor" title="채팅 응대">
        <ErrorState
          code="CHAT_ROOMS_LOAD_FAILED"
          title="대화를 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }
}

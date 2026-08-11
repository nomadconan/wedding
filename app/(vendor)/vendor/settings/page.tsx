import type { Metadata } from "next";
import Link from "next/link";

import { AdminShell } from "@/components/layout/AdminShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { loadInvites } from "@/lib/vendor/invites";
import { loadVendorMembers } from "@/lib/vendor/members";
import { findMemberVendor } from "@/lib/vendor/products";
import { loadVendorChannelPrefs, loadVendorSettings } from "@/lib/vendor/settings";
import { loadTemplates } from "@/lib/vendor/templates";

import { VendorSettingsView } from "./VendorSettingsView";

export const metadata: Metadata = {
  title: "설정 — 웨딩클리어",
};

/**
 * /vendor/settings (F-V-14, §6.3)
 *
 * **`/vendor/profile` 안의 섹션이 아니라 별도 라우트로 만들었다.** 커버리지 표가
 * S4-14 에 그 결정을 맡겼고, 근거는 셋이다 —
 *  1. `AdminShell` 이 이미 `/vendor/settings` 를 가리키고 있어 **지금은 404** 다.
 *     없는 화면을 가리키는 링크는 "만들어 두고 켜지 않은 것" 이 아니라 깨진 것이다.
 *  2. 프로필(소개·미디어)과 성격이 다르다 — 이쪽은 **조직 운영 설정**이다.
 *  3. 권한이 다르다. 프로필은 멤버가 고치지만 알림 수신 대상·영업시간은 대표만이다.
 *
 * 로딩 상태는 페이지 안쪽이 아니라 서버에서 한 번에 읽는다 — 설정 화면은 조각이
 * 서로 얽혀 있어(담당자 목록이 멤버에 달렸다) 나눠 스트리밍할 이득이 없다.
 */
export default async function VendorSettingsPage() {
  const user = await requireUser("/vendor/settings");
  const vendor = await findMemberVendor(user.id);

  if (!vendor) {
    return (
      <AdminShell role="vendor" title="설정">
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              assetId="vendor.dashboard.empty"
              title="아직 등록된 업체가 없어요"
              description="입점 신청을 마치면 알림·담당자·영업시간을 설정할 수 있습니다."
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

  try {
    const members = await loadVendorMembers(vendor.id);
    const isOwner = members.some(
      (member) => member.userId === user.id && member.role === "owner",
    );

    return (
      <AdminShell
        role="vendor"
        title="설정"
        description="알림 수신 대상·영업시간·템플릿·멤버 초대를 관리해요."
      >
        <VendorSettingsView
          initialSettings={await loadVendorSettings(supabase, vendor.id)}
          initialChannels={await loadVendorChannelPrefs(supabase, vendor.id)}
          initialTemplates={await loadTemplates(supabase, vendor.id)}
          initialInvites={await loadInvites(supabase, vendor.id, new Date())}
          members={members.map((member) => ({
            userId: member.userId,
            displayName: member.displayName,
            role: member.role,
          }))}
          isOwner={isOwner}
        />
      </AdminShell>
    );
  } catch {
    return (
      <AdminShell role="vendor" title="설정">
        <ErrorState
          code="VENDOR_SETTINGS_LOAD_FAILED"
          title="설정을 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }
}

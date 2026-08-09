import type { Metadata } from "next";
import Link from "next/link";

import { AdminShell } from "@/components/layout/AdminShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import {
  STAFF_RESTRICTIONS,
  VENDOR_MEMBER_ROLES,
  VENDOR_MEMBER_ROLE_DESCRIPTION,
  VENDOR_MEMBER_ROLE_LABEL,
} from "@/lib/core/schemas/vendor-member";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { loadVendorMembers } from "@/lib/vendor/members";
import { findMemberVendor } from "@/lib/vendor/products";

import { MembersPanel } from "./MembersPanel";

export const metadata: Metadata = {
  title: "멤버 관리 — 웨딩클리어",
};

/**
 * /vendor/members (F-V-13, §6.3)
 *
 * 멤버 목록은 이메일을 함께 보여줘야 해서 **서비스롤**로 읽는다(`auth.users` 는
 * 클라이언트에서 조회할 수 없다). 대상은 "이 업체의 멤버" 로만 좁힌다.
 * 관리 권한(owner) 판정은 세션 클라이언트로 하고, 최종 경계는 RLS·트리거다.
 */
export default async function VendorMembersPage() {
  const user = await requireUser("/vendor/members");
  const supabase = await createClient();
  const vendor = await findMemberVendor(user.id);

  if (!vendor) {
    return (
      <AdminShell role="vendor" title="멤버 관리">
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              assetId="vendor.dashboard.empty"
              title="아직 등록된 업체가 없어요"
              description="입점 신청을 마치면 함께 일할 멤버를 초대할 수 있습니다."
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

  const { data: membership, error } = await supabase
    .from("vendor_members")
    .select("vendor_role")
    .eq("vendor_id", vendor.id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    return (
      <AdminShell role="vendor" title="멤버 관리">
        <ErrorState
          code="VENDOR_MEMBER_LOAD_FAILED"
          title="멤버 정보를 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }

  const canManage = membership?.vendor_role === "owner";
  const members = await loadVendorMembers(vendor.id);
  const owners = members.filter((member) => member.role === "owner").length;

  return (
    <AdminShell
      role="vendor"
      title="멤버 관리"
      description={`전체 ${members.length}명 · 대표 ${owners}명`}
    >
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">멤버</CardTitle>
            <CardDescription>
              대표는 최소 1명이 남아 있어야 하며, 자기 자신은 제거할 수 없습니다.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {members.length === 0 ? (
              <EmptyState
                title="멤버가 없습니다"
                description="업체 대표 계정이 연결되지 않은 상태입니다. 운영자에게 문의해 주세요."
              />
            ) : (
              <MembersPanel members={members} currentUserId={user.id} canManage={canManage} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">역할이 할 수 있는 일</CardTitle>
            <CardDescription>
              권한은 화면이 아니라 데이터베이스에서 강제됩니다. 담당자 계정으로는 아래 항목이
              아예 저장되지 않습니다.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="grid gap-3 sm:grid-cols-2">
              {VENDOR_MEMBER_ROLES.map((code) => (
                <div key={code} className="rounded-lg border border-border p-3">
                  <dt className="text-sm font-medium">{VENDOR_MEMBER_ROLE_LABEL[code]}</dt>
                  <dd className="mt-1 text-caption text-muted-foreground">
                    {VENDOR_MEMBER_ROLE_DESCRIPTION[code]}
                  </dd>
                </div>
              ))}
            </dl>

            <div className="rounded-lg border border-warning bg-warning-surface p-3">
              <p className="text-sm font-medium text-warning-foreground">
                담당자가 할 수 없는 일
              </p>
              <ul className="mt-1 space-y-0.5">
                {STAFF_RESTRICTIONS.map((item) => (
                  <li key={item} className="text-caption text-warning-foreground">
                    · {item}
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>
    </AdminShell>
  );
}

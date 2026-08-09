import type { Metadata } from "next";
import Link from "next/link";

import { AdminShell } from "@/components/layout/AdminShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { VENDOR_CATEGORY_LABEL, type VendorCategory } from "@/lib/core/schemas/vendor";
import {
  VENDOR_PROFILE_FIELD_LABEL,
  type VendorFacility,
  type VendorMediaType,
} from "@/lib/core/schemas/vendor-profile";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { VendorProfileForm, type MediaItem } from "./VendorProfileForm";

export const metadata: Metadata = {
  title: "업체 프로필 — 웨딩클리어",
};

/**
 * /vendor/profile (F-V-02, §6.3)
 *
 * 프로필 조회는 **사용자 세션 클라이언트**로 한다 — RLS 가 자기 업체만 보여준다.
 * 변경 이력(`audit_logs`)만 서비스롤로 읽는다. 이 테이블에는 SELECT 정책이 없고
 * §3.9 가 운영 데이터는 서비스롤 경유로 규정하기 때문이다.
 */
const HISTORY_LIMIT = 20;

/** 공개 버킷이라 경로가 그대로 URL 이 된다. 비공개 버킷과 달리 서명이 필요 없다. */
function publicMediaUrl(storagePath: string): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

  return `${base}/storage/v1/object/public/vendor-media/${storagePath}`;
}

export default async function VendorProfilePage() {
  const user = await requireUser("/vendor/profile");
  const supabase = await createClient();

  const { data: vendor, error } = await supabase
    .from("vendors")
    .select(
      "id, name, category, status, region_code, address, address_detail, capacity_min, capacity_max, facilities, intro",
    )
    .limit(1)
    .maybeSingle();

  if (error) {
    return (
      <AdminShell role="vendor" title="업체 프로필">
        <ErrorState
          code="VENDOR_PROFILE_LOAD_FAILED"
          title="프로필을 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }

  if (!vendor) {
    return (
      <AdminShell role="vendor" title="업체 프로필">
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              assetId="vendor.dashboard.empty"
              title="아직 등록된 업체가 없어요"
              description="입점 신청을 마치면 프로필을 채울 수 있습니다."
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

  // 수정 권한은 owner 뿐이다. 화면 체크는 UX 보조이고 최종 경계는 RLS 다(§1.4 NOTE).
  const { data: membership } = await supabase
    .from("vendor_members")
    .select("vendor_role")
    .eq("vendor_id", vendor.id)
    .eq("user_id", user.id)
    .maybeSingle();

  const canEdit = membership?.vendor_role === "owner";

  const { data: media } = await supabase
    .from("vendor_media")
    .select("id, type, storage_path, sort_order, alt_text")
    .eq("vendor_id", vendor.id)
    .order("sort_order", { ascending: true });

  const admin = createAdminClient();
  const { data: history } = await admin
    .from("audit_logs")
    .select("id, action, actor_id, before_json, after_json, created_at")
    .eq("target_type", "vendor")
    .eq("target_id", vendor.id)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);

  const mediaItems: MediaItem[] = (media ?? []).map((row) => ({
    id: row.id,
    type: row.type as VendorMediaType,
    altText: row.alt_text,
    publicUrl: publicMediaUrl(row.storage_path),
  }));

  return (
    <AdminShell
      role="vendor"
      title="업체 프로필"
      description="고객 탐색 화면에 그대로 노출되는 정보입니다."
      action={
        <Badge variant={vendor.status === "active" ? "default" : "secondary"}>
          {vendor.status === "active" ? "공개 중" : "비공개(심사 전)"}
        </Badge>
      }
    >
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">기본 정보</CardTitle>
            <CardDescription>
              업체명과 카테고리는 심사 근거 정보라 여기서 바꾸지 않습니다. 변경하려면 재심사가
              필요합니다.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-2 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-unit text-muted-foreground">업체명</dt>
                <dd className="font-medium">{vendor.name}</dd>
              </div>
              <div>
                <dt className="text-unit text-muted-foreground">카테고리</dt>
                <dd className="font-medium">
                  {VENDOR_CATEGORY_LABEL[vendor.category as VendorCategory] ?? vendor.category}
                </dd>
              </div>
              <div>
                <dt className="text-unit text-muted-foreground">공개 상태</dt>
                <dd className="font-medium">
                  {vendor.status === "active" ? "고객에게 노출 중" : "심사 완료 후 노출"}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">프로필·미디어</CardTitle>
            <CardDescription>
              위치·수용 인원·시설·소개문과 사진·영상을 관리합니다.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <VendorProfileForm
              canEdit={canEdit}
              defaults={{
                regionCode: vendor.region_code ?? "",
                address: vendor.address ?? "",
                addressDetail: vendor.address_detail ?? "",
                capacityMin: vendor.capacity_min === null ? "" : String(vendor.capacity_min),
                capacityMax: vendor.capacity_max === null ? "" : String(vendor.capacity_max),
                facilities: (vendor.facilities ?? []) as VendorFacility[],
                intro: vendor.intro ?? "",
              }}
              media={mediaItems}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">변경 이력</CardTitle>
            <CardDescription>
              프로필·심사 관련 변경을 기록합니다. 최근 {HISTORY_LIMIT}건까지 보여줍니다.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!history || history.length === 0 ? (
              <EmptyState
                title="아직 변경 이력이 없어요"
                description="프로필을 저장하면 무엇이 언제 바뀌었는지 여기에 남습니다."
              />
            ) : (
              <ul className="space-y-3" data-testid="profile-history">
                {history.map((row) => {
                  const before = (row.before_json ?? {}) as Record<string, unknown>;
                  const after = (row.after_json ?? {}) as Record<string, unknown>;
                  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])];

                  return (
                    <li key={row.id} className="border-b border-border pb-3 last:border-0 last:pb-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{row.action}</Badge>
                        <span className="text-caption text-muted-foreground">
                          {row.created_at.slice(0, 16).replace("T", " ")}
                        </span>
                        {row.actor_id === user.id ? (
                          <span className="text-caption text-muted-foreground">· 내 변경</span>
                        ) : null}
                      </div>

                      {fields.length > 0 ? (
                        <ul className="mt-1 space-y-0.5">
                          {fields.map((field) => (
                            <li key={field} className="text-caption text-muted-foreground">
                              {VENDOR_PROFILE_FIELD_LABEL[field] ?? field}
                              {": "}
                              <span className="line-through">{String(before[field] ?? "-")}</span>
                              {" → "}
                              <span className="text-foreground">{String(after[field] ?? "-")}</span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminShell>
  );
}

import type { Metadata } from "next";

import { AdminShell } from "@/components/layout/AdminShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Separator } from "@/components/ui/separator";
import {
  VENDOR_APPLICATION_STATUS_LABEL,
  VENDOR_CATEGORY_LABEL,
  VENDOR_DOC_TYPE_LABEL,
  type VendorApplicationStatus,
  type VendorCategory,
  type VendorDocType,
} from "@/lib/core/schemas/vendor";
import { maskPhone } from "@/lib/core/vendor/business-number";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { VendorApplyForm } from "./VendorApplyForm";

export const metadata: Metadata = {
  title: "입점 신청 — 웨딩클리어",
};

/**
 * /vendor/apply (F-V-01, §6.3)
 *
 * 신청 폼과 **심사 상태 추적**(신청 → 보완요청 → 승인·반려)을 한 화면에 둔다.
 * 신청자가 자기 상태를 확인하려고 다른 화면을 찾아다니지 않게 하기 위해서다.
 *
 * 조회는 **사용자 세션 클라이언트**로 한다 — RLS 가 자기 신청서만 보이도록 거른다.
 * 서비스롤을 쓰면 화면 코드가 경계가 되어버린다(§1.4 NOTE).
 */
const STATUS_VARIANT: Record<VendorApplicationStatus, "default" | "secondary" | "destructive"> = {
  submitted: "secondary",
  revision_requested: "destructive",
  approved: "default",
  rejected: "destructive",
};

const STATUS_GUIDE: Record<VendorApplicationStatus, string> = {
  submitted: "제출한 서류를 심사하고 있습니다. 결과는 이 화면과 알림으로 알려드립니다.",
  revision_requested: "보완이 필요합니다. 아래 사유를 확인하고 서류를 다시 제출해 주세요.",
  approved: "입점이 승인되었습니다. 상품·가격을 등록하면 고객에게 노출됩니다.",
  rejected: "신청이 반려되었습니다. 사유를 확인한 뒤 다시 신청할 수 있습니다.",
};

export default async function VendorApplyPage() {
  const user = await requireUser("/vendor/apply");
  const supabase = await createClient();

  const { data: application, error } = await supabase
    .from("vendor_applications")
    .select(
      "id, vendor_id, status, review_note, submitted_at, reviewed_at, representative_name, contact_phone, mail_order_no, biz_no_masked, biz_no_verified_at",
    )
    .eq("applicant_id", user.id)
    .maybeSingle();

  const { data: vendor } = application
    ? await supabase
        .from("vendors")
        .select("id, name, category, region_code, status")
        .eq("id", application.vendor_id)
        .maybeSingle()
    : { data: null };

  const { data: documents } = application
    ? await supabase
        .from("vendor_documents")
        .select("id, doc_type, verified_at, created_at")
        .eq("vendor_id", application.vendor_id)
        .order("created_at", { ascending: true })
    : { data: null };

  if (error) {
    return (
      <AdminShell role="vendor" title="입점 신청">
        <ErrorState
          code="VENDOR_APPLICATION_LOAD_FAILED"
          title="신청 정보를 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }

  const status = (application?.status ?? null) as VendorApplicationStatus | null;
  const canEdit = status === null || status === "revision_requested" || status === "rejected";

  return (
    <AdminShell
      role="vendor"
      title="입점 신청"
      description="심사에 필요한 정보와 서류를 제출합니다. 승인 후 상품을 등록할 수 있습니다."
      action={
        status ? (
          <Badge variant={STATUS_VARIANT[status]} data-testid="application-status">
            {VENDOR_APPLICATION_STATUS_LABEL[status]}
          </Badge>
        ) : null
      }
    >
      <div className="space-y-6">
        {status ? (
          <Card data-testid="application-summary">
            <CardHeader>
              <CardTitle className="text-base">심사 상태</CardTitle>
              <CardDescription>{STATUS_GUIDE[status]}</CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
              {/* 신청 → 보완 → 승인·반려 진행 표시 */}
              <ol className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
                {(
                  [
                    ["submitted", "신청"],
                    ["revision_requested", "보완 요청"],
                    ["approved", "승인"],
                  ] as const
                ).map(([key, label], index) => (
                  <li key={key} className="flex items-center gap-2">
                    {index > 0 ? <span aria-hidden="true">→</span> : null}
                    <span
                      className={
                        status === key || (key === "submitted" && status !== "rejected")
                          ? "font-medium text-foreground"
                          : undefined
                      }
                    >
                      {label}
                    </span>
                  </li>
                ))}
                {status === "rejected" ? (
                  <li className="flex items-center gap-2">
                    <span aria-hidden="true">·</span>
                    <span className="font-medium text-danger">반려</span>
                  </li>
                ) : null}
              </ol>

              {application?.review_note ? (
                <div className="rounded-lg border border-border bg-muted p-3">
                  <p className="text-caption font-medium text-muted-foreground">심사 의견</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{application.review_note}</p>
                </div>
              ) : null}

              <Separator />

              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <div className="flex justify-between gap-3 sm:block">
                  <dt className="text-unit text-muted-foreground">업체명</dt>
                  <dd className="font-medium">{vendor?.name ?? "-"}</dd>
                </div>
                <div className="flex justify-between gap-3 sm:block">
                  <dt className="text-unit text-muted-foreground">카테고리</dt>
                  <dd className="font-medium">
                    {vendor?.category
                      ? (VENDOR_CATEGORY_LABEL[vendor.category as VendorCategory] ?? vendor.category)
                      : "-"}
                  </dd>
                </div>
                <div className="flex justify-between gap-3 sm:block">
                  <dt className="text-unit text-muted-foreground">사업자등록번호</dt>
                  <dd className="font-medium">{application?.biz_no_masked ?? "-"}</dd>
                </div>
                <div className="flex justify-between gap-3 sm:block">
                  <dt className="text-unit text-muted-foreground">담당자 연락처</dt>
                  {/* 신청자 화면에서는 마스킹해 보여준다(§7.3). */}
                  <dd className="font-medium">
                    {application?.contact_phone ? maskPhone(application.contact_phone) : "-"}
                  </dd>
                </div>
                <div className="flex justify-between gap-3 sm:block">
                  <dt className="text-unit text-muted-foreground">업체 공개 상태</dt>
                  <dd className="font-medium">
                    {vendor?.status === "active" ? "공개 중" : "비공개(심사 전)"}
                  </dd>
                </div>
                <div className="flex justify-between gap-3 sm:block">
                  <dt className="text-unit text-muted-foreground">사업자 상태 확인</dt>
                  <dd className="font-medium">
                    {application?.biz_no_verified_at ? "운영자 확인 완료" : "확인 전"}
                  </dd>
                </div>
              </dl>

              {documents && documents.length > 0 ? (
                <div className="space-y-1">
                  <p className="text-unit text-muted-foreground">제출 서류</p>
                  <ul className="space-y-1 text-sm">
                    {documents.map((doc) => (
                      <li key={doc.id} className="flex items-center gap-2">
                        <span aria-hidden="true">·</span>
                        {VENDOR_DOC_TYPE_LABEL[doc.doc_type as VendorDocType] ?? doc.doc_type}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardContent>
          </Card>
        ) : (
          <EmptyState
            assetId="vendor.dashboard.empty"
            title="아직 제출한 신청서가 없어요"
            description="아래 정보를 채우면 심사가 시작됩니다. 승인까지 보통 영업일 기준 2~3일이 걸립니다."
          />
        )}

        {canEdit ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {status === null ? "신청서 작성" : "신청서 다시 제출"}
              </CardTitle>
              <CardDescription>
                제출한 서류는 비공개 저장소에 보관되며 심사 담당자만 열람합니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <VendorApplyForm
                isResubmit={status !== null}
                defaults={{
                  name: vendor?.name ?? undefined,
                  category: vendor?.category ?? undefined,
                  regionCode: vendor?.region_code ?? undefined,
                  representativeName: application?.representative_name ?? undefined,
                  contactPhone: application?.contact_phone ?? undefined,
                  mailOrderNumber: application?.mail_order_no ?? undefined,
                }}
              />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </AdminShell>
  );
}

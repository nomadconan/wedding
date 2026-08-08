import type { Metadata } from "next";

import { AdminShell } from "@/components/layout/AdminShell";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import type { VendorApplicationStatus } from "@/lib/core/schemas/vendor";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOperator } from "@/lib/supabase/auth";

import { ReviewPanel, type ReviewItem } from "./ReviewPanel";

export const metadata: Metadata = {
  title: "입점 심사 — 웨딩클리어",
};

/**
 * /admin/vendors (F-A-01, §6.4)
 *
 * 운영자 콘솔은 **서비스롤 경유 서버 코드**로만 데이터를 읽는다(§3.9).
 * 클라이언트에서 admin 테이블을 직접 조회하지 않는다.
 *
 * 서류는 5분짜리 서명 URL 로 연다. Storage 경로는 화면·로그 어디에도 내보내지 않는다
 * (CLAUDE.md §5.3).
 */
const SIGNED_URL_TTL_SECONDS = 300;
const DOCUMENT_BUCKET = "vendor-documents";

/** 심사 큐 정렬: 대기 중인 것부터. */
const STATUS_ORDER: Record<VendorApplicationStatus, number> = {
  submitted: 0,
  revision_requested: 1,
  rejected: 2,
  approved: 3,
};

export default async function AdminVendorsPage() {
  await requireOperator("/admin/vendors");

  const admin = createAdminClient();

  const { data: applications, error } = await admin
    .from("vendor_applications")
    .select(
      "id, vendor_id, status, representative_name, contact_phone, mail_order_no, biz_no_masked, biz_no_verified_at, submitted_at, review_note",
    )
    .order("submitted_at", { ascending: true });

  if (error) {
    return (
      <AdminShell role="admin" title="입점 심사">
        <ErrorState
          code="ADMIN_QUEUE_LOAD_FAILED"
          title="심사 큐를 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }

  const vendorIds = (applications ?? []).map((row) => row.vendor_id);

  const { data: vendors } = vendorIds.length
    ? await admin.from("vendors").select("id, name, category, region_code, status").in("id", vendorIds)
    : { data: [] };

  const { data: documents } = vendorIds.length
    ? await admin
        .from("vendor_documents")
        .select("id, vendor_id, doc_type, storage_path")
        .in("vendor_id", vendorIds)
    : { data: [] };

  const items: ReviewItem[] = [];

  for (const application of applications ?? []) {
    const vendor = (vendors ?? []).find((row) => row.id === application.vendor_id);
    const vendorDocs = (documents ?? []).filter((row) => row.vendor_id === application.vendor_id);

    const signedDocs = await Promise.all(
      vendorDocs.map(async (doc) => {
        const { data: signed } = await admin.storage
          .from(DOCUMENT_BUCKET)
          .createSignedUrl(doc.storage_path, SIGNED_URL_TTL_SECONDS);

        return { id: doc.id, docType: doc.doc_type, signedUrl: signed?.signedUrl ?? null };
      }),
    );

    items.push({
      vendorId: application.vendor_id,
      applicationId: application.id,
      vendorName: vendor?.name ?? "(이름 없음)",
      category: vendor?.category ?? "-",
      regionCode: vendor?.region_code ?? null,
      vendorStatus: vendor?.status ?? "pending",
      applicationStatus: application.status as VendorApplicationStatus,
      representativeName: application.representative_name,
      contactPhone: application.contact_phone,
      mailOrderNo: application.mail_order_no,
      bizNoMasked: application.biz_no_masked,
      bizNoVerifiedAt: application.biz_no_verified_at,
      submittedAt: application.submitted_at,
      reviewNote: application.review_note,
      documents: signedDocs,
    });
  }

  items.sort(
    (a, b) =>
      STATUS_ORDER[a.applicationStatus] - STATUS_ORDER[b.applicationStatus] ||
      a.submittedAt.localeCompare(b.submittedAt),
  );

  const waiting = items.filter((item) => item.applicationStatus === "submitted").length;

  return (
    <AdminShell
      role="admin"
      title="입점 심사"
      description={`심사 대기 ${waiting}건 · 전체 ${items.length}건. 승인·반려 사유는 감사 로그에 남습니다.`}
    >
      {items.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              assetId="admin.dashboard.empty"
              title="심사할 신청서가 없어요"
              description="업체가 입점 신청을 제출하면 이 큐에 나타납니다."
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {items.map((item) => (
            <Card key={item.applicationId}>
              <CardContent className="pt-6">
                <ReviewPanel item={item} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </AdminShell>
  );
}

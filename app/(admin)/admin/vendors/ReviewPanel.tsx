"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  VENDOR_APPLICATION_STATUS_LABEL,
  VENDOR_CATEGORY_LABEL,
  VENDOR_DOC_TYPE_LABEL,
  type VendorApplicationStatus,
  type VendorCategory,
  type VendorDocType,
  type VendorReviewAction,
} from "@/lib/core/schemas/vendor";

/**
 * 심사 패널 (F-A-01, §6.4 `/admin/vendors`)
 *
 * **반려·보완 요청에는 사유가 필수**다. 버튼을 눌러도 사유가 비면 서버가 422 로 막고,
 * 화면에서도 미리 막는다 — 사유 없는 반려는 나중에 근거를 댈 수 없다.
 *
 * 서류는 서버가 만든 **5분짜리 서명 URL** 로만 연다(§3.10). 경로를 화면에 노출하지 않는다.
 */
export type ReviewItem = {
  vendorId: string;
  applicationId: string;
  vendorName: string;
  category: string;
  regionCode: string | null;
  vendorStatus: string;
  applicationStatus: VendorApplicationStatus;
  representativeName: string;
  contactPhone: string;
  mailOrderNo: string | null;
  bizNoMasked: string;
  bizNoVerifiedAt: string | null;
  submittedAt: string;
  reviewNote: string | null;
  documents: { id: string; docType: string; signedUrl: string | null }[];
};

const STATUS_VARIANT: Record<VendorApplicationStatus, "default" | "secondary" | "destructive"> = {
  submitted: "secondary",
  revision_requested: "destructive",
  approved: "default",
  rejected: "destructive",
};

export function ReviewPanel({ item }: { item: ReviewItem }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [verified, setVerified] = useState(Boolean(item.bizNoVerifiedAt));
  const [pending, setPending] = useState<VendorReviewAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decided = item.applicationStatus === "approved";

  async function submit(action: VendorReviewAction) {
    if (action !== "approve" && note.trim().length === 0) {
      setError("반려·보완 요청에는 사유를 적어야 합니다.");

      return;
    }

    setPending(action);
    setError(null);

    try {
      const response = await fetch(`/api/admin/vendors/${item.vendorId}/review`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, note: note.trim() || undefined, businessNumberVerified: verified }),
      });

      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "처리하지 못했어요.");

        return;
      }

      setNote("");
      router.refresh();
    } catch {
      setError("처리하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-4" data-testid="review-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-base font-semibold">{item.vendorName}</p>
            <Badge variant={STATUS_VARIANT[item.applicationStatus]}>
              {VENDOR_APPLICATION_STATUS_LABEL[item.applicationStatus]}
            </Badge>
          </div>
          <p className="text-caption text-muted-foreground">
            {VENDOR_CATEGORY_LABEL[item.category as VendorCategory] ?? item.category}
            {item.regionCode ? ` · ${item.regionCode}` : ""} · 신청{" "}
            {item.submittedAt.slice(0, 10)}
          </p>
        </div>
      </div>

      <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-unit text-muted-foreground">대표자</dt>
          <dd className="font-medium">{item.representativeName}</dd>
        </div>
        <div>
          <dt className="text-unit text-muted-foreground">연락처</dt>
          {/* 심사 담당자는 실제로 연락해야 하므로 원문을 보여준다. */}
          <dd className="font-medium">{item.contactPhone}</dd>
        </div>
        <div>
          <dt className="text-unit text-muted-foreground">사업자등록번호</dt>
          <dd className="font-medium">{item.bizNoMasked}</dd>
        </div>
        <div>
          <dt className="text-unit text-muted-foreground">통신판매업</dt>
          <dd className="font-medium">{item.mailOrderNo ?? "미신고"}</dd>
        </div>
      </dl>

      <div className="space-y-1">
        <p className="text-unit text-muted-foreground">제출 서류</p>
        {item.documents.length === 0 ? (
          <p className="text-sm text-warning">제출된 서류가 없습니다.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {item.documents.map((doc) => (
              <li key={doc.id}>
                {doc.signedUrl ? (
                  <a
                    href={doc.signedUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center rounded-md border border-border px-2.5 py-1 text-caption font-medium text-brand-700 hover:bg-brand-50"
                  >
                    {VENDOR_DOC_TYPE_LABEL[doc.docType as VendorDocType] ?? doc.docType} 열기
                  </a>
                ) : (
                  <span className="text-caption text-muted-foreground">
                    {VENDOR_DOC_TYPE_LABEL[doc.docType as VendorDocType] ?? doc.docType} (열 수 없음)
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="text-caption text-muted-foreground">서류 링크는 5분 뒤 만료됩니다.</p>
      </div>

      {item.reviewNote ? (
        <div className="rounded-lg border border-border bg-muted p-3">
          <p className="text-caption font-medium text-muted-foreground">지난 심사 의견</p>
          <p className="mt-1 whitespace-pre-wrap text-sm">{item.reviewNote}</p>
        </div>
      ) : null}

      {decided ? (
        <p className="text-sm text-muted-foreground">승인 완료된 신청서입니다.</p>
      ) : (
        <>
          <Separator />

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor={`note-${item.vendorId}`}>심사 의견 (반려·보완 시 필수)</Label>
              <Input
                id={`note-${item.vendorId}`}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="예: 사업자등록증 사본이 흐려 확인이 어렵습니다."
                maxLength={1000}
              />
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id={`verified-${item.vendorId}`}
                checked={verified}
                onCheckedChange={(checked) => setVerified(checked === true)}
              />
              <Label htmlFor={`verified-${item.vendorId}`} className="font-normal">
                제출 서류로 사업자 상태를 확인했습니다
              </Label>
            </div>
            {/* TODO(S2-01 후속): 국세청 사업자 상태 조회 API 연동 시 이 수동 체크를 대체한다. */}

            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => submit("approve")} disabled={pending !== null}>
                {pending === "approve" ? "처리 중…" : "승인"}
              </Button>
              <Button
                variant="secondary"
                onClick={() => submit("request_revision")}
                disabled={pending !== null}
              >
                보완 요청
              </Button>
              <Button
                variant="destructive"
                onClick={() => submit("reject")}
                disabled={pending !== null}
              >
                반려
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default ReviewPanel;

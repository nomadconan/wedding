"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  VENDOR_CATEGORIES,
  VENDOR_CATEGORY_LABEL,
  VENDOR_DOC_TYPES,
  VENDOR_DOC_TYPE_LABEL,
  type VendorCategory,
  type VendorDocType,
} from "@/lib/core/schemas/vendor";

/**
 * 입점 신청 폼 (F-V-01, §6.3 `/vendor/apply`)
 *
 * 서류는 **비공개 버킷 + 서명 URL** 로 올린다(§3.10, §7.2).
 * 서버가 발급한 업로드 URL 로 브라우저가 직접 PUT 하므로 파일이 우리 서버를 거치지 않는다.
 *
 * 사업자등록번호는 서버가 해시로 바꿔 저장한다. 이 화면은 입력만 받고
 * 응답으로 돌아온 **마스킹 값**만 다시 보여준다 — 평문을 화면에 남기지 않는다.
 */
type UploadTarget = { docType: string; path: string; token: string; signedUrl: string };

type ApiResponse = {
  ok: boolean;
  data?: { uploads: UploadTarget[] };
  error?: { code: string; message: string; details?: { field: string; message: string }[] };
};

export type VendorApplyFormProps = {
  /** 보완 요청을 받은 재제출인지. 문구가 달라진다. */
  isResubmit: boolean;
  defaults?: {
    name?: string;
    category?: string;
    regionCode?: string;
    representativeName?: string;
    contactPhone?: string;
    mailOrderNumber?: string;
  };
};

export function VendorApplyForm({ isResubmit, defaults }: VendorApplyFormProps) {
  const router = useRouter();
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const [category, setCategory] = useState<VendorCategory>(
    (defaults?.category as VendorCategory) ?? "hall",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setFieldErrors({});

    const form = new FormData(event.currentTarget);

    // 선택한 파일 목록 — 이름만 서버에 보내고, 실제 업로드는 서명 URL 을 받은 뒤에 한다.
    const chosen: { docType: VendorDocType; file: File }[] = [];
    for (const docType of VENDOR_DOC_TYPES) {
      const file = fileInputs.current[docType]?.files?.[0];
      if (file) chosen.push({ docType, file });
    }

    try {
      const response = await fetch("/api/vendor/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          category,
          regionCode: form.get("regionCode"),
          businessNumber: form.get("businessNumber"),
          mailOrderNumber: form.get("mailOrderNumber") ?? "",
          representativeName: form.get("representativeName"),
          contactPhone: form.get("contactPhone"),
          documents: chosen.map((item) => ({ docType: item.docType, fileName: item.file.name })),
        }),
      });

      const payload: ApiResponse = await response.json();

      if (!response.ok || !payload.ok) {
        if (payload.error?.details?.length) {
          setFieldErrors(
            Object.fromEntries(payload.error.details.map((d) => [d.field, d.message])),
          );
        }
        setError(payload.error?.message ?? "신청서를 보내지 못했어요.");

        return;
      }

      // 서명 URL 로 파일 업로드. 순서가 보장될 필요는 없다.
      const uploads = payload.data?.uploads ?? [];
      await Promise.all(
        uploads.map(async (target) => {
          const match = chosen.find((item) => item.docType === target.docType);
          if (!match) return;

          await fetch(target.signedUrl, {
            method: "PUT",
            headers: { "x-upsert": "true" },
            body: match.file,
          });
        }),
      );

      router.refresh();
    } catch {
      setError("신청서를 보내지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6" data-testid="vendor-apply-form">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="name">업체명</Label>
          <Input id="name" name="name" required defaultValue={defaults?.name} maxLength={100} />
          {fieldErrors.name ? <p className="text-caption text-danger">{fieldErrors.name}</p> : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="category">카테고리</Label>
          <Select value={category} onValueChange={(value) => setCategory(value as VendorCategory)}>
            <SelectTrigger id="category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VENDOR_CATEGORIES.map((code) => (
                <SelectItem key={code} value={code}>
                  {VENDOR_CATEGORY_LABEL[code]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="regionCode">지역</Label>
          <Input
            id="regionCode"
            name="regionCode"
            required
            defaultValue={defaults?.regionCode}
            placeholder="예: 서울 강남"
          />
          {fieldErrors.regionCode ? (
            <p className="text-caption text-danger">{fieldErrors.regionCode}</p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="representativeName">대표자명</Label>
          <Input
            id="representativeName"
            name="representativeName"
            required
            defaultValue={defaults?.representativeName}
          />
          {fieldErrors.representativeName ? (
            <p className="text-caption text-danger">{fieldErrors.representativeName}</p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="businessNumber">사업자등록번호</Label>
          <Input
            id="businessNumber"
            name="businessNumber"
            required
            placeholder="000-00-00000"
            inputMode="numeric"
          />
          <p className="text-caption text-muted-foreground">
            번호는 암호화해 보관하며 화면에는 일부만 표시됩니다.
          </p>
          {fieldErrors.businessNumber ? (
            <p className="text-caption text-danger">{fieldErrors.businessNumber}</p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="mailOrderNumber">통신판매업 신고번호</Label>
          <Input
            id="mailOrderNumber"
            name="mailOrderNumber"
            defaultValue={defaults?.mailOrderNumber}
            placeholder="예: 2026-서울강남-01234"
          />
          <p className="text-caption text-muted-foreground">미신고 상태면 비워 두세요.</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="contactPhone">담당자 연락처</Label>
          <Input
            id="contactPhone"
            name="contactPhone"
            required
            defaultValue={defaults?.contactPhone}
            placeholder="010-0000-0000"
            inputMode="tel"
          />
          {fieldErrors.contactPhone ? (
            <p className="text-caption text-danger">{fieldErrors.contactPhone}</p>
          ) : null}
        </div>
      </div>

      <div className="space-y-3 rounded-lg border border-border bg-muted p-4">
        <div>
          <p className="text-sm font-medium">제출 서류</p>
          <p className="text-caption text-muted-foreground">
            비공개 저장소에 보관하며 심사 담당자만 열람합니다.
          </p>
        </div>

        {VENDOR_DOC_TYPES.map((docType) => (
          <div key={docType} className="space-y-1.5">
            <Label htmlFor={`doc-${docType}`}>
              {VENDOR_DOC_TYPE_LABEL[docType]}
              {docType === "business_license" ? " (필수)" : ""}
            </Label>
            <Input
              id={`doc-${docType}`}
              type="file"
              accept="image/*,application/pdf"
              required={docType === "business_license" && !isResubmit}
              ref={(element) => {
                fileInputs.current[docType] = element;
              }}
            />
          </div>
        ))}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <Button type="submit" size="touch" disabled={pending}>
        {pending ? "제출 중…" : isResubmit ? "보완 서류 다시 제출" : "입점 신청하기"}
      </Button>
    </form>
  );
}

export default VendorApplyForm;

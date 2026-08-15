"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { AiDisclaimer } from "@/components/domain/AiDisclaimer";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DOCUMENT_ACCEPTED_MIMES,
  DOCUMENT_FORMAT_NOTE,
  DOCUMENT_MAX_BYTES,
  MASKED_KINDS_NOTE,
  PURGE_NOTICE,
  UPLOAD_CONSENT_LABEL,
  validateUpload,
} from "@/lib/core/report/pipeline";

/**
 * /reports/upload — 업로드 (F-C-07 · 명세서 §6.2 · §5.2 1단계)
 *
 * **동의 없이는 파일 선택도 소용없다.** 판정은 `validateUpload` 한 곳에서 하고
 * 서버가 같은 함수로 다시 본다 — 화면 판정은 UX 보조이지 경계가 아니다.
 *
 * **파일은 이 서버를 지나가지 않는다**(§5.3). 서버에서 서명 주소만 받아 Storage 로
 * 직접 올린 뒤 분석을 시작한다. 그래서 원문이 우리 함수 로그·트레이스에 실릴 자리가
 * 애초에 없다.
 */
export function UploadView() {
  const router = useRouter();

  const [file, setFile] = useState<File | null>(null);
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rejection =
    file === null ? null : validateUpload({ mime: file.type, size: file.size, consented });

  const canSubmit = file !== null && consented && rejection === null && !busy;

  async function submit() {
    if (file === null || !canSubmit) return;

    setBusy(true);
    setError(null);

    try {
      const created = await fetch("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mime: file.type, size: file.size, consented }),
      });

      const payload = await created.json();

      if (!created.ok || !payload.ok) {
        setError(payload.error?.message ?? "업로드 자리를 만들지 못했어요.");

        return;
      }

      const { documentId, upload } = payload.data as {
        documentId: string;
        upload: { signedUrl: string; token: string; path: string };
      };

      // 서명 주소로 **직접** 올린다. 본문이 우리 서버를 지나지 않는다.
      const put = await fetch(upload.signedUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });

      if (!put.ok) {
        setError("파일을 올리지 못했어요. 잠시 후 다시 시도해 주세요.");

        return;
      }

      const started = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId }),
      });

      const startedPayload = await started.json();

      if (!started.ok || !startedPayload.ok) {
        setError(startedPayload.error?.message ?? "분석을 시작하지 못했어요.");

        return;
      }

      router.push(`/reports/${startedPayload.data.analysisId}`);
    } catch {
      setError("업로드에 실패했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="report-upload">
      <AiDisclaimer />

      <section className="space-y-2 rounded-lg border border-border p-4">
        <h2 className="text-sm font-semibold text-foreground">올리기 전에 알아 두세요</h2>
        <ul className="space-y-1 text-caption text-muted-foreground">
          <li>· {PURGE_NOTICE}</li>
          <li>· {MASKED_KINDS_NOTE}</li>
          <li>· {DOCUMENT_FORMAT_NOTE}</li>
        </ul>
      </section>

      <label className="block space-y-1">
        <span className="text-sm font-medium text-foreground">계약서 파일</span>
        <input
          type="file"
          accept={DOCUMENT_ACCEPTED_MIMES.join(",")}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setError(null);
          }}
          data-testid="report-file"
          className="block w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
        <span className="block text-caption text-muted-foreground">
          {Math.floor(DOCUMENT_MAX_BYTES / (1024 * 1024))}MB 까지 올릴 수 있어요.
        </span>
      </label>

      <label className="flex items-start gap-2">
        <Checkbox
          checked={consented}
          onCheckedChange={(value) => setConsented(value === true)}
          data-testid="report-consent"
          className="mt-0.5"
        />
        <span className="text-sm text-foreground">{UPLOAD_CONSENT_LABEL}</span>
      </label>

      {rejection !== null && rejection.reason !== "consent" ? (
        <p role="alert" className="text-sm text-warning" data-testid="report-upload-reject">
          {rejection.message}
        </p>
      ) : null}

      {error !== null ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <Button type="button" onClick={() => void submit()} disabled={!canSubmit} className="w-full">
        {busy ? "올리는 중…" : "올리고 분석 시작"}
      </Button>
    </div>
  );
}

export default UploadView;

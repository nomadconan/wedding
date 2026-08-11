"use client";

import { Paperclip, SendHorizontal } from "lucide-react";
import { useRef, useState } from "react";

import { AttachmentChip } from "@/components/domain/ChatThread";
import { Button } from "@/components/ui/button";
import {
  ATTACHMENT_MAX_COUNT,
  MESSAGE_MAX_LENGTH,
  ROOM_CLOSED_NOTE,
  canSend,
  messageProblem,
  validateAttachment,
  type AttachmentMeta,
  type ChatRoomStatus,
} from "@/lib/core/chat/chat";
import { cn } from "@/lib/utils";

/**
 * 메시지 입력 (S4-04)
 *
 * 소비자·업체가 같이 쓴다. 다른 것은 `endpoint` 하나뿐이다.
 *
 * ── 첨부는 이 서버를 지나가지 않는다 ────────────────────────────────────────
 * 순서: (1) 서버에 **주소만** 요청 → (2) 클라이언트가 Storage 로 직접 업로드 →
 * (3) 객체 키를 메시지에 실어 전송. 20MB 파일이 서버리스 함수 본문을 통과할 이유가
 * 없고, 통과시키면 원문이 로그·트레이스에 실릴 위험만 생긴다(§5.3).
 *
 * ── 이미지는 올리기 전에 줄인다 ─────────────────────────────────────────────
 * §7.6 이 "업로드 전 클라이언트 리사이즈 ≤20MB" 를 요구한다. canvas 로 긴 변을
 * 2000px 까지 줄인다 — **새 패키지를 쓰지 않는다**(CLAUDE.md: 새 npm 의존성 금지).
 * 줄일 수 없는 형식(PDF·HEIC)은 그대로 두고 크기만 검증한다.
 */
export type ChatComposerProps = {
  roomId: string;
  /** `/api/chat/messages` 또는 `/api/vendor/chat`. */
  endpoint: string;
  status: ChatRoomStatus;
  onSent: () => void;
  /** 업체 화면의 빠른 답변 등, 입력창 위에 얹는 것. */
  slot?: React.ReactNode;
  /** 외부에서 본문을 채워 넣을 때(빠른 답변). */
  draft?: string;
  onDraftChange?: (value: string) => void;
  className?: string;
};

const MAX_IMAGE_EDGE = 2000;

export function ChatComposer({
  roomId,
  endpoint,
  status,
  onSent,
  slot,
  draft,
  onDraftChange,
  className,
}: ChatComposerProps) {
  const [internalDraft, setInternalDraft] = useState("");
  const [attachments, setAttachments] = useState<AttachmentMeta[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const body = draft ?? internalDraft;
  const setBody = onDraftChange ?? setInternalDraft;

  if (!canSend(status)) {
    return (
      <p className={cn("rounded-lg bg-muted px-3 py-2.5 text-caption text-muted-foreground", className)}>
        {ROOM_CLOSED_NOTE[status]}
      </p>
    );
  }

  async function pickFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;

    const files = [...fileList];
    if (attachments.length + files.length > ATTACHMENT_MAX_COUNT) {
      setError(`첨부는 한 번에 ${ATTACHMENT_MAX_COUNT}개까지 보낼 수 있어요.`);

      return;
    }

    setPending(true);
    setError(null);

    try {
      const prepared: { file: Blob; name: string; mime: string; size: number }[] = [];

      for (const file of files) {
        const shrunk = await shrinkImage(file);
        const check = validateAttachment({ name: file.name, mime: shrunk.type, size: shrunk.size });

        if (check) {
          setError(check.message);

          return;
        }

        prepared.push({ file: shrunk, name: file.name, mime: shrunk.type, size: shrunk.size });
      }

      // 1) 주소만 받는다.
      const urlResponse = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "attachment_url",
          roomId,
          files: prepared.map((item) => ({
            name: item.name,
            mime: item.mime,
            size: item.size,
          })),
        }),
      });
      const urlPayload = await urlResponse.json();

      if (!urlResponse.ok || !urlPayload.ok) {
        setError(urlPayload.error?.message ?? "업로드 주소를 받지 못했어요.");

        return;
      }

      // 2) Storage 로 직접 올린다.
      const uploads = urlPayload.data.uploads as {
        path: string;
        signedUrl: string;
        name: string;
      }[];

      const added: AttachmentMeta[] = [];

      for (const [index, upload] of uploads.entries()) {
        const item = prepared[index];
        const put = await fetch(upload.signedUrl, {
          method: "PUT",
          headers: { "Content-Type": item.mime },
          body: item.file,
        });

        if (!put.ok) {
          setError("파일을 올리지 못했어요.");

          return;
        }

        added.push({ path: upload.path, name: item.name, mime: item.mime, size: item.size });
      }

      setAttachments((current) => [...current, ...added]);
    } catch {
      setError("파일을 올리지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function send() {
    const problem = messageProblem(body, attachments);
    if (problem) {
      setError(problem);

      return;
    }

    setPending(true);
    setError(null);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", roomId, body, attachments }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "보내지 못했어요.");

        return;
      }

      setBody("");
      setAttachments([]);
      onSent();
    } catch {
      setError("보내지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={cn("space-y-2", className)} data-testid="chat-composer">
      {slot}

      {attachments.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {attachments.map((attachment) => (
            <AttachmentChip
              key={attachment.path}
              name={attachment.name}
              onRemove={() =>
                setAttachments((current) =>
                  current.filter((item) => item.path !== attachment.path),
                )
              }
            />
          ))}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      ) : null}

      <div className="flex items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
          className="sr-only"
          onChange={(event) => void pickFiles(event.target.files)}
        />

        <Button
          type="button"
          variant="outline"
          size="touch-icon"
          disabled={pending}
          aria-label="파일 첨부"
          onClick={() => fileRef.current?.click()}
        >
          <Paperclip aria-hidden="true" className="h-4 w-4" />
        </Button>

        <label className="sr-only" htmlFor={`chat-input-${roomId}`}>
          메시지
        </label>
        <textarea
          id={`chat-input-${roomId}`}
          value={body}
          maxLength={MESSAGE_MAX_LENGTH}
          rows={1}
          placeholder="메시지를 입력하세요"
          disabled={pending}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            // Enter 로 보내고 Shift+Enter 로 줄바꿈. 모바일에서는 조합 중
            // Enter 가 들어오므로 isComposing 을 확인한다 — 한글 입력이 잘린다.
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          className="max-h-32 min-h-11 flex-1 resize-y rounded-lg border border-input bg-background px-3 py-2.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
        />

        <Button
          type="button"
          size="touch-icon"
          disabled={pending}
          aria-label="보내기"
          onClick={() => void send()}
        >
          <SendHorizontal aria-hidden="true" className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

/**
 * 이미지를 긴 변 기준으로 줄인다(§7.6).
 *
 * 이미지가 아니거나 이미 작으면 원본을 그대로 돌려준다. 브라우저 기본 API 만 쓴다 —
 * 리사이즈 하나를 위해 패키지를 더하지 않는다.
 */
async function shrinkImage(file: File): Promise<Blob & { type: string; size: number }> {
  if (!file.type.startsWith("image/") || file.type === "image/heic") return file;

  try {
    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);

    if (longest <= MAX_IMAGE_EDGE) {
      bitmap.close();

      return file;
    }

    const scale = MAX_IMAGE_EDGE / longest;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);

    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();

      return file;
    }

    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85),
    );

    // 줄인 것이 더 크면(작은 PNG 등) 원본을 쓴다.
    return blob && blob.size < file.size ? blob : file;
  } catch {
    // 리사이즈 실패는 업로드 실패가 아니다. 크기 검증은 어차피 다음 단계에서 한다.
    return file;
  }
}

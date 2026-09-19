"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  PRODUCT_IMAGE_MAX_BYTES,
  PRODUCT_IMAGE_MIME_TYPES,
  PRODUCT_MEDIA_ALT_TEXT_MAX,
} from "@/lib/core/product/media";

/**
 * 상품 사진 관리 (C-2b · F-V-03 · §6.3 `/vendor/products/[id]`)
 *
 * ── 파일이 우리 서버를 지나지 않는다 ────────────────────────────────────────
 * ① API 에 "이런 파일을 올리겠다" 고 말하면 **서명 주소**가 온다
 * ② 브라우저가 그 주소로 Storage 에 직접 올린다
 * ③ 목록을 새로 고친다
 * 중간에 실패하면 **행이 남는다** — 그 자리를 화면이 "올리다 만 사진" 으로 적고
 * 지울 수 있게 둔다. 조용히 감추면 개수 상한만 줄어든 채 이유를 알 수 없다.
 *
 * 색·타이포는 DESIGN.md 토큰만 쓴다.
 */
export type ProductPhotoView = {
  id: string;
  path: string;
  url: string;
  altText: string | null;
  sortOrder: number;
  /** Storage 에 실제 객체가 있는가. 없으면 업로드가 끝나지 않은 자리다. */
  uploaded: boolean;
};

export function ProductPhotos({
  productId,
  photos,
  limit,
  canEdit,
}: {
  productId: string;
  photos: ProductPhotoView[];
  limit: number | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const full = limit !== null && photos.length >= limit;

  async function handleFile(file: File) {
    setPending(true);
    setError(null);

    try {
      const created = await fetch(`/api/vendor/products/${productId}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mimeType: file.type, byteSize: file.size }),
      });

      const body = await created.json();

      if (!created.ok || !body.ok) {
        setError(body.error?.message ?? "사진을 올리지 못했어요.");

        return;
      }

      // 서명 주소로 Storage 직행. 실패하면 행이 남고 화면이 그것을 적는다.
      const uploaded = await fetch(body.data.upload.signedUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });

      if (!uploaded.ok) {
        setError("업로드가 끝나지 않았어요. 아래에서 그 자리를 지우고 다시 올려 주세요.");
      }

      router.refresh();
    } catch {
      setError("사진을 올리지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function mutate(method: "PATCH" | "DELETE", payload: unknown) {
    setPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/vendor/products/${productId}/media`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const body = await response.json();

      if (!response.ok || !body.ok) {
        setError(body.error?.message ?? "저장하지 못했어요.");

        return;
      }

      router.refresh();
    } catch {
      setError("저장하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  function move(index: number, direction: -1 | 1) {
    const next = [...photos];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];

    void mutate("PATCH", { order: next.map((photo) => photo.id) });
  }

  if (!canEdit) {
    return (
      <p className="text-sm text-muted-foreground">
        상품 사진은 업체 대표 계정만 등록·수정할 수 있습니다.
      </p>
    );
  }

  return (
    <div className="space-y-4" data-testid="product-photos">
      <div className="space-y-1.5">
        <Label htmlFor="product-photo">사진 추가</Label>
        <input
          ref={fileInput}
          id="product-photo"
          type="file"
          accept={PRODUCT_IMAGE_MIME_TYPES.join(",")}
          disabled={pending || full}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleFile(file);
          }}
          className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-sm file:text-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <p className="text-caption text-muted-foreground">
          {PRODUCT_IMAGE_MIME_TYPES.map((mime) => mime.replace("image/", "")).join(" · ")} ·
          한 장 {Math.floor(PRODUCT_IMAGE_MAX_BYTES / 1024 / 1024)}MB까지
          {limit === null
            ? " · 개수 상한이 설정되지 않아 지금은 올릴 수 없어요."
            : ` · 상품당 ${limit}장까지 (지금 ${photos.length}장)`}
        </p>
        {full ? (
          <p className="text-caption text-muted-foreground">
            상한을 채웠어요. 새로 올리려면 아래에서 한 장을 지워 주세요.
          </p>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      ) : null}

      {photos.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          아직 사진이 없어요. 사진이 없으면 고객이 비교할 근거가 가격뿐입니다.
        </p>
      ) : (
        <ul className="space-y-3">
          {photos.map((photo, index) => (
            <li
              key={photo.id}
              className="flex items-start gap-3 rounded-lg border border-border p-3"
            >
              {photo.uploaded ? (
                // eslint-disable-next-line @next/next/no-img-element -- 업체가 올린 임의 경로다. next/image 의 도메인 설정 대상이 아니다.
                <img
                  src={photo.url}
                  alt={photo.altText ?? ""}
                  className="h-20 w-20 rounded-md object-cover"
                />
              ) : (
                <div className="flex h-20 w-20 items-center justify-center rounded-md bg-muted text-caption text-muted-foreground">
                  올리다 만 자리
                </div>
              )}

              <div className="flex-1 space-y-1.5">
                <div className="flex items-center gap-2">
                  {index === 0 ? (
                    <span className="rounded bg-brand-50 px-1.5 py-0.5 text-caption text-brand-700">
                      대표 사진
                    </span>
                  ) : null}
                  {!photo.uploaded ? (
                    <span className="text-caption text-danger">
                      파일이 올라가지 않았어요. 지우고 다시 올려 주세요.
                    </span>
                  ) : null}
                </div>

                <Input
                  aria-label={`사진 ${index + 1} 설명`}
                  defaultValue={photo.altText ?? ""}
                  maxLength={PRODUCT_MEDIA_ALT_TEXT_MAX}
                  placeholder="사진 설명 (화면 낭독기가 읽습니다)"
                  disabled={pending}
                  onBlur={(event) => {
                    const next = event.target.value.trim();
                    if (next === (photo.altText ?? "")) return;
                    void mutate("PATCH", {
                      updateAlt: [{ id: photo.id, altText: next === "" ? null : next }],
                    });
                  }}
                />
              </div>

              <div className="flex shrink-0 flex-col gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending || index === 0}
                  onClick={() => move(index, -1)}
                >
                  위로
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending || index === photos.length - 1}
                  onClick={() => move(index, 1)}
                >
                  아래로
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => void mutate("DELETE", { id: photo.id })}
                >
                  지우기
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { STYLE_TAGS, STYLE_TAG_LABEL, type StyleTag } from "@/lib/core/schemas/onboarding";
import {
  VENDOR_FACILITIES,
  VENDOR_FACILITY_LABEL,
  VENDOR_MEDIA_MAX,
  VENDOR_MEDIA_TYPE_LABEL,
  type VendorFacility,
  type VendorMediaType,
} from "@/lib/core/schemas/vendor-profile";

/**
 * 프로필 편집 폼 (F-V-02, §6.3 `/vendor/profile`)
 *
 * 업체명·카테고리는 **읽기 전용**이다 — 심사 근거 정보라 프로필에서 바꾸면
 * 심사 결과와 화면이 어긋난다. 변경하려면 재심사 절차를 탄다(F-A-01).
 *
 * 미디어는 파일을 서버로 보내지 않는다. PUT 응답으로 받은 **서명 URL** 에 브라우저가
 * 직접 올린다(§3.10). 정렬·대체 텍스트·삭제도 같은 PUT 한 번에 실려 나간다 —
 * §4.3 의 API 표면(`GET/PUT /api/vendor/profile`)을 늘리지 않기 위해서다.
 */
export type MediaItem = {
  id: string;
  type: VendorMediaType;
  altText: string | null;
  publicUrl: string;
};

export type VendorProfileFormProps = {
  /** 수정 권한(= 업체 owner). false 면 읽기 전용으로 보여준다. 최종 경계는 RLS 다. */
  canEdit: boolean;
  defaults: {
    regionCode: string;
    address: string;
    addressDetail: string;
    capacityMin: string;
    capacityMax: string;
    facilities: VendorFacility[];
    styleTags: StyleTag[];
    intro: string;
  };
  media: MediaItem[];
};

type PendingFile = { type: VendorMediaType; file: File; altText: string };

export function VendorProfileForm({ canEdit, defaults, media }: VendorProfileFormProps) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement | null>(null);

  const [facilities, setFacilities] = useState<VendorFacility[]>(defaults.facilities);
  const [styleTags, setStyleTags] = useState<StyleTag[]>(defaults.styleTags);
  const [items, setItems] = useState<MediaItem[]>(media);
  const [removed, setRemoved] = useState<string[]>([]);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string[] | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const total = items.length + pendingFiles.length;

  function toggleFacility(code: VendorFacility, on: boolean) {
    setFacilities((prev) => (on ? [...new Set([...prev, code])] : prev.filter((v) => v !== code)));
  }

  function toggleStyle(code: StyleTag, on: boolean) {
    setStyleTags((prev) => (on ? [...new Set([...prev, code])] : prev.filter((v) => v !== code)));
  }

  function move(id: string, direction: -1 | 1) {
    setItems((prev) => {
      const index = prev.findIndex((item) => item.id === id);
      const target = index + direction;
      if (index === -1 || target < 0 || target >= prev.length) return prev;

      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];

      return next;
    });
  }

  function addFiles(files: FileList | null) {
    if (!files) return;

    const picked = [...files].map((file) => ({
      type: (file.type.startsWith("video/") ? "video" : "photo") as VendorMediaType,
      file,
      altText: "",
    }));

    setPendingFiles((prev) => [...prev, ...picked]);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setSaved(null);
    setFieldErrors({});

    const form = new FormData(event.currentTarget);
    const toNumber = (value: FormDataEntryValue | null) => {
      const text = String(value ?? "").trim();

      return text === "" ? null : Number(text);
    };

    try {
      const response = await fetch("/api/vendor/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: {
            regionCode: form.get("regionCode"),
            address: String(form.get("address") ?? "").trim() || null,
            addressDetail: String(form.get("addressDetail") ?? "").trim() || null,
            capacityMin: toNumber(form.get("capacityMin")),
            capacityMax: toNumber(form.get("capacityMax")),
            facilities,
            styleTags,
            intro: String(form.get("intro") ?? "").trim() || null,
          },
          media: {
            add: pendingFiles.map((item) => ({
              type: item.type,
              fileName: item.file.name,
              altText: item.altText.trim() || null,
            })),
            remove: removed,
            order: items.map((item) => item.id),
            updateAlt: items.map((item) => ({ id: item.id, altText: item.altText })),
          },
        }),
      });

      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        if (payload.error?.details?.length) {
          setFieldErrors(
            Object.fromEntries(
              payload.error.details.map((d: { field: string; message: string }) => [d.field, d.message]),
            ),
          );
        }
        setError(payload.error?.message ?? "저장하지 못했어요.");

        return;
      }

      // 서명 URL 로 실제 파일 업로드. 순서는 상관없다.
      const uploads: { type: string; signedUrl: string }[] = payload.data?.uploads ?? [];
      await Promise.all(
        uploads.map(async (target, index) => {
          const source = pendingFiles[index];
          if (!source) return;

          await fetch(target.signedUrl, {
            method: "PUT",
            headers: { "x-upsert": "true" },
            body: source.file,
          });
        }),
      );

      setPendingFiles([]);
      setRemoved([]);
      setSaved(payload.data?.changedFields ?? []);
      router.refresh();
    } catch {
      setError("저장하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6" data-testid="vendor-profile-form">
      <fieldset disabled={!canEdit || pending} className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="regionCode">지역</Label>
            <Input id="regionCode" name="regionCode" required defaultValue={defaults.regionCode} />
            {fieldErrors["profile.regionCode"] ? (
              <p className="text-caption text-danger">{fieldErrors["profile.regionCode"]}</p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="address">주소</Label>
            <Input id="address" name="address" defaultValue={defaults.address} placeholder="도로명 주소" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="addressDetail">상세 주소</Label>
            <Input id="addressDetail" name="addressDetail" defaultValue={defaults.addressDetail} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="capacityMin">수용 인원 (최소)</Label>
              <Input
                id="capacityMin"
                name="capacityMin"
                inputMode="numeric"
                defaultValue={defaults.capacityMin}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="capacityMax">수용 인원 (최대)</Label>
              <Input
                id="capacityMax"
                name="capacityMax"
                inputMode="numeric"
                defaultValue={defaults.capacityMax}
              />
              {fieldErrors["profile.capacityMax"] ? (
                <p className="text-caption text-danger">{fieldErrors["profile.capacityMax"]}</p>
              ) : null}
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <Label>시설·포함 서비스</Label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {VENDOR_FACILITIES.map((code) => (
              <div key={code} className="flex items-center gap-2">
                <Checkbox
                  id={`facility-${code}`}
                  checked={facilities.includes(code)}
                  onCheckedChange={(checked) => toggleFacility(code, checked === true)}
                />
                <Label htmlFor={`facility-${code}`} className="font-normal">
                  {VENDOR_FACILITY_LABEL[code]}
                </Label>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label>스타일</Label>
          {/*
            고객이 탐색에서 스타일로 거를 때 쓰는 값이다(S3-03 · F-C-10).
            어휘는 커플 온보딩과 같은 목록이라 "커플이 고른 내추럴"과 여기서 고른 값이
            같은 값이 된다. 적지 않으면 스타일 필터에는 걸리지 않는다 — 등급이 아니라
            분류이므로 안 적었다고 불리해지는 것은 없다.
          */}
          <p className="text-caption text-muted-foreground">
            고객이 탐색 화면에서 스타일로 찾을 때 쓰입니다. 적지 않으면 스타일 필터에는
            걸리지 않습니다.
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="vendor-style-tags">
            {STYLE_TAGS.map((code) => (
              <div key={code} className="flex items-center gap-2">
                <Checkbox
                  id={`style-${code}`}
                  checked={styleTags.includes(code)}
                  onCheckedChange={(checked) => toggleStyle(code, checked === true)}
                />
                <Label htmlFor={`style-${code}`} className="font-normal">
                  {STYLE_TAG_LABEL[code]}
                </Label>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="intro">소개문</Label>
          <textarea
            id="intro"
            name="intro"
            defaultValue={defaults.intro}
            rows={5}
            maxLength={2000}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            placeholder="시설과 포함 서비스를 사실 그대로 적어 주세요. 2000자까지."
          />
          <p className="text-caption text-muted-foreground">
            사실만 적습니다. 고객 화면에는 등록한 총액과 함께 그대로 노출됩니다.
          </p>
        </div>

        <Separator />

        {/* ── 미디어 ─────────────────────────────────────────────────────── */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium">미디어</p>
              <p className="text-caption text-muted-foreground">
                {total} / {VENDOR_MEDIA_MAX}개 · 첫 번째 항목이 대표 이미지입니다.
              </p>
            </div>
            <Input
              ref={fileInput}
              type="file"
              accept="image/*,video/*"
              multiple
              className="max-w-xs"
              onChange={(event) => addFiles(event.target.files)}
            />
          </div>

          {items.length === 0 && pendingFiles.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
              등록된 사진·영상이 없습니다.
            </p>
          ) : (
            <ul className="space-y-2">
              {items.map((item, index) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-2"
                >
                  {/* 업체가 올린 이미지라 도메인이 고정되지 않는다. next/image 최적화 대상이 아니다. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={item.publicUrl}
                    alt={item.altText ?? ""}
                    className="h-14 w-20 shrink-0 rounded-md border border-border object-cover"
                  />
                  <Badge variant="secondary">{VENDOR_MEDIA_TYPE_LABEL[item.type]}</Badge>
                  <Input
                    aria-label="대체 텍스트"
                    value={item.altText ?? ""}
                    placeholder="대체 텍스트 (화면 낭독기용)"
                    className="max-w-xs"
                    onChange={(event) =>
                      setItems((prev) =>
                        prev.map((row) =>
                          row.id === item.id ? { ...row, altText: event.target.value } : row,
                        ),
                      )
                    }
                  />
                  <div className="ml-auto flex gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={index === 0}
                      onClick={() => move(item.id, -1)}
                    >
                      위로
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={index === items.length - 1}
                      onClick={() => move(item.id, 1)}
                    >
                      아래로
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        setRemoved((prev) => [...prev, item.id]);
                        setItems((prev) => prev.filter((row) => row.id !== item.id));
                      }}
                    >
                      삭제
                    </Button>
                  </div>
                </li>
              ))}

              {pendingFiles.map((item, index) => (
                <li
                  key={`pending-${index}`}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-border p-2"
                >
                  <Badge>{VENDOR_MEDIA_TYPE_LABEL[item.type]} · 저장 대기</Badge>
                  <span className="text-sm">{item.file.name}</span>
                  <Input
                    aria-label="대체 텍스트"
                    value={item.altText}
                    placeholder="대체 텍스트"
                    className="max-w-xs"
                    onChange={(event) =>
                      setPendingFiles((prev) =>
                        prev.map((row, i) =>
                          i === index ? { ...row, altText: event.target.value } : row,
                        ),
                      )
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    onClick={() => setPendingFiles((prev) => prev.filter((_, i) => i !== index))}
                  >
                    취소
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </fieldset>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {saved ? (
        <p className="text-sm text-success">
          {saved.length === 0 ? "변경된 내용이 없습니다." : `저장했습니다 · 변경 ${saved.length}건`}
        </p>
      ) : null}

      {canEdit ? (
        <Button type="submit" size="touch" disabled={pending}>
          {pending ? "저장 중…" : "프로필 저장"}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">
          프로필 수정은 업체 대표 계정만 할 수 있습니다.
        </p>
      )}
    </form>
  );
}

export default VendorProfileForm;

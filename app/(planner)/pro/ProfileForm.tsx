"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  CAREER_YEARS_MAX,
  FEE_NOT_HERE_NOTICE,
  HEADLINE_MAX,
  LISTING_REQUIREMENT_NOTICE,
  PLANNER_STATUS_DETAIL,
  PLANNER_STATUS_LABEL,
  PROFILE_EMPTY_BODY,
  PROFILE_EMPTY_TITLE,
  canRequestListing,
  type PlannerStatus,
} from "@/lib/core/planner/profile";
import { PLANNER_CATEGORY_LABEL, type PlannerCategory } from "@/lib/core/planner/scope";
import { cn } from "@/lib/utils";

/**
 * 플래너 내 프로필 (S6-02 · F-C-18)
 *
 * ── 요금 칸이 없다 ──────────────────────────────────────────────────────────
 * 요율은 `planner_fee_rates`(S5-01)가 갖고 계약 확정 시 스냅샷된다(D-16). 프로필에
 * 적으면 화면과 실제 청구가 어긋난다 — **그 이유를 화면이 먼저 말한다**(플래너가
 * "왜 요금을 못 적나" 를 묻기 전에).
 *
 * ── 공개 버튼이 '공개' 가 아니라 '공개 신청' 이다 ───────────────────────────
 * 공개는 **심사의 결과**이지 본인의 선언이 아니다(0037 트리거가 자가 공개를 막는다).
 * 버튼 문구가 그 사실을 그대로 적는다 — "공개" 라고 적어 두고 눌렀는데 안 되면
 * 그것이 장애로 보인다.
 */
export type ProfileData = {
  planner: {
    id: string;
    headline: string;
    bio: string;
    careerYears: number;
    categories: PlannerCategory[];
    regions: string[];
    status: PlannerStatus;
    contractCount: number;
  } | null;
};

export function ProfileForm({ data }: { data: ProfileData }) {
  const [headline, setHeadline] = useState(data.planner?.headline ?? "");
  const [bio, setBio] = useState(data.planner?.bio ?? "");
  const [careerYears, setCareerYears] = useState(String(data.planner?.careerYears ?? 0));
  const [categories, setCategories] = useState<PlannerCategory[]>(data.planner?.categories ?? []);
  const [regions, setRegions] = useState((data.planner?.regions ?? []).join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedRegions = regions
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");

  const draft = {
    headline: headline.trim(),
    bio,
    careerYears: Number(careerYears),
    categories,
    regions: parsedRegions,
  };

  const ready = canRequestListing(draft);
  const status = data.planner?.status ?? null;

  async function call(path: string, method: string, body: unknown) {
    if (busy) return;

    setBusy(true);
    setError(null);

    try {
      const response = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };

      if (payload.ok) {
        window.location.reload();

        return;
      }

      setError(payload.error?.message ?? "저장하지 못했어요.");
    } catch {
      setError("저장하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      {status === null ? (
        <section className="rounded-xl border border-border bg-neutral-50 p-4">
          <h2 className="text-sm font-semibold text-foreground">{PROFILE_EMPTY_TITLE}</h2>
          <p className="mt-1 text-xs text-neutral-600">{PROFILE_EMPTY_BODY}</p>
        </section>
      ) : (
        <section className="rounded-xl border border-border p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-foreground">공개 상태</h2>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-xs",
                status === "active"
                  ? "bg-success-surface text-success-foreground"
                  : "bg-neutral-100 text-neutral-600",
              )}
            >
              {PLANNER_STATUS_LABEL[status]}
            </span>
          </div>
          <p className="mt-1 text-xs text-neutral-600">{PLANNER_STATUS_DETAIL[status]}</p>
          <p className="mt-2 text-xs text-neutral-500">
            계약 성사 {data.planner?.contractCount ?? 0}건
          </p>
        </section>
      )}

      <section className="rounded-xl border border-border p-4">
        <h2 className="text-sm font-semibold text-foreground">프로필</h2>

        <div className="mt-3 space-y-3">
          <label className="block text-xs text-neutral-700">
            한 줄 소개
            <Input
              value={headline}
              maxLength={HEADLINE_MAX}
              onChange={(event) => setHeadline(event.target.value)}
              placeholder="예: 10년차 스드메 전문 플래너"
              className="mt-1"
            />
          </label>

          <label className="block text-xs text-neutral-700">
            경력 (년)
            <Input
              value={careerYears}
              inputMode="numeric"
              onChange={(event) => setCareerYears(event.target.value)}
              className="mt-1"
            />
            <span className="mt-1 block text-neutral-500">
              0~{CAREER_YEARS_MAX}년. 본인이 적은 값으로 표시돼요.
            </span>
          </label>

          <div className="text-xs text-neutral-700">
            맡을 수 있는 카테고리
            <div className="mt-2 flex flex-wrap gap-2">
              {(Object.keys(PLANNER_CATEGORY_LABEL) as PlannerCategory[]).map((category) => (
                <button
                  key={category}
                  type="button"
                  onClick={() =>
                    setCategories((prev) =>
                      prev.includes(category)
                        ? prev.filter((item) => item !== category)
                        : [...prev, category],
                    )
                  }
                  className={cn(
                    "rounded-lg border px-3 py-1.5",
                    categories.includes(category)
                      ? "border-brand-500 bg-brand-50 text-brand-700"
                      : "border-border text-neutral-700",
                  )}
                >
                  {PLANNER_CATEGORY_LABEL[category]}
                </button>
              ))}
            </div>
          </div>

          <label className="block text-xs text-neutral-700">
            활동 지역
            <Input
              value={regions}
              onChange={(event) => setRegions(event.target.value)}
              placeholder="서울 강남, 서울 서초"
              className="mt-1"
            />
            <span className="mt-1 block text-neutral-500">쉼표로 구분해 적어 주세요.</span>
          </label>

          <label className="block text-xs text-neutral-700">
            소개
            <textarea
              value={bio}
              rows={5}
              onChange={(event) => setBio(event.target.value)}
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              placeholder="어떤 방식으로 함께 준비하는지 적어 주세요."
            />
          </label>
        </div>

        {/* 요금 칸이 없는 이유를 먼저 말한다(D-16). */}
        <p className="mt-3 rounded-lg bg-neutral-50 p-3 text-xs text-neutral-600">
          {FEE_NOT_HERE_NOTICE}
        </p>

        {error ? (
          <p role="alert" className="mt-3 text-xs text-danger-foreground">
            {error}
          </p>
        ) : null}

        <Button
          size="sm"
          className="mt-3"
          disabled={busy}
          onClick={() => call("/api/planner/profile", "PUT", draft)}
        >
          {busy ? "저장 중…" : "프로필 저장"}
        </Button>
      </section>

      <section className="rounded-xl border border-border p-4">
        <h2 className="text-sm font-semibold text-foreground">마켓 공개</h2>
        <p className="mt-1 text-xs text-neutral-600">{LISTING_REQUIREMENT_NOTICE}</p>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy || !ready || status === "active" || status === null}
            onClick={() => call("/api/planner/profile", "POST", { action: "request_listing" })}
          >
            공개 신청
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || status !== "active"}
            onClick={() => call("/api/planner/profile", "POST", { action: "pause" })}
          >
            공개 내리기
          </Button>
        </div>

        <p className="mt-2 text-xs text-neutral-500">
          공개는 검토를 거칩니다 — 신청하면 확인 후 마켓에 올라가요.
        </p>
      </section>
    </div>
  );
}

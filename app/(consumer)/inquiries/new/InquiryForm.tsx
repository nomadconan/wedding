"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  CANDIDATE_REASON_LABEL,
  EMPTY_INQUIRY_FORM,
  INQUIRY_NOTE_MAX,
  inquiryDraftOf,
  inquiryFormProblem,
  sentSummary,
  type InquiryCandidate,
  type InquiryFormState,
} from "@/lib/core/inquiry/request-form";
import { VENDOR_CATEGORIES, VENDOR_CATEGORY_LABEL, type VendorCategory } from "@/lib/core/schemas/vendor";

/**
 * 표준 요청 폼 (FIX-66 · F-C-13)
 *
 * ── 판정은 서버와 **같은 함수**다 ──────────────────────────────────────────
 * `inquiryFormProblem` 이 `requestProblem`·`isPastDate`·`targetCountProblem` 셋을
 * **서버와 같은 순서로** 부른다(`app/api/inquiries/route.ts`). 화면이 제 규칙을
 * 따로 쓰면 "화면은 통과인데 서버가 422" 가 생긴다.
 *
 * ── 못 보내는 이유를 **누르기 전에** 적는다 ────────────────────────────────
 * 버튼을 잠그기만 하면 왜 잠겼는지 모른다. 잠그고 **이유를 함께** 적는다.
 *
 * ── 자유 양식이 아니다 (S4-12) ─────────────────────────────────────────────
 * 업체는 **표준 견적서로만** 답한다. 그래서 요청도 표준 항목으로 받는다 —
 * 메모는 "항목·금액이 아닌 안내 사항" 자리이고, 여기에 조건을 적어도 견적서의
 * 항목이 되지는 않는다. 그 사실을 화면이 적는다.
 */
export function InquiryForm({
  candidates,
  maxTargets,
  preselectedVendorId,
  today,
}: {
  candidates: InquiryCandidate[];
  maxTargets: number;
  preselectedVendorId: string | null;
  today: string;
}) {
  const router = useRouter();
  const [form, setForm] = useState<InquiryFormState>({
    ...EMPTY_INQUIRY_FORM,
    // 업체 상세에서 왔으면 그 업체를 미리 고른다 — 후보에 실제로 있을 때만.
    vendorIds:
      preselectedVendorId && candidates.some((c) => c.id === preselectedVendorId)
        ? [preselectedVendorId]
        : [],
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const problem = inquiryFormProblem(form, { maxTargets, today });
  const patch = (next: Partial<InquiryFormState>) => setForm((prev) => ({ ...prev, ...next }));

  const toggle = (key: "vendorIds" | "categories", value: string) =>
    setForm((prev) => ({
      ...prev,
      [key]: prev[key].includes(value)
        ? prev[key].filter((item) => item !== value)
        : [...prev[key], value],
    }));

  async function send() {
    setPending(true);
    setError(null);

    try {
      const draft = inquiryDraftOf(form);
      const response = await fetch("/api/inquiries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        data?: { inquiryId: string; targetCount: number };
        error?: { message?: string };
      };

      if (!response.ok || !payload.ok || !payload.data) {
        // **서버 문장을 그대로 보여준다** — 화면이 자기 말로 바꾸면 왜 막혔는지가 흐려진다.
        setError(payload.error?.message ?? "문의를 보내지 못했어요.");

        return;
      }

      setSent(
        sentSummary({ selected: draft.vendorIds.length, targetCount: payload.data.targetCount }),
      );
      router.refresh();
    } catch {
      setError("네트워크 문제로 보내지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  if (sent !== null) {
    return (
      <div className="space-y-3 rounded-xl border border-border p-4" data-testid="inquiry-sent">
        <p className="text-sm font-semibold text-foreground">문의를 보냈어요</p>
        <p className="text-caption text-muted-foreground">{sent}</p>
        <Button size="touch" onClick={() => router.push("/inquiries")}>
          문의함으로 가기
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="inquiry-form">
      {/* ── 업체 고르기 ─────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <div>
          <Label>어디에 보낼까요</Label>
          <p className="text-caption text-muted-foreground">
            한 번에 {maxTargets}곳까지 같은 조건으로 보낼 수 있어요. 지금 {form.vendorIds.length}곳
            골랐어요.
          </p>
        </div>

        <ul className="space-y-1.5" data-testid="inquiry-candidates">
          {candidates.map((candidate) => (
            <li key={candidate.id} className="flex items-center gap-2.5">
              <Checkbox
                id={`vendor-${candidate.id}`}
                checked={form.vendorIds.includes(candidate.id)}
                onCheckedChange={() => toggle("vendorIds", candidate.id)}
              />
              <Label
                htmlFor={`vendor-${candidate.id}`}
                className="flex flex-1 flex-wrap items-center gap-1.5 font-normal"
              >
                <span className="text-sm text-foreground">{candidate.name}</span>
                <span className="text-caption text-muted-foreground">
                  {VENDOR_CATEGORY_LABEL[candidate.category as VendorCategory] ?? candidate.category}
                </span>
                {/* 왜 후보인지 적는다 — '찜' 과 '장바구니' 는 다른 정보다. */}
                <Badge variant="outline">{CANDIDATE_REASON_LABEL[candidate.reason]}</Badge>
              </Label>
            </li>
          ))}
        </ul>
      </section>

      {/* ── 조건 ────────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="inquiry-date">예식일</Label>
          <input
            id="inquiry-date"
            type="date"
            value={form.eventDate}
            min={today}
            onChange={(event) => patch({ eventDate: event.target.value })}
            className="h-11 w-full rounded-md border border-input bg-background px-2 text-sm"
          />
          <p className="text-caption text-muted-foreground">
            날짜에 따라 가격이 달라져서 먼저 정해야 해요.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="inquiry-guests">하객 수 (선택)</Label>
            <input
              id="inquiry-guests"
              type="number"
              min={0}
              inputMode="numeric"
              value={form.guestCount}
              placeholder="아직 모르면 비워 두세요"
              onChange={(event) => patch({ guestCount: event.target.value })}
              className="h-11 w-full rounded-md border border-input bg-background px-2 text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="inquiry-budget">희망 예산 (선택 · 원)</Label>
            <input
              id="inquiry-budget"
              type="number"
              min={0}
              inputMode="numeric"
              value={form.budgetTotal}
              placeholder="아직 안 정했으면 비워 두세요"
              onChange={(event) => patch({ budgetTotal: event.target.value })}
              className="h-11 w-full rounded-md border border-input bg-background px-2 text-sm"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="inquiry-region">지역 (선택)</Label>
          <input
            id="inquiry-region"
            value={form.regionCode}
            maxLength={60}
            placeholder="예: 서울 강남"
            onChange={(event) => patch({ regionCode: event.target.value })}
            className="h-11 w-full rounded-md border border-input bg-background px-2 text-sm"
          />
        </div>

        <div className="space-y-1.5">
          <Label>어떤 항목의 견적이 필요한가요</Label>
          <div className="flex flex-wrap gap-2" data-testid="inquiry-categories">
            {VENDOR_CATEGORIES.map((category) => (
              <div key={category} className="flex items-center gap-1.5">
                <Checkbox
                  id={`category-${category}`}
                  checked={form.categories.includes(category)}
                  onCheckedChange={() => toggle("categories", category)}
                />
                <Label htmlFor={`category-${category}`} className="font-normal">
                  {VENDOR_CATEGORY_LABEL[category]}
                </Label>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="inquiry-note">추가 요청 (선택)</Label>
          <textarea
            id="inquiry-note"
            rows={3}
            value={form.note}
            maxLength={INQUIRY_NOTE_MAX}
            placeholder="예) 주차 가능 대수를 알려 주세요"
            onChange={(event) => patch({ note: event.target.value })}
            className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm"
          />
          {/* **자유 양식이 아니라는 것을 적는다**(S4-12). 여기에 항목·금액을 적어도
              견적서의 항목이 되지 않는다 — 업체는 등록된 상품·추가금에서만 고른다. */}
          <p className="text-caption text-muted-foreground">
            업체는 등록한 상품·추가금에서만 골라 표준 양식으로 답합니다. 여기에는 항목·금액이
            아닌 안내가 필요한 것만 적어 주세요.
          </p>
        </div>
      </section>

      {error !== null ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {/* **잠그기만 하지 않고 이유를 적는다.** */}
      {problem !== null ? (
        <p className="text-caption text-warning" data-testid="inquiry-blocked">
          {problem}
        </p>
      ) : null}

      <Button
        size="touch"
        className="w-full"
        disabled={pending || problem !== null}
        data-testid="send-inquiry"
        onClick={() => void send()}
      >
        {pending ? "보내는 중…" : `${form.vendorIds.length}곳에 견적 요청하기`}
      </Button>
    </div>
  );
}

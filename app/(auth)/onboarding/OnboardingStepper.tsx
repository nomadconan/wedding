"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { formatKrw } from "@/components/domain/PriceDisplay";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  ONBOARDING_QUESTIONS,
  ONBOARDING_QUESTION_HINT,
  ONBOARDING_QUESTION_LABEL,
  PREP_STAGES,
  PREP_STAGE_LABEL,
  STYLE_TAGS,
  STYLE_TAG_LABEL,
  type OnboardingQuestion,
  type PrepStage,
  type StyleTag,
} from "@/lib/core/schemas/onboarding";

/**
 * 온보딩 6단계 (F-C-01, §6.1 `/onboarding`)
 *
 * **한 화면 한 질문**(docs/DESIGN.md §3 원칙 3). 진행률을 보여주고 뒤로 갈 수 있다.
 *
 * 답변은 **단계마다 서버에 저장한다.** 마지막에 한 번에 보내면 중간에 나갔을 때
 * 처음부터 다시 해야 한다. 이미 답한 문항은 그 값으로 시작한다.
 *
 * **'미정'은 건너뛰기가 아니다.** 미정도 하나의 답이며, 답하지 않은 것과 구분해 저장된다.
 */
export type SavedAnswer = { question: OnboardingQuestion } & Record<string, unknown>;

export type OnboardingStepperProps = {
  answers: SavedAnswer[];
  /** 이미 완료했으면 요약을 보여주고 다시 고칠 수 있게 한다. */
  complete: boolean;
};

type Draft = {
  weddingUndecided: boolean;
  weddingDate: string;
  regionCode: string;
  budgetUndecided: boolean;
  totalBudget: string;
  guestUndecided: boolean;
  guestCount: string;
  styleTags: StyleTag[];
  prepStage: PrepStage | "";
};

function toDraft(answers: SavedAnswer[]): Draft {
  const find = (question: OnboardingQuestion) => answers.find((a) => a.question === question);
  const wedding = find("wedding_date");
  const budget = find("budget");
  const guest = find("guest_count");

  return {
    weddingUndecided: Boolean(wedding?.undecided),
    weddingDate: (wedding?.date as string) ?? "",
    regionCode: (find("region")?.regionCode as string) ?? "",
    budgetUndecided: Boolean(budget?.undecided),
    totalBudget: budget?.totalBudget === null || budget?.totalBudget === undefined ? "" : String(budget.totalBudget),
    guestUndecided: Boolean(guest?.undecided),
    guestCount: guest?.guestCount === null || guest?.guestCount === undefined ? "" : String(guest.guestCount),
    styleTags: ((find("style")?.styleTags as StyleTag[]) ?? []),
    prepStage: ((find("stage")?.prepStage as PrepStage) ?? ""),
  };
}

export function OnboardingStepper({ answers, complete }: OnboardingStepperProps) {
  const router = useRouter();

  const answered = new Set(answers.map((answer) => answer.question));
  const firstUnanswered = ONBOARDING_QUESTIONS.findIndex((question) => !answered.has(question));

  const [step, setStep] = useState(firstUnanswered === -1 ? 0 : firstUnanswered);
  const [draft, setDraft] = useState<Draft>(() => toDraft(answers));
  const [saved, setSaved] = useState<Set<OnboardingQuestion>>(new Set(answered));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const question = ONBOARDING_QUESTIONS[step];
  const percent = Math.round((saved.size / ONBOARDING_QUESTIONS.length) * 100);
  const isLast = step === ONBOARDING_QUESTIONS.length - 1;

  function payloadFor(target: OnboardingQuestion): Record<string, unknown> {
    switch (target) {
      case "wedding_date":
        return {
          question: target,
          undecided: draft.weddingUndecided,
          date: draft.weddingUndecided ? null : draft.weddingDate || null,
        };
      case "region":
        return { question: target, regionCode: draft.regionCode };
      case "budget":
        return {
          question: target,
          undecided: draft.budgetUndecided,
          totalBudget: draft.budgetUndecided || draft.totalBudget === "" ? null : Number(draft.totalBudget),
        };
      case "guest_count":
        return {
          question: target,
          undecided: draft.guestUndecided,
          guestCount: draft.guestUndecided || draft.guestCount === "" ? null : Number(draft.guestCount),
        };
      case "style":
        return { question: target, styleTags: draft.styleTags };
      case "stage":
        return { question: target, prepStage: draft.prepStage };
    }
  }

  async function saveAndNext() {
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadFor(question)),
      });
      const body = await response.json();

      if (!response.ok || !body.ok) {
        const detail = Array.isArray(body.error?.details) ? body.error.details[0]?.message : null;
        setError(detail ?? body.error?.message ?? "저장하지 못했어요.");

        return;
      }

      setSaved(new Set(body.data.answered as OnboardingQuestion[]));

      if (body.data.complete) {
        router.refresh();

        return;
      }

      setStep((current) => Math.min(current + 1, ONBOARDING_QUESTIONS.length - 1));
    } catch {
      setError("저장하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6" data-testid="onboarding-stepper">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-caption text-muted-foreground">
            {step + 1} / {ONBOARDING_QUESTIONS.length}단계
          </span>
          <span className="text-caption text-muted-foreground">{percent}% 완료</span>
        </div>
        <Progress value={percent} />
      </div>

      <div className="space-y-1">
        <h2 className="text-display-sm text-foreground">{ONBOARDING_QUESTION_LABEL[question]}</h2>
        <p className="text-sm text-muted-foreground">{ONBOARDING_QUESTION_HINT[question]}</p>
      </div>

      {/* ── 문항별 입력 — 한 화면에 하나만 ──────────────────────────────── */}
      <div className="space-y-3">
        {question === "wedding_date" ? (
          <>
            <Input
              type="date"
              aria-label="예식 예정일"
              disabled={draft.weddingUndecided}
              value={draft.weddingDate}
              onChange={(event) => setDraft({ ...draft, weddingDate: event.target.value })}
            />
            <div className="flex items-center gap-2">
              <Checkbox
                id="wedding-undecided"
                checked={draft.weddingUndecided}
                onCheckedChange={(checked) =>
                  setDraft({ ...draft, weddingUndecided: checked === true, weddingDate: "" })
                }
              />
              <Label htmlFor="wedding-undecided" className="font-normal">
                아직 정하지 않았어요
              </Label>
            </div>
          </>
        ) : null}

        {question === "region" ? (
          <Input
            aria-label="지역"
            placeholder="예: 서울 강남"
            value={draft.regionCode}
            onChange={(event) => setDraft({ ...draft, regionCode: event.target.value })}
          />
        ) : null}

        {question === "budget" ? (
          <>
            <Input
              type="number"
              min={0}
              aria-label="예산 총액"
              placeholder="40000000"
              disabled={draft.budgetUndecided}
              value={draft.totalBudget}
              onChange={(event) => setDraft({ ...draft, totalBudget: event.target.value })}
            />
            {draft.totalBudget && !draft.budgetUndecided ? (
              <p className="text-unit text-muted-foreground">
                {formatKrw(Number(draft.totalBudget))}원
              </p>
            ) : null}
            <div className="flex items-center gap-2">
              <Checkbox
                id="budget-undecided"
                checked={draft.budgetUndecided}
                onCheckedChange={(checked) =>
                  setDraft({ ...draft, budgetUndecided: checked === true, totalBudget: "" })
                }
              />
              <Label htmlFor="budget-undecided" className="font-normal">
                아직 정하지 않았어요
              </Label>
            </div>
          </>
        ) : null}

        {question === "guest_count" ? (
          <>
            <Input
              type="number"
              min={0}
              aria-label="하객 규모"
              placeholder="200"
              disabled={draft.guestUndecided}
              value={draft.guestCount}
              onChange={(event) => setDraft({ ...draft, guestCount: event.target.value })}
            />
            <div className="flex items-center gap-2">
              <Checkbox
                id="guest-undecided"
                checked={draft.guestUndecided}
                onCheckedChange={(checked) =>
                  setDraft({ ...draft, guestUndecided: checked === true, guestCount: "" })
                }
              />
              <Label htmlFor="guest-undecided" className="font-normal">
                아직 정하지 않았어요
              </Label>
            </div>
          </>
        ) : null}

        {question === "style" ? (
          <div className="grid grid-cols-2 gap-2">
            {STYLE_TAGS.map((tag) => (
              <div key={tag} className="flex items-center gap-2">
                <Checkbox
                  id={`style-${tag}`}
                  checked={draft.styleTags.includes(tag)}
                  onCheckedChange={(checked) =>
                    setDraft({
                      ...draft,
                      styleTags:
                        checked === true
                          ? [...new Set([...draft.styleTags, tag])]
                          : draft.styleTags.filter((value) => value !== tag),
                    })
                  }
                />
                <Label htmlFor={`style-${tag}`} className="font-normal">
                  {STYLE_TAG_LABEL[tag]}
                </Label>
              </div>
            ))}
          </div>
        ) : null}

        {question === "stage" ? (
          <RadioGroup
            value={draft.prepStage}
            onValueChange={(value) => setDraft({ ...draft, prepStage: value as PrepStage })}
            className="space-y-2"
          >
            {PREP_STAGES.map((stage) => (
              <div key={stage} className="flex items-center gap-2">
                <RadioGroupItem value={stage} id={`stage-${stage}`} />
                <Label htmlFor={`stage-${stage}`} className="font-normal">
                  {PREP_STAGE_LABEL[stage]}
                </Label>
              </div>
            ))}
          </RadioGroup>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={step === 0 || pending}
          onClick={() => setStep((current) => Math.max(0, current - 1))}
        >
          이전
        </Button>
        <Button type="button" size="touch" className="flex-1" disabled={pending} onClick={saveAndNext}>
          {pending ? "저장 중…" : isLast ? "완료" : "다음"}
        </Button>
      </div>

      {complete ? (
        <p className="text-caption text-muted-foreground">
          이미 온보딩을 마쳤어요. 답변을 고치면 바로 반영됩니다.
        </p>
      ) : null}
    </div>
  );
}

export default OnboardingStepper;

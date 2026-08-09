// 온보딩 6문항 (S3-01 · 명세서 §2.1 F-C-01, §3.1 onboarding_answers, §6.1)
//
// **한 화면 한 질문**(docs/DESIGN.md §3 원칙 3). 단계 순서와 답변 모양을 한곳에 둔다 —
// 화면·API·재진입 복원이 같은 정의를 봐야 진행률과 검증이 어긋나지 않는다.
//
// **'미정'과 '아직 안 정함'은 다르다.**
//   답변하지 않은 문항  = `onboarding_answers` 에 행이 없다
//   미정이라고 답한 문항 = 행이 있고 `{ undecided: true }` 다
// 예식일이 없다는 것과 예식일을 아직 안 골랐다는 것은 다음에 할 일이 다르다
// (S1-02 의 `AMOUNT_UNKNOWN`, S2-04 의 '없음' vs '미등록' 과 같은 원칙).

import { z } from "zod";

export const ONBOARDING_QUESTIONS = [
  "wedding_date",
  "region",
  "budget",
  "guest_count",
  "style",
  "stage",
] as const;

export type OnboardingQuestion = (typeof ONBOARDING_QUESTIONS)[number];

export const ONBOARDING_QUESTION_LABEL: Record<OnboardingQuestion, string> = {
  wedding_date: "예식 예정일이 언제인가요?",
  region: "어느 지역에서 준비하시나요?",
  budget: "예산은 얼마로 생각하고 계세요?",
  guest_count: "하객은 몇 분 정도 오실까요?",
  style: "어떤 분위기를 원하세요?",
  stage: "지금 어디까지 진행하셨어요?",
};

export const ONBOARDING_QUESTION_HINT: Record<OnboardingQuestion, string> = {
  wedding_date: "아직 못 정하셨어도 괜찮아요. 정해지면 언제든 바꿀 수 있어요.",
  region: "예식장을 찾을 지역이에요.",
  budget: "총액 기준이에요. 나중에 카테고리별로 나눠 드려요.",
  guest_count: "대략이면 충분해요. 홀 추천에 쓰여요.",
  style: "여러 개 고를 수 있어요.",
  stage: "지금 상태에 맞춰 할 일을 정리해 드려요.",
};

/** 준비 단계 선택지. 온보딩 결과가 체크리스트(F-C-04)의 시작점이 된다. */
export const PREP_STAGES = ["just_started", "venue_hunting", "venue_booked", "finalizing"] as const;
export type PrepStage = (typeof PREP_STAGES)[number];

export const PREP_STAGE_LABEL: Record<PrepStage, string> = {
  just_started: "이제 막 시작했어요",
  venue_hunting: "예식장을 알아보는 중이에요",
  venue_booked: "예식장은 정했어요",
  finalizing: "거의 마무리 단계예요",
};

/** 스타일 태그. 자유 입력이면 탐색 필터(S3-03)가 성립하지 않는다. */
export const STYLE_TAGS = [
  "modern",
  "classic",
  "natural",
  "romantic",
  "minimal",
  "luxury",
  "outdoor",
  "small_wedding",
] as const;

export type StyleTag = (typeof STYLE_TAGS)[number];

export const STYLE_TAG_LABEL: Record<StyleTag, string> = {
  modern: "모던",
  classic: "클래식",
  natural: "내추럴",
  romantic: "로맨틱",
  minimal: "미니멀",
  luxury: "럭셔리",
  outdoor: "야외",
  small_wedding: "스몰웨딩",
};

const DateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 YYYY-MM-DD 형식으로 입력해 주세요.");

/**
 * 답변. 문항마다 모양이 다르므로 판별 유니온이다.
 *
 * 멤버는 **순수 객체**여야 한다 — zod 의 `discriminatedUnion` 은 `.refine()` 으로 감싸면
 * 판별자를 못 찾는다(S2-06 에서 겪었다).
 */
export const OnboardingAnswerSchema = z.discriminatedUnion("question", [
  z.object({
    question: z.literal("wedding_date"),
    // 아직 못 정한 것도 **답변**이다. 답하지 않은 것과 구분한다.
    undecided: z.boolean().default(false),
    date: DateStringSchema.nullable().default(null),
  }),
  z.object({
    question: z.literal("region"),
    regionCode: z.string().trim().min(2, "지역을 입력해 주세요.").max(40),
  }),
  z.object({
    question: z.literal("budget"),
    undecided: z.boolean().default(false),
    /** 원 단위 정수. 0원과 미정은 다르다 — 0은 "예산을 안 쓴다"는 답이다. */
    totalBudget: z.number().int().min(0).max(10_000_000_000).nullable().default(null),
  }),
  z.object({
    question: z.literal("guest_count"),
    undecided: z.boolean().default(false),
    guestCount: z.number().int().min(0).max(100_000).nullable().default(null),
  }),
  z.object({
    question: z.literal("style"),
    styleTags: z.array(z.enum(STYLE_TAGS)).max(STYLE_TAGS.length).default([]),
  }),
  z.object({
    question: z.literal("stage"),
    prepStage: z.enum(PREP_STAGES),
  }),
]);

export type OnboardingAnswer = z.infer<typeof OnboardingAnswerSchema>;

/**
 * 답변이 성립하는가.
 *
 * 미정이 아니면 값이 있어야 한다. 미정이면 값이 없어야 한다 —
 * "미정인데 날짜가 있다"는 상태를 저장하면 나중에 어느 쪽을 믿을지 알 수 없다.
 */
export function answerIssues(answer: OnboardingAnswer): string[] {
  switch (answer.question) {
    case "wedding_date":
      if (answer.undecided && answer.date !== null) return ["미정으로 고르면 날짜를 비워 주세요."];
      if (!answer.undecided && answer.date === null) return ["예식 예정일을 골라 주세요."];

      return [];

    case "budget":
      if (answer.undecided && answer.totalBudget !== null) {
        return ["미정으로 고르면 금액을 비워 주세요."];
      }
      if (!answer.undecided && answer.totalBudget === null) return ["예산을 입력해 주세요."];

      return [];

    case "guest_count":
      if (answer.undecided && answer.guestCount !== null) {
        return ["미정으로 고르면 인원을 비워 주세요."];
      }
      if (!answer.undecided && answer.guestCount === null) return ["하객 수를 입력해 주세요."];

      return [];

    case "style":
      return answer.styleTags.length === 0 ? ["분위기를 하나 이상 골라 주세요."] : [];

    default:
      return [];
  }
}

export const OnboardingAnswerInputSchema = OnboardingAnswerSchema.superRefine((answer, ctx) => {
  for (const message of answerIssues(answer)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  }
});

/** 답변 하나를 `onboarding_answers.answer_json` 모양으로. 문항 키는 컬럼이 갖는다. */
export function toAnswerJson(answer: OnboardingAnswer): Record<string, unknown> {
  const { question: _question, ...rest } = answer;

  return rest;
}

/**
 * 답변들을 `couples` 컬럼으로 옮긴다.
 *
 * **미정은 null 로 저장된다.** 컬럼만 보면 "미답변"과 구분되지 않지만,
 * 그 구분은 `onboarding_answers` 에 행이 있는지로 판정한다 — 컬럼은 값을 담고
 * 답변 여부는 답변 테이블이 담는다.
 */
export function toCoupleFields(answers: OnboardingAnswer[]): {
  wedding_date: string | null;
  region_code: string | null;
  total_budget: number | null;
  guest_count: number | null;
  style_tags: string[];
} {
  const find = <Q extends OnboardingQuestion>(question: Q) =>
    answers.find((answer) => answer.question === question) as
      | Extract<OnboardingAnswer, { question: Q }>
      | undefined;

  return {
    wedding_date: find("wedding_date")?.date ?? null,
    region_code: find("region")?.regionCode ?? null,
    total_budget: find("budget")?.totalBudget ?? null,
    guest_count: find("guest_count")?.guestCount ?? null,
    style_tags: find("style")?.styleTags ?? [],
  };
}

/** 진행률. 답한 문항 수 기준이며 순서와 무관하다(뒤로 가기를 허용하기 때문이다). */
export function onboardingProgress(answered: OnboardingQuestion[]): {
  answered: number;
  total: number;
  percent: number;
  nextQuestion: OnboardingQuestion | null;
} {
  const done = new Set(answered);
  const next = ONBOARDING_QUESTIONS.find((question) => !done.has(question)) ?? null;

  return {
    answered: done.size,
    total: ONBOARDING_QUESTIONS.length,
    percent: Math.round((done.size / ONBOARDING_QUESTIONS.length) * 100),
    nextQuestion: next,
  };
}

export function isOnboardingComplete(answered: OnboardingQuestion[]): boolean {
  const done = new Set(answered);

  return ONBOARDING_QUESTIONS.every((question) => done.has(question));
}

// ── 커플 초대 (F-C-02) ──────────────────────────────────────────────────────

/** 초대 코드. 사람이 불러 줄 수 있어야 해서 짧고, 헷갈리는 글자를 뺀다. */
export const INVITE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const INVITE_CODE_LENGTH = 8;
/** 만료 기간. 배우자에게 전달하는 데 하루면 충분하고, 길수록 유출 위험이 길어진다. */
export const INVITE_TTL_HOURS = 24;

export const InviteCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(INVITE_CODE_LENGTH, `초대 코드는 ${INVITE_CODE_LENGTH}자입니다.`)
  .regex(new RegExp(`^[${INVITE_CODE_ALPHABET}]+$`), "초대 코드에 없는 글자가 있어요.");

export const InviteActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("issue") }),
  z.object({ action: z.literal("accept"), code: InviteCodeSchema }),
]);

/** 코드가 아직 쓸 수 있는가. 만료·사용 여부를 한 곳에서 판정한다. */
export function inviteBlocker(
  invite: { expiresAt: string; acceptedBy: string | null },
  now: string,
): { code: string; message: string } | null {
  if (invite.acceptedBy) {
    return { code: "ALREADY_USED", message: "이미 사용된 초대 코드예요." };
  }

  if (Date.parse(invite.expiresAt) <= Date.parse(now)) {
    return { code: "EXPIRED", message: "만료된 초대 코드예요. 새 코드를 요청해 주세요." };
  }

  return null;
}

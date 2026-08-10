import type { NextRequest } from "next/server";

import { recordEvent } from "@/lib/audit/record";
import { fail, failValidation, ok } from "@/lib/api/response";
import {
  ONBOARDING_QUESTIONS,
  OnboardingAnswerInputSchema,
  isOnboardingComplete,
  onboardingProgress,
  toAnswerJson,
  toCoupleFields,
  type OnboardingAnswer,
  type OnboardingQuestion,
} from "@/lib/core/schemas/onboarding";
import { findMyCouple } from "@/lib/couple/membership";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * GET/POST /api/onboarding — 온보딩 6문항 (F-C-01, 명세서 §4.2)
 *
 * **답변을 문항 단위로 저장한다.** 중간에 나갔다 와도 이어서 할 수 있어야 하고,
 * 그러려면 마지막에 한 번에 보내는 방식이면 안 된다.
 *
 * 첫 답변에서 `couples` 를 만든다(stage='onboarding'). 닭과 달걀 문제 —
 * `onboarding_answers` 가 `couple_id` 를 요구하기 때문이다.
 *
 * **체크리스트·예산 초안 자동 생성은 이번 범위가 아니다**(F-C-04·F-C-05 = S7-08·S7-07).
 * 완료 처리 지점에 주석으로 자리를 남겨 뒀다. 지금 임시 생성 로직을 넣지 않는다.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const supabase = await createClient();
  const membership = await findMyCouple(user.id);

  if (!membership) {
    return ok({
      couple: null,
      answers: [],
      progress: onboardingProgress([]),
    });
  }

  const { data: couple } = await supabase
    .from("couples")
    .select("id, stage, wedding_date, region_code, total_budget, guest_count, style_tags")
    .eq("id", membership.coupleId)
    .maybeSingle();

  const { data: rows } = await supabase
    .from("onboarding_answers")
    .select("question_key, answer_json")
    .eq("couple_id", membership.coupleId);

  const answers = (rows ?? []).map((row) => ({
    question: row.question_key as OnboardingQuestion,
    ...(row.answer_json as Record<string, unknown>),
  }));

  return ok({
    couple,
    role: membership.role,
    answers,
    progress: onboardingProgress(answers.map((answer) => answer.question)),
  });
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "ONBOARDING_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = OnboardingAnswerInputSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const answer = parsed.data as OnboardingAnswer;
  const supabase = await createClient();
  const admin = createAdminClient();

  let membership = await findMyCouple(user.id);

  // 첫 답변에서 커플을 만든다. RLS 가 owner_id = auth.uid() 를 강제한다.
  if (!membership) {
    const { data: created, error } = await supabase
      .from("couples")
      .insert({ owner_id: user.id, stage: "onboarding" })
      .select("id")
      .maybeSingle();

    if (error || !created) {
      return fail(500, "ONBOARDING_COUPLE_CREATE_FAILED", "온보딩을 시작하지 못했습니다.");
    }

    const { error: memberError } = await supabase
      .from("couple_members")
      .insert({ couple_id: created.id, user_id: user.id, member_role: "owner" });

    if (memberError) {
      return fail(500, "ONBOARDING_COUPLE_CREATE_FAILED", "온보딩을 시작하지 못했습니다.");
    }

    membership = { coupleId: created.id, role: "owner" };

    await recordEvent({
    entityType: "couple",
    entityId: created.id,
    eventType: "couple_created",
    afterState: "onboarding",
    actor: { id: user.id, role: user.role },
  });
  }

  const coupleId = membership.coupleId;

  const { error: answerError } = await supabase
    .from("onboarding_answers")
    .upsert(
      {
        couple_id: coupleId,
        question_key: answer.question,
        answer_json: toAnswerJson(answer),
      },
      { onConflict: "couple_id,question_key" },
    );

  if (answerError) return fail(500, "ONBOARDING_SAVE_FAILED", "답변을 저장하지 못했습니다.");

  // 답변이 바뀌면 커플 요약 컬럼도 함께 맞춘다.
  const { data: rows } = await supabase
    .from("onboarding_answers")
    .select("question_key, answer_json")
    .eq("couple_id", coupleId);

  const answers = (rows ?? []).map((row) => ({
    question: row.question_key as OnboardingQuestion,
    ...(row.answer_json as Record<string, unknown>),
  })) as OnboardingAnswer[];

  const answered = answers.map((row) => row.question);
  const complete = isOnboardingComplete(answered);

  // UPDATE 는 RLS 에 막혀도 에러가 아니라 **0 행**으로 끝난다. 저장했다고 답해 놓고
  // 아무것도 안 바뀌는 상황을 만들지 않기 위해 반영된 행을 직접 확인한다.
  const { data: updated } = await supabase
    .from("couples")
    .update({ ...toCoupleFields(answers), stage: complete ? "active" : "onboarding" })
    .eq("id", coupleId)
    .select("id");

  if (!updated || updated.length === 0) {
    return fail(403, "ONBOARDING_COUPLE_UPDATE_DENIED", "커플 정보를 수정할 권한이 없습니다.");
  }

  if (complete) {
    // 활동 로그에 작성자를 남긴다(§2.1 — 커플 중 누가 했는지 표기).
    await recordEvent({
    entityType: "couple",
    entityId: coupleId,
    eventType: "onboarding_completed",
    beforeState: "onboarding",
    afterState: "active",
    actor: { id: user.id, role: user.role },
  });

    // TODO(S7-08 · S7-07): 여기서 초기 체크리스트(F-C-04)와 예산 배분 초안(F-C-05)을
    // 만든다. 지금 임시 생성 로직을 넣지 않는다 — 룰이 정해지기 전에 만든 태스크는
    // 사용자가 지워야 할 쓰레기가 된다.
  }

  return ok({
    coupleId,
    answered,
    progress: onboardingProgress(answered),
    complete,
    questions: ONBOARDING_QUESTIONS,
  });
}

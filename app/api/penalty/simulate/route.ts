import type { NextRequest } from "next/server";

import { recordEvent } from "@/lib/audit/record";
import { fail, failValidation, ok } from "@/lib/api/response";
import { calculatePenalty, PenaltyRuleError } from "@/lib/core/pricing/penalty";
import { comparisonOf, isDisclosable, ruleStateOf } from "@/lib/core/pricing/penalty-view";
import { PenaltySimulateRequestSchema } from "@/lib/core/schemas/penalty";
import { findMyCouple } from "@/lib/couple/membership";
import { loadPenaltyRuleSet } from "@/lib/pricing/penalty-rule-set";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/penalty/simulate — 위약금 결정적 계산 (F-C-08 · 명세서 §4.2 · §5.3)
 *
 * ── LLM 을 부르지 않는다 ────────────────────────────────────────────────────
 * §5.3 이 못 박은 대로다. 계산은 `lib/core/pricing/penalty.ts`(T-04)가 하고 이 라우트는
 * **룰 세트를 붙여 주고 결과를 옮기기만** 한다. 엔진을 새로 만들지 않았다 — 해지
 * 견적(S5-08)·AI 툴(`simulate_penalty` · S7-20)이 이미 같은 함수를 부르며, 두 벌이면
 * 같은 계약이 화면과 대화에서 다른 금액으로 나온다.
 *
 * ── 로그인 없이도 계산된다 ──────────────────────────────────────────────────
 * 입력이 전부 사용자에게서 오고 **커플 데이터를 하나도 읽지 않는다.** 계약서에
 * 서명하기 **전에** 확인하는 것이 이 도구의 쓸모인데 로그인을 요구하면 그 자리가
 * 막힌다. **저장만 로그인 + 커플**을 요구하며 그 경계는 RLS 다
 * (`penalty_simulations` 는 커플 구성원만 · 0005 [45]).
 *
 * ── 부분 결과를 내보내지 않는다 ─────────────────────────────────────────────
 * 룰 세트가 입력을 감당하지 못하면(구간 없음 등) 엔진이 던진다. 그때 **반쪽 금액을
 * 내지 않고** 422 로 답한다(§5.1 부분 결과 비노출 · AI 툴이 `rule_missing` 으로
 * 답하는 것과 같은 처리).
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "PENALTY_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = PenaltySimulateRequestSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const { save, ...input } = parsed.data;

  const { ruleSet, source } = await loadPenaltyRuleSet(input.category);

  let result;
  try {
    result = calculatePenalty(input, ruleSet);
  } catch (error) {
    if (error instanceof PenaltyRuleError) {
      return fail(
        422,
        "PENALTY_RULE_MISSING",
        "이 조건에 맞는 기준 구간이 없어 계산할 수 없어요.",
      );
    }

    return fail(500, "PENALTY_SIMULATE_FAILED", "계산하지 못했어요.");
  }

  // **고지 없는 결과를 내보내지 않는다**(§7.7 · CLAUDE.md §2.3). 엔진이 붙이지만
  // 붙지 않은 결과가 이 경로를 지나는 날 조용히 고지 없는 화면이 된다.
  if (!isDisclosable(result)) {
    return fail(500, "PENALTY_DISCLAIMER_MISSING", "결과를 표시할 수 없어요.");
  }

  const ruleState = ruleStateOf({ source, isDraft: ruleSet.isDraft });
  const comparison = comparisonOf({ result, totalAmount: input.totalAmount });

  if (!save) {
    return ok({ result, ruleState, comparison, saved: null });
  }

  // ── 저장 ────────────────────────────────────────────────────────────────
  const user = await getSessionUser();
  if (!user) {
    return fail(401, "AUTH_REQUIRED", "계산 결과를 저장하려면 로그인이 필요해요.");
  }

  const membership = await findMyCouple(user.id);
  if (!membership) {
    return fail(404, "PENALTY_COUPLE_NOT_FOUND", "먼저 온보딩을 마쳐 주세요.");
  }

  const supabase = await createClient();

  const { data: created, error } = await supabase
    .from("penalty_simulations")
    .insert({
      couple_id: membership.coupleId,
      // 입력은 그대로 남긴다 — **기준이 바뀐 뒤에도 같은 계산을 재현할 수 있어야 한다**
      // (D-23). 개인식별정보가 없는 값들이다(카테고리·금액·날짜).
      inputs_json: input,
      standard_amount: result.standard.penalty,
      contract_amount: result.contract.penalty,
      excess_amount: result.excessPenalty,
      rule_version: result.ruleVersion,
    })
    .select("id, created_at")
    .maybeSingle();

  const row = (created as { id: string; created_at: string } | null) ?? null;
  if (error || row === null) {
    return fail(500, "PENALTY_SAVE_FAILED", "계산을 저장하지 못했어요.");
  }

  await recordEvent({
    entityType: "penalty_simulation",
    entityId: row.id,
    eventType: "penalty_simulated",
    actor: { id: user.id },
    // **금액을 남기지 않는다**(§7.3). 행이 이미 갖고 있고, 증적에 옮겨 적으면
    // 두 곳이 갈린다. 남길 사실은 어떤 기준으로 계산했는가다.
    memo: `category:${input.category} rules:${source}`,
  });

  return ok(
    {
      result,
      ruleState,
      comparison,
      saved: { id: row.id, createdAt: row.created_at },
    },
    { status: 201 },
  );
}

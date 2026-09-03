import { readSetting } from "@/lib/app-settings";
import { PLANNER_FEE_SCOPE_ORDER, resolveRate, type RateRecord } from "@/lib/core/pricing/rates";
import { AI_SETTING_KEYS } from "@/lib/core/ai/limits";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 운영 참조 데이터 (S7-20)
 *
 * **커플과 무관한 것만 여기서 읽는다.** 요율표·운영 파라미터는 §3.9 상 운영자·당사자
 * 정책이라 소비자 세션으로는 보이지 않는다 — 그래서 서비스롤이 필요하다. 그 필요를
 * 핸들러 안에 두면 "커플 데이터도 서비스롤로 읽어도 되나" 라는 질문이 매번 생기고,
 * 언젠가 한 번은 그렇게 된다. 그래서 **파일을 갈랐다**: 핸들러는 서비스롤 클라이언트를
 * import 하지 않으며(`boundary.test.ts` 가 본다), 참조 데이터는 이름이 무엇을 읽는지
 * 말하는 함수를 통해서만 나온다.
 *
 * `lib/cart/loader.ts` 가 같은 이유로 같은 일을 한다 — 새 규칙이 아니라 그 규칙을
 * 툴 쪽에도 그대로 적용한 것이다.
 */

/** 플래너 요율 후보. 소비자 세션으로는 볼 수 없다(§3.9). */
async function loadPlannerRateRecords(): Promise<RateRecord[]> {
  const { data } = await createAdminClient()
    .from("planner_fee_rates")
    // `voided_at` 을 빼면 무효화한 요율이 다시 후보가 된다(FIX-12).
    .select("id, scope_type, scope_key, fee_rate_bp, effective_from, effective_to, voided_at");

  return ((data ?? []) as {
    id: string;
    scope_type: string;
    scope_key: string | null;
    fee_rate_bp: number;
    effective_from: string;
    effective_to: string | null;
    voided_at: string | null;
  }[]).map((row) => ({
    id: row.id,
    scopeType: row.scope_type as RateRecord["scopeType"],
    scopeKey: row.scope_key,
    feeRateBp: row.fee_rate_bp,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    voidedAt: row.voided_at,
  }));
}

/**
 * 카테고리에 적용되는 플래너 요율(bp).
 *
 * **없으면 null 이다.** 임의 기본값을 만들면 대화가 말한 금액과 계약 금액이 달라진다
 * (`lib/cart/loader.ts` 의 `resolvePlannerRate` 와 같은 판단이며, 해석 순서도 같다 —
 * 플래너를 아직 고르지 않았으므로 카테고리 → 전역으로 내려간다).
 */
export async function plannerRateBpFor(
  category: string,
  at: string,
): Promise<{ rateBp: number; scopeType: string } | null> {
  const records = await loadPlannerRateRecords();
  if (records.length === 0) return null;

  const resolved = resolveRate(records, {
    scopeCandidates: PLANNER_FEE_SCOPE_ORDER,
    ...(category === "" ? {} : { scopeKeys: { category } }),
    at,
  });

  return resolved.ok ? { rateBp: resolved.feeRateBp, scopeType: resolved.scopeType } : null;
}

/** 분할 회차 설정. 값이 없으면 null 이며 호출부가 `setting_missing` 으로 답한다. */
export async function paymentSplitSetting(): Promise<unknown> {
  return readSetting("payment.split_ratios_bp");
}

/**
 * 대화 상한 파라미터.
 *
 * **값을 코드가 고르지 않는다**(§7.4). 없으면 null 이고, 그때 `conversationGate` 가
 * 대화를 열지 않는다 — 없는 상한을 무제한으로 읽으면 비용 상한이 사라진다.
 */
export async function aiLimitSettings(): Promise<{
  freeDailyTurns: number | null;
  sessionTokenCap: number | null;
}> {
  const [turns, tokens] = await Promise.all([
    readSetting(AI_SETTING_KEYS.freeDailyTurns.key),
    readSetting(AI_SETTING_KEYS.sessionTokenCap.key),
  ]);

  const readInt = (value: Record<string, unknown> | null, field: string): number | null => {
    const parsed = Number(value?.[field]);

    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  };

  return {
    freeDailyTurns: readInt(turns, AI_SETTING_KEYS.freeDailyTurns.field),
    sessionTokenCap: readInt(tokens, AI_SETTING_KEYS.sessionTokenCap.field),
  };
}

import { PLANNER_FEE_SCOPE_ORDER, resolveRate, type RateRecord } from "@/lib/core/pricing/rates";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 플래너 요율 해석 (S6-03 · §3.8 · D-16)
 *
 * ── 왜 한자리로 모았나 ──────────────────────────────────────────────────────
 * 같은 요율을 **세 곳이 각자 해석하고 있었다** — 장바구니 합계(`lib/cart/loader.ts`),
 * 계약 발행(`lib/contract/actions.ts`), AI 설명(`lib/ai/tools/reference.ts`). 그리고
 * **답이 서로 달랐다**: 장바구니는 `planner` 스코프 키 없이(카테고리 → 전역만) 풀었고
 * 계약은 `{planner, category}` 로 풀었다. §3.8 은 **좁은 범위가 넓은 범위를 이긴다**
 * 고 정했으므로, 플래너 전용 요율이 있는 플래너를 골랐다면 **화면이 본 금액과 계약에
 * 박히는 금액이 다르다.** 고객이 계약서에서 그 차이를 처음 본다.
 *
 * 장바구니가 플래너 키를 못 쓴 이유는 **누구를 골랐는지 몰랐기 때문**이다. S6-03 이
 * `planner_scopes` 를 화면·API 로 열면서 그 값이 생겼다 — 그래서 여기 모은다.
 *
 * **요율은 서비스롤이 읽는다**(§3.9 — `planner_fee_rates` 는 운영자·당사자 전용).
 * 금액만 밖으로 나가고 요율 레코드는 서버 안에 머문다.
 */

/** 요율 후보 전부. 해석은 순수 함수가 한다(`resolveRate`). */
export async function loadPlannerRateRecords(): Promise<RateRecord[]> {
  const { data } = await createAdminClient()
    .from("planner_fee_rates")
    .select("id, scope_type, scope_key, service_level, fee_rate_bp, effective_from, effective_to");

  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    scopeType: row.scope_type as RateRecord["scopeType"],
    scopeKey: (row.scope_key as string | null) ?? null,
    serviceLevel: (row.service_level as string | null) ?? null,
    feeRateBp: row.fee_rate_bp as number,
    effectiveFrom: row.effective_from as string,
    effectiveTo: (row.effective_to as string | null) ?? null,
  }));
}

/**
 * 이 카테고리·이 플래너에 적용되는 요율.
 *
 * **`plannerId` 가 판정에 들어간다.** 빠뜨리면 "누구의 것인가" 가 없는 판정이 되고,
 * 플래너 전용 요율이 있는 경우 화면과 계약이 어긋난다(FIX-45 가 쿠폰에서 드러낸 것과
 * 같은 자리 — 비용이 엉뚱한 쪽으로 간다).
 *
 * **없으면 null 이다.** 임의 기본값을 만들지 않는다(O-02 · §3.8) — 만들면 고객이 본
 * 금액과 계약 금액이 달라지고, 그 차이는 소급되지 않는다.
 */
export function resolvePlannerRateBp(input: {
  records: readonly RateRecord[];
  category: string;
  /** 고른 플래너. **아직 아무도 안 골랐으면 null** 이고 그때는 카테고리 → 전역으로 내려간다. */
  plannerId: string | null;
  at: string;
}): number | null {
  if (input.records.length === 0) return null;

  const scopeKeys: Record<string, string> = {};
  if (input.plannerId !== null) scopeKeys.planner = input.plannerId;
  if (input.category !== "") scopeKeys.category = input.category;

  const resolved = resolveRate(input.records, {
    scopeCandidates: PLANNER_FEE_SCOPE_ORDER,
    ...(Object.keys(scopeKeys).length === 0 ? {} : { scopeKeys }),
    at: input.at,
  });

  return resolved.ok ? resolved.feeRateBp : null;
}

/**
 * 커플이 지금 카테고리별로 고른 플래너.
 *
 * **`released` 는 세지 않는다** — 이력이다(D-23). 서비스롤로 읽는 이유는 이 값을
 * 쓰는 자리가 **계약 발행**(업체 세션)이기 때문이다: 업체는 커플의 `planner_scopes`
 * 를 읽을 자격이 없고, 그래도 계약에는 그 선택이 반영돼야 한다.
 */
export async function selectedPlannerByCategory(
  coupleId: string,
): Promise<Map<string, string>> {
  const { data } = await createAdminClient()
    .from("planner_scopes")
    .select("category, planner_id")
    .eq("couple_id", coupleId)
    .eq("status", "selected");

  const map = new Map<string, string>();

  for (const row of (data ?? []) as { category: string; planner_id: string }[]) {
    map.set(row.category, row.planner_id);
  }

  return map;
}

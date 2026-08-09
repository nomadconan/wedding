import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { evaluatePriceRules } from "@/lib/core/pricing/dynamic";
import { PriceSimulationInputSchema } from "@/lib/core/schemas/price-rule";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { PRICE_RULE_COLUMNS, toEvaluableRule, type PriceRuleRow } from "@/lib/vendor/price-rules";

/**
 * POST /api/vendor/price-rules/simulate — 룰 미리보기 (F-V-06, §4.3)
 *
 * 평가는 `lib/core/pricing/dynamic.ts` 의 **순수 함수**가 한다. 이 핸들러는 룰을 읽어
 * 넘기고 결과를 돌려줄 뿐이다 — 요율 엔진(S5-02)과 같은 구조다.
 *
 * **조회 전용이라 쓰기 권한이 필요 없다.** staff 도 시뮬레이션은 볼 수 있다.
 * 룰을 고치는 것만 owner 다.
 *
 * `leadTimeDays` 는 호출자가 넘긴다. "지금"을 서버가 임의로 정하면 같은 요청이
 * 시각에 따라 다른 답을 내고, 그러면 결과를 재현할 수 없다.
 */
export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "VENDOR_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = PriceSimulationInputSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const input = parsed.data;
  const supabase = await createClient();

  // RLS 가 자기 업체 룰만 보여준다.
  const { data, error } = await supabase.from("price_rules").select(PRICE_RULE_COLUMNS);

  if (error) return fail(500, "VENDOR_PRICE_RULE_LOAD_FAILED", "룰을 불러오지 못했습니다.");

  const rules = ((data ?? []) as PriceRuleRow[]).map(toEvaluableRule);

  const evaluation = evaluatePriceRules(input.basePrice, rules, {
    eventDate: input.eventDate,
    leadTimeDays: input.leadTimeDays,
    occupancyRatioBp: input.occupancyRatioBp,
    productId: input.productId,
  });

  return ok({ evaluation });
}

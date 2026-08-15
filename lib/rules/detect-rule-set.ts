import { DETECT_RULES } from "@/lib/core/rules/detect-rules";
import {
  codeOnlyRuleSet,
  hasDrift,
  mergeDetectRules,
  type DetectRuleRow,
  type MergedRuleSet,
} from "@/lib/core/rules/rule-source";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 검출 룰 세트 조회 (S7-01 · §3.5 detect_rules · §5.2 4단계)
 *
 * `lib/pricing/penalty-rule-set.ts`(S5-08)와 같은 자리의 얇은 층이다 — 스캔 엔진
 * (`lib/core/rules/scan.ts`)은 룰을 **주입받고**, "어디서 오는가" 는 여기가 정한다.
 *
 * ── 서비스 롤로 읽는다 ──────────────────────────────────────────────────────
 * `detect_rules` 는 RLS 가 켜져 있고 **정책이 없다**(0005). `prompt_fragment` 는
 * 내부 자산이라 클라이언트에 열지 않는다 — 스캔은 서버에서만 돈다.
 *
 * ── DB 가 없어도 멈추지 않는다 ──────────────────────────────────────────────
 * 조회가 실패하면 코드 룰로 진행한다. **분석이 멈추는 것보다 낫지만 공짜는 아니다** —
 * 운영자가 끈 룰이 되살아나므로 그 사실을 `source`·`drift` 로 함께 돌려준다.
 * 호출부(S7-03)가 그것을 분석 기록에 남긴다.
 */
export async function loadDetectRuleSet(): Promise<MergedRuleSet> {
  try {
    const { data, error } = await createAdminClient()
      .from("detect_rules")
      .select("code, prompt_fragment, basis_ref, version, is_active");

    if (error || !data) return codeOnlyRuleSet(DETECT_RULES);

    return mergeDetectRules(DETECT_RULES, data as DetectRuleRow[]);
  } catch {
    return codeOnlyRuleSet(DETECT_RULES);
  }
}

/**
 * 룰 출처를 로그에 남길 때 쓰는 요약.
 *
 * **룰 코드만 담는다.** 문서 내용·경로·인용은 어떤 로그에도 넣지 않는다(§5.3).
 */
export function ruleSetSummary(merged: MergedRuleSet): {
  source: string;
  active: number;
  disabled: number;
  drift: boolean;
} {
  return {
    source: merged.source,
    active: merged.rules.length,
    disabled: merged.disabled.length,
    drift: hasDrift(merged.drift),
  };
}

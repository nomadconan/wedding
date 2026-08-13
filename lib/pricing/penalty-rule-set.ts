import {
  PENALTY_RULES_VERSION,
  getDraftPenaltyRuleSet,
} from "@/lib/core/pricing/penalty-rules";
import type { PenaltyBand, PenaltyCategory, PenaltyRuleSet } from "@/lib/core/schemas/penalty";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 위약금 룰 세트 조회 (S5-08 · §3.5 penalty_rules · §5.3 · §7.7)
 *
 * `lib/core/pricing/penalty.ts`(T-04)는 룰을 **주입받는다.** 그래서 "어디서 오는가" 를
 * 정하는 얇은 층이 여기 있다 — 엔진은 이 파일이 생겨도 바뀌지 않는다.
 *
 * ── DB 우선 · 코드 폴백 ─────────────────────────────────────────────────────
 * `penalty_rules` 에 그 카테고리의 행이 있으면 그것을 쓰고, 없으면 T-04 의 가정치
 * 룰 세트를 쓴다. **시드를 넣지 않은 이유**(0031 근거 6) — 법무 검수 전 수치를 DB 에
 * 넣으면 그것이 운영 기준처럼 굳는다. 확정되면 **행을 넣기만 하면** 코드 변경 없이
 * 전환된다.
 *
 * ── 가정치라는 사실이 화면까지 간다 ─────────────────────────────────────────
 * `isDraft` 는 삼키지 않고 그대로 실어 보낸다. 엔진이 그것을 보고 결과 `notes` 에
 * 경고를 붙이고(T-04), 화면이 그 경고를 그대로 노출한다(§7.7). **어느 수치로
 * 계산했는지 모르는 금액을 사용자에게 보여주지 않는다.**
 */
type RuleRow = {
  category: string;
  band_code: string | null;
  band_label: string | null;
  min_days_before_event: number | null;
  max_days_before_event: number | null;
  rate_bp: number | null;
  refund_deposit: boolean;
  basis_ref: string | null;
  version: string;
  is_draft: boolean;
};

/** 예식일이 지난 뒤 적용하는 밴드의 코드. DB 행에서 이 코드를 찾아 분리한다. */
const AFTER_EVENT_CODE = "AFTER_EVENT";

export type RuleSetSource = "database" | "draft";

export type ResolvedRuleSet = { ruleSet: PenaltyRuleSet; source: RuleSetSource };

export async function loadPenaltyRuleSet(category: PenaltyCategory): Promise<ResolvedRuleSet> {
  const { data } = await createAdminClient()
    .from("penalty_rules")
    .select(
      "category, band_code, band_label, min_days_before_event, max_days_before_event, rate_bp, refund_deposit, basis_ref, version, is_draft",
    )
    .eq("category", category);

  const rows = ((data ?? []) as RuleRow[]).filter(
    (row) => row.band_code !== null && row.rate_bp !== null && row.min_days_before_event !== null,
  );

  const fromDb = buildRuleSet(category, rows);

  // DB 에 쓸 만한 행이 없으면 가정치로 간다. **지어내지 않고 폴백을 밝힌다.**
  return fromDb ?? { ruleSet: getDraftPenaltyRuleSet(category), source: "draft" };
}

function buildRuleSet(category: PenaltyCategory, rows: RuleRow[]): ResolvedRuleSet | null {
  if (rows.length === 0) return null;

  const afterRow = rows.find((row) => row.band_code === AFTER_EVENT_CODE);
  const bandRows = rows.filter((row) => row.band_code !== AFTER_EVENT_CODE);

  // 사후 정산 구간이 없으면 룰 세트가 성립하지 않는다 — 예식일이 지난 취소에서
  // 엔진이 던진다. 반쪽 룰로 계산하느니 가정치를 쓰는 편이 낫다(부분 결과 금지).
  if (afterRow === undefined || bandRows.length === 0) return null;

  const bands = bandRows.map(toBand);

  return {
    ruleSet: {
      category,
      // 판본이 섞여 있으면 가장 최근 것을 대표로 적는다 — 어느 판본으로 계산했는지가
      // 스냅샷으로 남아야 한다(D-23).
      version: latestVersion(rows),
      basisRef: afterRow.basis_ref ?? bandRows[0].basis_ref ?? "소비자분쟁해결기준",
      // 한 행이라도 가정치면 룰 세트 전체를 가정치로 본다. 섞인 것을 확정으로
      // 적으면 화면이 경고를 지운다.
      isDraft: rows.some((row) => row.is_draft),
      bands,
      afterEvent: toBand(afterRow),
    },
    source: "database",
  };
}

function toBand(row: RuleRow): PenaltyBand {
  return {
    code: row.band_code as string,
    label: row.band_label ?? (row.band_code as string),
    minDaysBeforeEvent: row.min_days_before_event as number,
    maxDaysBeforeEvent: row.max_days_before_event,
    rateBp: row.rate_bp as number,
    refundDeposit: row.refund_deposit,
  };
}

function latestVersion(rows: RuleRow[]): string {
  return [...rows].map((row) => row.version).sort().at(-1) ?? PENALTY_RULES_VERSION;
}

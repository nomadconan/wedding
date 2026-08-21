import type { SupabaseClient } from "@supabase/supabase-js";

import { recordEvent } from "@/lib/audit/record";
import {
  COMPLIANCE_SETTING_KEYS,
  activeRuleCount,
  countBySeverity,
  decideBadge,
  toFindings,
  type BadgeDecision,
  type ComplianceFinding,
} from "@/lib/core/compliance/compliance";
import { guideFor } from "@/lib/core/compliance/guides";
import { maskText } from "@/lib/core/masking";
import { scanDocument } from "@/lib/core/rules/scan";
import type { RuleSeverity } from "@/lib/core/rules/types";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 컴플라이언스 자가 진단 실행 (S7-13 · 명세서 §2.3 F-V-10 · §4.2)
 *
 * ── 원문을 저장하지 않는다 ──────────────────────────────────────────────────
 * 요청 본문을 **메모리에서 스캔**하고 구조화 결과만 남긴다. 업로드 원문은 24시간 내
 * 파기가 원칙인데(CLAUDE.md §5.1) **애초에 저장하지 않으면 파기할 것도 없다.**
 * `documents` 를 쓰지 않는 이유가 여기 있다 — 그 표를 쓰면 `purge_scheduled_at` 과
 * 파기 배치가 따라붙는다.
 *
 * ── 마스킹은 스캔 뒤에 한다 ─────────────────────────────────────────────────
 * AI 를 부르지 않으므로 §5.2 의 "AI 전달 전 마스킹" 은 해당하지 않는다. 그런데도
 * 마스킹하는 이유는 **저장되는 것이 하나 있기 때문**이다 — `clause_excerpt`(걸린 문장).
 * 업체가 실수로 **고객 이름이 든 실제 계약서**를 붙여넣으면 그 조각이 DB 에 남는다.
 *
 * **순서를 뒤집었다.** 처음에는 마스킹한 텍스트를 스캔했는데 흐름 점검이 그것이
 * 틀렸음을 보였다 — 이름 패턴이 `담당 작가 교체가` 의 **"교체가" 를 이름으로 집어**
 * 문장을 망가뜨렸고, 그 결과 **갖춰져 있던 조항이 "없다" 로 판정**됐다(R-15·R-04).
 * 마스킹은 개인정보를 지우는 도구이지 **판정 대상을 만드는 도구가 아니다.** 그래서
 * **스캔은 원문에**(정확한 판정) **마스킹은 저장 직전 인용에만**(남는 것을 지운다)
 * 건다. 원문은 어차피 저장하지 않으므로 이 순서가 무엇도 더 남기지 않는다.
 * 마스킹 오탐 자체는 **FIX-31** 로 기록했다 — 소비자 리포트(S7-03)와 공유하는 층이라
 * 여기서 패턴을 고치지 않는다.
 *
 * ── AI 를 부르지 않는다 ─────────────────────────────────────────────────────
 * §2.3 이 "검출 룰 20종으로" 라고 적었고 여기에는 **배지가 걸린다.** 같은 문서에 다른
 * 답이 나오면 배지가 우연의 산물이 된다(CLAUDE.md §3.1).
 *
 * ── 배지를 여기서 쓰지 않는다 ───────────────────────────────────────────────
 * `vendors.badge_flags` 갱신은 **DB 트리거**가 한다(0050). 애플리케이션이 스캔과 배지를
 * 각각 쓰면 화면이 말하는 배지와 근거가 갈린다 — 판정자를 하나로 둔다.
 */

export type ScanResult = {
  scanId: string;
  findings: ComplianceFinding[];
  counts: Record<RuleSeverity, number>;
  ruleCount: number;
  scannedAt: string;
  badge: BadgeDecision;
  /** 마스킹이 지운 항목 종류. **무엇을 지웠는지**만 남기고 값은 남기지 않는다. */
  maskedKinds: string[];
};

export type ComplianceFailure = { status: number; code: string; message: string };

type ScanRow = {
  id: string;
  findings_json: unknown;
  rule_count: number;
  created_at: string;
};

/** 배지 기준. **값이 아니라 키만** 코드가 갖는다(§7.4). */
export async function badgeMaxHigh(): Promise<number | null> {
  const { data } = await createAdminClient()
    .from("app_settings")
    .select("value_json")
    .eq("key", COMPLIANCE_SETTING_KEYS.badgeMaxHigh.key)
    .maybeSingle();

  const raw = (data as { value_json?: { value?: unknown } } | null)?.value_json?.value;
  const value = Number(raw);

  return raw === null || raw === undefined || !Number.isInteger(value) ? null : value;
}

/** 저장된 finding 배열을 화면이 쓰는 모양으로. 가이드는 **읽을 때 붙인다**(코드가 진실). */
function reviveFindings(raw: unknown): ComplianceFinding[] {
  if (!Array.isArray(raw)) return [];

  return raw.map((item) => {
    const row = item as Record<string, unknown>;
    const ruleCode = String(row.rule_code ?? "");

    return {
      ruleCode,
      title: String(row.title ?? ""),
      severity: (row.severity ?? "low") as RuleSeverity,
      basisRef: String(row.basis_ref ?? ""),
      kind: (row.kind ?? "presence") as "presence" | "absence",
      clauseExcerpt: String(row.clause_excerpt ?? ""),
      // **가이드를 DB 에 넣지 않는다.** 문구를 고치면 지난 진단에도 새 문구가 붙어야
      // 한다 — 저장하면 옛 문구가 화석으로 남는다.
      guide: guideFor(ruleCode),
    };
  });
}

/**
 * 최신 진단 조회.
 *
 * **세션으로 읽는다** — `vendor_compliance_scans` 는 업체 멤버만 볼 수 있고(0050 [2])
 * 그 경계가 RLS 다. 진단 결과에는 업체가 고치는 중인 자기 약관의 약점이 들어 있다.
 */
export async function loadLatestScan(
  client: SupabaseClient,
  input: { vendorId: string },
): Promise<Omit<ScanResult, "maskedKinds"> | null> {
  const { data } = await client
    .rpc("latest_compliance_scan", { p_vendor_id: input.vendorId })
    .maybeSingle();

  const row = (data ?? null) as ScanRow | null;
  if (row === null) return null;

  const findings = reviveFindings(row.findings_json);
  const counts = countBySeverity(findings);

  return {
    scanId: row.id,
    findings,
    counts,
    ruleCount: row.rule_count,
    scannedAt: row.created_at,
    badge: decideBadge({ highCount: counts.high, maxHigh: await badgeMaxHigh() }),
  };
}

/**
 * 진단 실행.
 *
 * 권한 판정은 **호출부가 세션으로** 끝내고 여기에는 확인된 `vendorId` 만 온다.
 * 쓰기는 서비스롤이다 — 0050 이 쓰기 정책을 두지 않았고, 그 이유는 클라이언트가 행을
 * 넣을 수 있으면 **스캔하지 않고 통과 결과만 넣어 배지를 받을 수 있기** 때문이다.
 */
export async function runScan(input: {
  vendorId: string;
  userId: string;
  terms: string;
}): Promise<ScanResult | ComplianceFailure> {
  // **판정은 원문에서 한다.** 마스킹본을 스캔하면 이름 오탐 하나가 조항을 지워
  // "갖춰져 있는데 없다" 로 뒤집는다(위 주석 · FIX-31).
  const raw = toFindings(scanDocument(input.terms));

  // **남는 것만 가린다.** 인용은 저장되므로 여기서 마스킹한다.
  const maskedKinds = new Set<string>();
  const findings = raw.map((finding) => {
    if (finding.clauseExcerpt.length === 0) return finding;

    const masked = maskText(finding.clauseExcerpt);

    for (const [kind, count] of Object.entries(masked.counts)) {
      if (count > 0) maskedKinds.add(kind);
    }

    // **가리지 못한 조각은 인용을 버린다.** 걸렸다는 사실은 남기되 문장은 남기지
    // 않는다 — 인용이 없어도 룰 제목과 가이드가 무엇을 고칠지 말해 준다.
    // `masking.map` 은 토큰 → **원문 값**이라 밖으로 내보내지 않는다(§5.2).
    return { ...finding, clauseExcerpt: masked.complete ? masked.masked : "" };
  });
  const ruleCount = activeRuleCount();
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("vendor_compliance_scans")
    .insert({
      vendor_id: input.vendorId,
      scanned_by: input.userId,
      // **가이드를 저장하지 않는다** — 코드가 진실이고 읽을 때 붙인다.
      findings_json: findings.map((finding) => ({
        rule_code: finding.ruleCode,
        title: finding.title,
        severity: finding.severity,
        basis_ref: finding.basisRef,
        kind: finding.kind,
        clause_excerpt: finding.clauseExcerpt,
      })),
      rule_count: ruleCount,
    })
    .select("id, created_at")
    .maybeSingle();

  const saved = (data ?? null) as { id: string; created_at: string } | null;
  if (error || saved === null) {
    return { status: 500, code: "COMPLIANCE_SAVE_FAILED", message: "진단 결과를 저장하지 못했어요." };
  }

  const counts = countBySeverity(findings);
  const badge = decideBadge({ highCount: counts.high, maxHigh: await badgeMaxHigh() });

  await recordEvent({
    entityType: "vendor_compliance_scan",
    entityId: saved.id,
    eventType: "compliance_scanned",
    actor: { id: input.userId },
    afterState: badge.granted ? "badge_granted" : badge.reason,
    // **원문도 인용도 담지 않는다**(§7.3 · CLAUDE.md §5.3). 남길 사실은 몇 종을 봤고
    // 몇 건이 걸렸는가다 — 건수는 findings_json 에서 셀 수 있지만 이벤트는 **그때의
    // 사실**을 남기는 곳이라 시점 값으로 적는다.
    memo: `rules:${ruleCount} high:${counts.high} mid:${counts.mid} low:${counts.low}`,
  });

  return {
    scanId: saved.id,
    findings,
    counts,
    ruleCount,
    scannedAt: saved.created_at,
    badge,
    maskedKinds: [...maskedKinds],
  };
}

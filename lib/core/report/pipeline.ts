import { AI_DISCLAIMER } from "../legal";
import { RULE_CATEGORY_LABEL, type RuleCategory, type RuleMatch, type RuleSeverity } from "../rules/types";
import type { Finding, Report } from "../schemas/report";

/**
 * 계약서 검토 파이프라인 — 판정과 조립 (S7-03 · 명세서 §5.2)
 *
 * 8단계 중 **판단이 들어가는 부분만** 여기 있다. 마스킹(3)은 `lib/core/masking`,
 * 룰 스캔(4)은 `lib/core/rules`, 스키마 검증(6)은 `lib/core/schemas/report` 가
 * 이미 갖고 있고 **다시 만들지 않았다**(T-04 산출). 이 파일이 채우는 것은 그 사이의
 * 결정들이다 — 추출 품질을 어디서 자를 것인가, 모델이 없거나 실패했을 때 무엇을
 * 보여 줄 것인가, 인용 대조를 통과하지 못한 finding 을 어떻게 버릴 것인가.
 *
 * **부분 결과를 노출하지 않는다**(§5.1)는 원칙에는 예외가 하나 있다 — **룰 검출은
 * 모델의 부분 결과가 아니라 그 자체로 완결된 결정적 산출**이다. 모델이 죽었을 때
 * 화면을 비우는 것과 "룰이 찾은 것만 보여주고 그 사실을 적는" 것 중 후자가 낫다.
 * 다만 **룰만으로 만든 리포트는 그렇다고 말한다**(`source: "rules_only"`).
 *
 * 프레임워크를 모르는 순수 모듈이다.
 */

// =============================================================================
// 분석 상태 (§3.5 document_analyses.status)
// =============================================================================

export const ANALYSIS_STATUSES = ["queued", "running", "done", "failed"] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export const ANALYSIS_STATUS_LABEL: Record<AnalysisStatus, string> = {
  queued: "분석을 기다리는 중",
  running: "분석 중",
  done: "분석 완료",
  failed: "분석 실패",
};

export function isTerminal(status: AnalysisStatus): boolean {
  return status === "done" || status === "failed";
}

/**
 * 실행이 끊긴 분석을 되살릴 수 있는가.
 *
 * 라우트가 202 를 돌려준 뒤 실행이 잘리면(서버리스에서 응답 후 작업은 보장되지
 * 않는다) `running` 인 채로 영영 남는다. 그래서 **폴링이 재개의 계기**가 된다 —
 * 일정 시간이 지난 `queued`·`running` 은 다시 집는다. 값은 코드 상수다(운영
 * 파라미터가 아니라 실행 시간에 대한 기술적 판단이다).
 */
export const ANALYSIS_STALE_MS = 90_000;

export function isResumable(input: {
  status: AnalysisStatus;
  updatedAt: string;
  now: number;
}): boolean {
  if (isTerminal(input.status)) return false;

  const updated = Date.parse(input.updatedAt);
  if (Number.isNaN(updated)) return true;

  return input.now - updated >= ANALYSIS_STALE_MS;
}

// =============================================================================
// 2단계 — 추출 품질 (§5.2 "품질 미달 시 재촬영 안내")
// =============================================================================

export const EXTRACTION_FAILURES = ["empty", "too_short", "unsupported"] as const;
export type ExtractionFailure = (typeof EXTRACTION_FAILURES)[number];

/**
 * 이 길이 아래면 계약서로 보지 않는다.
 *
 * 표지만 찍혔거나 초점이 나간 사진에서 나온 몇 글자로 분석을 돌리면 **"위험 없음"
 * 처럼 보이는 결과**가 나오고, 그것은 "아무것도 못 읽었다" 와 화면에서 구분되지
 * 않는다(S7-01 이 "룰 0건이면 분석을 시작하지 않는다" 에서 세운 것과 같은 판단).
 */
export const EXTRACTION_MIN_CHARS = 200;

export const EXTRACTION_NOTICE: Record<ExtractionFailure, string> = {
  empty: "문서에서 글자를 읽지 못했어요. 밝은 곳에서 문서 전체가 보이게 다시 찍어 주세요.",
  too_short:
    "읽어 낸 글자가 너무 적어요. 계약서 전체가 담기도록 여러 장으로 나눠 올려 주세요.",
  unsupported:
    "이 형식은 아직 글자를 읽어 내지 못해요. 텍스트로 저장한 파일(.txt)을 올려 주세요.",
};

export type ExtractionVerdict = { ok: true; chars: number } | { ok: false; reason: ExtractionFailure };

export function checkExtraction(text: string): ExtractionVerdict {
  const trimmed = text.trim();

  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.length < EXTRACTION_MIN_CHARS) return { ok: false, reason: "too_short" };

  return { ok: true, chars: trimmed.length };
}

// =============================================================================
// 7단계 — 인용 대조 후 병합
// =============================================================================

export const REPORT_SOURCES = ["rules_only", "rules_and_model"] as const;
export type ReportSource = (typeof REPORT_SOURCES)[number];

export const REPORT_SOURCE_NOTICE: Record<ReportSource, string> = {
  rules_only:
    "이 리포트는 검출 룰만으로 만들었어요. 조항별 설명과 협상 문구는 아직 붙지 않았습니다.",
  rules_and_model: "검출 룰이 찾은 조항을 바탕으로 설명과 요청 문구를 덧붙였어요.",
};

export type DiscardedFinding = {
  rule_code: string;
  /** 왜 버렸는가. 화면·기록이 그대로 읽는다. */
  reason: "citation_mismatch" | "unknown_rule" | "invented_clause_number";
};

/**
 * 조항 번호를 지어냈는가.
 *
 * 법무 검수(부록 D ②) 전까지 우리는 **조항 번호를 말하지 않는다.** `seed.sql`·
 * `db:rls` 가 시드 쪽에서 같은 것을 막고 있으므로(S7-01), 모델 출력 쪽에도 같은 문을
 * 둔다 — 한쪽만 막으면 화면에는 결국 번호가 뜬다.
 */
export const CLAUSE_NUMBER_PATTERN = /제\s*\d+\s*조/;

export function inventedClauseNumber(basisRef: string): boolean {
  return CLAUSE_NUMBER_PATTERN.test(basisRef);
}

export type MergeOutcome = {
  findings: Finding[];
  discarded: DiscardedFinding[];
};

/**
 * 모델이 낸 finding 을 걸러 낸다.
 *
 * **인용 대조를 통과하지 못한 finding 은 개별 폐기**한다(§5.2 7단계). 응답 전체를
 * 버리지 않는 이유는, 하나가 지어졌다고 나머지가 지어진 것은 아니기 때문이다 —
 * 반대로 통과한 것만 남기면 남은 것은 전부 원문에 실재하는 조항이다.
 *
 * **룰이 찾지 않은 코드도 받는다.** 룰은 정규식이라 표현이 다르면 놓치고, 모델은 그
 * 자리를 메우라고 부른 것이다. 다만 `rule_code` 자체가 정의된 20종 밖이면 버린다
 * (`ReportSchema` 가 이미 막지만, 그 검증이 응답 전체를 버리므로 여기서 한 번 더
 * 개별로 본다).
 */
export function mergeModelFindings(input: {
  findings: readonly Finding[];
  maskedText: string;
  verifyCitation: (maskedText: string, excerpt: string) => boolean;
  knownRuleCodes: ReadonlySet<string>;
}): MergeOutcome {
  const kept: Finding[] = [];
  const discarded: DiscardedFinding[] = [];

  for (const finding of input.findings) {
    if (!input.knownRuleCodes.has(finding.rule_code)) {
      discarded.push({ rule_code: finding.rule_code, reason: "unknown_rule" });
      continue;
    }

    if (!input.verifyCitation(input.maskedText, finding.clause_excerpt)) {
      discarded.push({ rule_code: finding.rule_code, reason: "citation_mismatch" });
      continue;
    }

    if (inventedClauseNumber(finding.basis_ref)) {
      discarded.push({ rule_code: finding.rule_code, reason: "invented_clause_number" });
      continue;
    }

    kept.push(finding);
  }

  return { findings: kept, discarded };
}

// =============================================================================
// 룰만으로 만드는 리포트 (모델이 없거나 두 번 다 실패했을 때)
// =============================================================================

const SEVERITY_WEIGHT: Record<RuleSeverity, number> = { high: 20, mid: 10, low: 5 };

/**
 * 위험 점수.
 *
 * **모델이 낸 점수를 그대로 쓰지 않는다.** 같은 findings 에 매번 다른 점수가 붙으면
 * 사용자는 문서가 바뀐 줄 안다. 등급별 가중치의 합을 100 에서 자르는 결정적 계산이며,
 * 그래서 두 리포트를 견줄 수 있다.
 */
export function riskScore(findings: readonly { severity: RuleSeverity }[]): number {
  const total = findings.reduce((sum, finding) => sum + SEVERITY_WEIGHT[finding.severity], 0);

  return Math.min(100, total);
}

/** 룰이 찾은 것만으로 만든 리포트. 설명·협상 문구 자리는 **비운다**(지어내지 않는다). */
export function buildRuleOnlyReport(matches: readonly RuleMatch[]): Report {
  const findings: Finding[] = matches.map((match) => ({
    rule_code: match.rule_code,
    severity: match.severity,
    // 부재 룰은 인용할 문장이 없다. 빈 문자열을 넣으면 스키마가 막으므로 제목을 쓴다.
    clause_excerpt: match.clause_excerpt === "" ? match.title : match.clause_excerpt,
    issue: match.title,
    basis_ref: match.basis_ref,
    // **문구를 지어내지 않는다.** 협상 문구는 모델이 붙이는 것이고, 없으면 없다고 적는다.
    negotiation_script: NO_SCRIPT_NOTE,
  }));

  return {
    risk_score: riskScore(findings),
    summary: ruleOnlySummary(matches),
    findings,
    missing_clauses: matches
      .filter((match) => match.kind === "absence")
      .map((match) => match.title),
    negotiation_points: [],
    disclaimer: AI_DISCLAIMER,
  };
}

export const NO_SCRIPT_NOTE = "요청 문구는 아직 준비되지 않았어요.";

export function ruleOnlySummary(matches: readonly RuleMatch[]): string {
  if (matches.length === 0) {
    // **"위험 없음" 이라고 말하지 않는다.** 룰이 못 찾은 것과 위험이 없는 것은 다르다.
    return "검출 룰에 걸린 조항이 없어요. 룰이 찾지 못한 위험이 있을 수 있으니 계약 전에 조항을 한 번 더 확인해 주세요.";
  }

  const byCategory = new Map<RuleCategory, number>();
  for (const match of matches) {
    byCategory.set(match.category, (byCategory.get(match.category) ?? 0) + 1);
  }

  const parts = [...byCategory.entries()].map(
    ([category, count]) => `${RULE_CATEGORY_LABEL[category]} ${count}건`,
  );

  return `검출 룰이 ${matches.length}건을 찾았어요 (${parts.join(" · ")}).`;
}

// =============================================================================
// 화면 조립
// =============================================================================

export const SEVERITY_ORDER: Record<RuleSeverity, number> = { high: 0, mid: 1, low: 2 };

export const SEVERITY_LABEL: Record<RuleSeverity, string> = {
  high: "높음",
  mid: "보통",
  low: "낮음",
};

/** 등급이 높은 순. 같은 등급이면 룰 코드 순으로 고정해 화면이 흔들리지 않게 한다. */
export function sortBySeverity<T extends { severity: RuleSeverity; rule_code: string }>(
  findings: readonly T[],
): T[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.rule_code.localeCompare(b.rule_code),
  );
}

export function severityCounts(
  findings: readonly { severity: RuleSeverity }[],
): Record<RuleSeverity, number> {
  const counts: Record<RuleSeverity, number> = { high: 0, mid: 0, low: 0 };

  for (const finding of findings) counts[finding.severity] += 1;

  return counts;
}

// =============================================================================
// 8단계 — 파기
// =============================================================================

/** 파기 기한. **분석 완료 후 24시간 내**(CLAUDE.md §5.1). 업로드 시각 기준으로 잡는다. */
export const PURGE_AFTER_HOURS = 24;

export function purgeScheduledAt(uploadedAtMs: number): string {
  return new Date(uploadedAtMs + PURGE_AFTER_HOURS * 3_600_000).toISOString();
}

export const PURGE_NOTICE =
  "업로드한 원문은 분석이 끝나면 바로 지웁니다. 결과(조항 요약)만 남고 원문은 남지 않아요.";

/**
 * 무엇을 가리는지 화면이 밝힌다(§5.2 3단계 · CLAUDE.md §5.2).
 *
 * 종류를 적는 이유는 "알아서 가려 준다" 보다 **무엇을 가리는지 아는 편**이 사용자가
 * 판단할 수 있기 때문이다 — 목록에 없는 것이 문서에 있으면 올리기 전에 지울 수 있다.
 */
export const MASKED_KINDS_NOTE =
  "이름·연락처·주민번호·주소·계좌·사업자번호는 AI 에 보내기 전에 가립니다.";

export const UPLOAD_CONSENT_LABEL =
  "원문 파기·마스킹 정책을 확인했고, 분석을 위해 문서를 올리는 데 동의합니다.";

/** 파기 상태 표기. **'삭제됨' 을 실패로 읽히게 하지 않는다** — 그것이 약속한 동작이다. */
export type PurgeState = "purged" | "scheduled";

export function purgeState(purgedAt: string | null): PurgeState {
  return purgedAt === null ? "scheduled" : "purged";
}

export const PURGE_STATE_LABEL: Record<PurgeState, string> = {
  purged: "원문 파기 완료",
  scheduled: "파기 예정",
};

// =============================================================================
// 업로드 규격 (§5.2 1단계)
// =============================================================================

export const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * 받는 형식.
 *
 * **텍스트를 실제로 읽어 낼 수 있는 것만 목록에 둔다.** PDF·이미지 추출기는 아직
 * 없고(어댑터가 `unsupported` 로 답한다), 목록에 넣어 두면 사용자는 올린 뒤에야
 * 못 읽는다는 것을 안다 — 20MB 를 올리게 하고 나서 거절하는 셈이다.
 */
export const DOCUMENT_ACCEPTED_MIMES = ["text/plain"] as const;

export const DOCUMENT_FORMAT_NOTE =
  "지금은 텍스트 파일(.txt)만 읽을 수 있어요. 사진·PDF 읽기는 준비 중입니다.";

export type UploadRejection = { reason: "too_large" | "mime" | "consent"; message: string };

export function validateUpload(input: {
  mime: string;
  size: number;
  consented: boolean;
}): UploadRejection | null {
  // **동의를 먼저 본다.** 파일을 검사하고 나서 동의를 묻는 순서가 되면, 동의 없는
  // 업로드가 서버까지 왔다는 뜻이 된다(§5.2 1단계 "동의 없으면 업로드 차단").
  if (!input.consented) {
    return { reason: "consent", message: "파기·마스킹 정책에 동의해야 올릴 수 있어요." };
  }

  if (!(DOCUMENT_ACCEPTED_MIMES as readonly string[]).includes(input.mime)) {
    return { reason: "mime", message: DOCUMENT_FORMAT_NOTE };
  }

  if (input.size > DOCUMENT_MAX_BYTES) {
    return { reason: "too_large", message: "20MB 까지 올릴 수 있어요." };
  }

  return null;
}

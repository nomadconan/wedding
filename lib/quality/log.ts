import type { ValidationResult } from "@/lib/core/quality/metrics";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * AI 호출 로그 (S8-07 · F-A-04 · 명세서 §5.8)
 *
 * ── 왜 래퍼를 만드는가 ──────────────────────────────────────────────────────
 * D-11 은 "기록 래퍼는 **소비처 생성 시점에** 만든다" 고 정했고 지금 그 시점이다.
 * 그전까지 `ai_call_logs` 를 쓰는 곳은 `lib/reports/analyze.ts` **하나뿐**이었다 —
 * 플래너도 조건 검색 파서도 같은 파이프라인(zod 검증 → 1회 재시도 → 실패 처리)을
 * 타는데 **아무 데도 남기지 않았다.**
 *
 * 그래서 품질 대시보드를 그대로 세우면 "플래너 실패율 0%" 가 뜬다. 그것은 측정이
 * 아니라 **측정하지 않았다는 사실이 0으로 보이는 것**이다(함정 2). 화면이 그 둘을
 * 구분하려면 `instrumented` 를 알아야 하고, 그러려면 실제로 남겨야 한다.
 *
 * ── 무엇을 남기지 않는가 ────────────────────────────────────────────────────
 * **본문·프롬프트·대화·조항을 담을 자리를 두지 않았다**(§7.3 · CLAUDE.md §5.3).
 * 인자에 있는 것은 기능·모델·판본·검증 결과·숫자뿐이며, 그래서 이 표는 운영자에게
 * 행 단위로 열어도 된다(0059 의 정책이 그 전제 위에 있다).
 *
 * **적재 실패가 본 작업을 깨뜨리지 않는다.** 품질 로그를 못 남겼다고 사용자의
 * 리포트를 되돌리면 더 나쁘다. 대신 실패 사실을 남긴다 — 조용히 삼키지 않는다
 * (`recordEvent` 와 같은 규칙).
 */
export type AiCallLogInput = {
  feature: "planner" | "report" | "estimate" | "search";
  model: string | null;
  promptVersion: string;
  validationResult: ValidationResult;
  retryCount: number;
  latencyMs?: number | null;
  tokenIn?: number | null;
  tokenOut?: number | null;
  /** 리포트 전용. 없으면 null 이며 표는 `on delete set null` 이다. */
  analysisId?: string | null;
  /** 모델이 만들어 낸 finding 수 / 인용 대조에서 버린 수(§5.2 7단계). */
  findingsGenerated?: number | null;
  findingsDiscarded?: number | null;
};

export async function logAiCall(input: AiCallLogInput): Promise<void> {
  const { error } = await createAdminClient()
    .from("ai_call_logs")
    .insert({
      feature: input.feature,
      model: input.model,
      prompt_version: input.promptVersion,
      validation_result: input.validationResult,
      retry_count: input.retryCount,
      latency_ms: input.latencyMs ?? null,
      token_in: input.tokenIn ?? null,
      token_out: input.tokenOut ?? null,
      analysis_id: input.analysisId ?? null,
      findings_generated: input.findingsGenerated ?? null,
      findings_discarded: input.findingsDiscarded ?? null,
    });

  if (error) {
    // **식별자와 코드만 남긴다.** 입력 객체를 통째로 찍으면 §5.3 을 어긴다.
    console.error("[ai_call_logs] insert failed", {
      feature: input.feature,
      validationResult: input.validationResult,
      code: error.code,
    });
  }
}

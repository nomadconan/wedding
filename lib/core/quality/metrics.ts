// AI 품질·비용 지표 (S8-07 · F-A-04 · 명세서 §5.8)
//
// ══════════════════════════════════════════════════════════════════════════
// **측정값과 목표를 같은 얼굴로 그리지 않는다.**
// ══════════════════════════════════════════════════════════════════════════
//
// §5.8 의 표는 열 제목이 **'목표(가정)'** 이다. 3%·5%·60초·5%는 명세가 스스로
// 가정이라 밝힌 값이며 문서 머리글도 "'(가정)' 표기 항목은 검증 전 목표치이며,
// 실측·인터뷰(O-07) 후 갱신한다" 고 적는다.
//
// 그래서 이 파일은 **측정만 한다.** 목표는 함께 내보내되 `assumed: true` 를 달고,
// **'초과'·'미달' 같은 판정을 만들지 않는다** — 가정치로 낸 판정은 곧 운영 기준으로
// 굳고(D-123 이 가격 임계에서 물린 자리), 그때 "왜 3%인가" 에 아무도 답할 수 없다.
// 화면은 측정값 옆에 목표를 적고, 그 목표가 가정이라는 사실도 함께 적는다.
//
// **비용만은 아예 계산하지 않는다.** 단가가 없으면 금액이 성립하지 않고, 0원은
// "비용이 없었다" 로 읽힌다(O-21 · S8-01 이 수수료 수익에서 정한 것과 같다).

/** `ai_call_logs.validation_result` 어휘. DB CHECK 이 같은 목록을 강제한다(0059). */
export const VALIDATION_RESULTS = [
  "ok",
  "invalid_output",
  "call_failed",
  "no_key",
  "nothing_left",
  "masking_blocked",
  "limit_reached",
] as const;
export type ValidationResult = (typeof VALIDATION_RESULTS)[number];

export const VALIDATION_RESULT_LABEL: Record<ValidationResult, string> = {
  ok: "검증 통과",
  invalid_output: "스키마 불일치",
  call_failed: "호출 실패",
  no_key: "키 없음 — 부르지 않음",
  nothing_left: "넘길 것 없음 — 부르지 않음",
  masking_blocked: "마스킹 차단 — 부르지 않음",
  limit_reached: "상한 도달 — 부르지 않음",
};

/**
 * **부르지 않은 것은 실패가 아니다.**
 *
 * 키가 없거나 룰이 이미 다 읽었거나 상한에 막혔으면 모델을 부른 적이 없다.
 * 그것을 실패율의 분모에 넣으면 **로컬 개발 환경에서 실패율이 100%** 가 되고,
 * 실제로 스키마가 깨진 날과 구분되지 않는다.
 */
export const NOT_ATTEMPTED: readonly ValidationResult[] = [
  "no_key",
  "nothing_left",
  "masking_blocked",
  "limit_reached",
];

export function wasAttempted(result: string | null): boolean {
  return result !== null && !(NOT_ATTEMPTED as readonly string[]).includes(result);
}

export function isFailure(result: string | null): boolean {
  return result === "invalid_output" || result === "call_failed";
}

/** §5.8 의 목표. **전부 명세가 '(가정)' 이라 밝힌 값**이라 그 사실을 함께 들고 다닌다. */
export const QUALITY_TARGETS = {
  validationFailureBp: { value: 300, assumed: true, label: "3% 미만" },
  discardBp: { value: 500, assumed: true, label: "5% 미만" },
  latencyP95Ms: { value: 60_000, assumed: true, label: "60초 이내" },
  sampleReviewBp: { value: 500, assumed: true, label: "생성 리포트의 5%" },
} as const;

/** 비용 단가가 정해질 때까지 기다리는 자리. */
export const AI_COST_OPEN_ISSUE = "O-21";

/** 집계에 쓰는 호출 한 건. **본문도 프롬프트도 담지 않는다**(§7.3). */
export type CallLog = {
  feature: string;
  model: string | null;
  promptVersion: string | null;
  validationResult: string | null;
  retryCount: number;
  latencyMs: number | null;
  tokenIn: number | null;
  tokenOut: number | null;
  findingsGenerated: number | null;
  findingsDiscarded: number | null;
  createdAt: string;
};

/**
 * 비율 한 칸.
 *
 * **분모가 0이면 `null` 이다.** 0% 로 적으면 "시도했는데 한 건도 실패하지 않았다" 로
 * 읽히고, 그것은 "시도가 없었다" 와 정반대의 판단을 부른다(S8-01 의 `no_basis` 와
 * 같은 규칙).
 */
export type Ratio = {
  /** basis point. 부동소수점을 만들지 않는다. */
  bp: number | null;
  numerator: number;
  denominator: number;
};

function ratio(numerator: number, denominator: number): Ratio {
  return {
    bp: denominator === 0 ? null : Math.round((numerator / denominator) * 10_000),
    numerator,
    denominator,
  };
}

/**
 * p95 지연.
 *
 * **보간하지 않는다** — nearest-rank 다(`buildPriceIndex` 가 사분위에서 쓰는 방식과
 * 같다). 표본이 적을 때 보간값은 실제로 일어난 적 없는 숫자를 만든다.
 */
export function percentile(values: readonly number[], p: number): number | null {
  const sorted = [...values].filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;

  const rank = Math.ceil((p / 100) * sorted.length);

  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

export type FeatureBreakdown = {
  feature: string;
  attempted: number;
  failed: number;
  failureRate: Ratio;
  /** 이 기능이 로그를 남기고 있는가. **0건과 '계측되지 않음' 을 가른다**(함정 2). */
  instrumented: boolean;
};

export type CostEstimate =
  | { status: "blocked"; reason: "price_undecided"; openIssue: string; tokenIn: number; tokenOut: number }
  | { status: "measured"; krw: number; tokenIn: number; tokenOut: number; calls: number };

export type QualitySummary = {
  windowDays: number;
  totalCalls: number;
  attempted: number;
  /** 부르지 않은 호출. 실패가 아니라는 사실을 화면이 적을 수 있게 따로 낸다. */
  notAttempted: number;
  validationFailure: Ratio;
  discard: Ratio;
  latencyP95Ms: number | null;
  latencySamples: number;
  byFeature: FeatureBreakdown[];
  cost: CostEstimate;
  targets: typeof QUALITY_TARGETS;
};

/** 단가. 미결이면 `null` — `readIntSetting` 이 `null` 을 0 으로 읽지 않는다(S7-17). */
export type TokenPrices = { inputPerMTokKrw: number | null; outputPerMTokKrw: number | null };

export function costUsable(prices: TokenPrices): boolean {
  return prices.inputPerMTokKrw !== null && prices.outputPerMTokKrw !== null;
}

/**
 * 비용.
 *
 * **정수 원화로 낸다.** 토큰 × 단가 / 1_000_000 을 부동소수점으로 누적하면 호출이
 * 쌓일수록 오차가 붙는다. 토큰을 먼저 다 더하고 마지막에 한 번만 나눈다.
 */
export function estimateCost(logs: readonly CallLog[], prices: TokenPrices): CostEstimate {
  const tokenIn = logs.reduce((sum, log) => sum + (log.tokenIn ?? 0), 0);
  const tokenOut = logs.reduce((sum, log) => sum + (log.tokenOut ?? 0), 0);

  if (!costUsable(prices)) {
    return {
      status: "blocked",
      reason: "price_undecided",
      openIssue: AI_COST_OPEN_ISSUE,
      tokenIn,
      tokenOut,
    };
  }

  const krw = Math.round(
    (tokenIn * (prices.inputPerMTokKrw as number) + tokenOut * (prices.outputPerMTokKrw as number)) /
      1_000_000,
  );

  return { status: "measured", krw, tokenIn, tokenOut, calls: logs.length };
}

/**
 * §5.8 이 요구하는 넷을 한 번에 낸다.
 *
 * `features` 는 **로그가 있든 없든 전부** 돌려준다 — 계측되지 않은 기능이 목록에서
 * 빠지면 화면은 그 기능이 없는 줄 안다(함정 2).
 */
export function summarize(
  logs: readonly CallLog[],
  options: { windowDays: number; features: readonly string[]; prices: TokenPrices },
): QualitySummary {
  const attemptedLogs = logs.filter((log) => wasAttempted(log.validationResult));
  const failedLogs = attemptedLogs.filter((log) => isFailure(log.validationResult));

  // 폐기율의 분모는 **모델이 실제로 만들어 낸 finding 수**다. 호출 수가 아니다 —
  // 한 호출이 열 건을 내고 그중 셋이 폐기된 것과, 열 번 불러 셋이 폐기된 것은 다르다.
  const generated = logs.reduce((sum, log) => sum + (log.findingsGenerated ?? 0), 0);
  const discarded = logs.reduce((sum, log) => sum + (log.findingsDiscarded ?? 0), 0);

  const latencies = logs
    .map((log) => log.latencyMs)
    .filter((value): value is number => value !== null);

  const byFeature: FeatureBreakdown[] = options.features.map((feature) => {
    const mine = logs.filter((log) => log.feature === feature);
    const mineAttempted = mine.filter((log) => wasAttempted(log.validationResult));
    const mineFailed = mineAttempted.filter((log) => isFailure(log.validationResult));

    return {
      feature,
      attempted: mineAttempted.length,
      failed: mineFailed.length,
      failureRate: ratio(mineFailed.length, mineAttempted.length),
      instrumented: mine.length > 0,
    };
  });

  return {
    windowDays: options.windowDays,
    totalCalls: logs.length,
    attempted: attemptedLogs.length,
    notAttempted: logs.length - attemptedLogs.length,
    validationFailure: ratio(failedLogs.length, attemptedLogs.length),
    discard: ratio(discarded, generated),
    latencyP95Ms: percentile(latencies, 95),
    latencySamples: latencies.length,
    byFeature,
    cost: estimateCost(logs, options.prices),
    targets: QUALITY_TARGETS,
  };
}

/**
 * 빈 결과 처리 (S7-20 · 명세서 §5.6 "툴이 빈 결과를 돌려줄 때" · IDEA-03)
 *
 * **데이터가 쌓여야 답할 게 생긴다.** 업체·거래가 없는 초기에는 대부분의 툴이 빈
 * 결과를 낸다. 무엇을 말할지 정해 두지 않으면 모델은 **학습 데이터의 한국 웨딩 시세**
 * 로 그 자리를 메운다 — 이 가드레일이 막으려는 가장 현실적인 실패다.
 *
 * 그래서 툴은 빈 결과에 **사유 코드**를 담아 돌려주고, 모델은 그 코드에 대응하는
 * 문장만 쓴다. 지어낼 자리를 문장 단위로 없앤다.
 *
 * **사과로 끝내지 않는다.** "없어요" 만 남기면 대화가 끊긴다 — 지금 할 수 있는 다음
 * 행동을 하나 함께 준다.
 */

export const EMPTY_REASONS = [
  /** 표본이 아예 없다. */
  "no_sample",
  /** 표본이 기준 미만이라 분포를 내지 않는다. */
  "not_enough_sample",
  /** 조건에 맞는 것이 없다. */
  "no_match",
  /** 아직 세지 않는 지표. **0이 아니다.** */
  "not_counted_yet",
] as const;

export type EmptyReason = (typeof EMPTY_REASONS)[number];

export type EmptyGuidance = {
  reason: EmptyReason;
  /** 모델이 그대로 옮겨 적는 문장. 숫자를 담지 않는다. */
  say: string;
  /** 지금 할 수 있는 다음 행동 하나. */
  nextAction: string;
};

export const EMPTY_GUIDANCE: Record<EmptyReason, EmptyGuidance> = {
  no_sample: {
    reason: "no_sample",
    say: "이 지역·카테고리는 아직 비교 기준이 없어요.",
    nextAction: "조건으로 직접 찾아보고 마음에 드는 곳을 담아 두기",
  },
  not_enough_sample: {
    reason: "not_enough_sample",
    say: "표본이 아직 적어서 분포를 보여드리지 않아요.",
    nextAction: "표본이 모일 때까지는 등록가를 직접 견줘 보기",
  },
  no_match: {
    reason: "no_match",
    say: "지금 조건에 맞는 것이 없어요.",
    nextAction: "조건 하나를 풀어 다시 찾아보기",
  },
  not_counted_yet: {
    reason: "not_counted_yet",
    say: "이 값은 아직 세지 않아요.",
    nextAction: "지금 셀 수 있는 값으로 대신 견줘 보기",
  },
};

/**
 * 툴이 쓸 수 없는 상태. **빈 결과와 다르다.**
 *
 * 빈 결과는 "데이터가 없다" 이고 이쪽은 "판정 근거가 없다" 다. 둘을 한 코드로 묶으면
 * 운영 파라미터가 비어 있는 것이 표본 부족처럼 보이고, 그러면 값을 넣어야 할 사람이
 * 자기 차례인 줄 모른다.
 *
 *  - `setting_missing` 운영 파라미터(`app_settings`)가 비어 있다. 코드가 값을 고르지 않는다.
 *  - `rule_missing`    기준 룰(위약금 밴드 등)이 없다.
 *  - `screen_not_ready` 안내할 화면이 아직 없다(S3-11 — 없는 화면으로 보내지 않는다).
 *  - `no_couple`       커플이 없다. 온보딩 전이라 커플 스코프 조회가 성립하지 않는다.
 *  - `tool_failed`     조회 자체가 실패했다. **빈 결과로 위장하지 않는다** — "없다" 와
 *    "못 봤다" 를 같은 문장으로 말하면 사용자는 없는 것으로 이해하고 판단을 내린다
 *    (S7-01 이 "룰 0건이면 분석을 시작하지 않는다" 에서 세운 것과 같은 구분이다).
 */
export const UNAVAILABLE_REASONS = [
  "setting_missing",
  "rule_missing",
  "screen_not_ready",
  "no_couple",
  "tool_failed",
] as const;

export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

export const UNAVAILABLE_GUIDANCE: Record<UnavailableReason, string> = {
  setting_missing: "아직 운영 기준이 정해지지 않아 계산해 드릴 수 없어요.",
  rule_missing: "비교할 기준이 아직 등록되지 않아 계산해 드릴 수 없어요.",
  screen_not_ready: "그 화면은 아직 준비 중이에요.",
  no_couple: "먼저 온보딩을 마치면 예식일·예산을 함께 볼 수 있어요.",
  tool_failed: "지금은 조회가 되지 않아 확인해 드릴 수 없어요. 잠시 뒤에 다시 물어봐 주세요.",
};

// =============================================================================
// 툴 결과 봉투
// =============================================================================

/**
 * 모든 툴이 이 세 모양 중 하나를 돌려준다.
 *
 * 봉투를 하나로 묶는 이유는 **후처리가 결과를 읽어야** 하기 때문이다(§5.6 응답 후처리
 * 수치 대조). 툴마다 모양이 다르면 "응답의 숫자가 툴 결과에 있는가" 를 툴 수만큼
 * 다르게 물어야 하고, 그 순간 검사가 새는 자리가 생긴다.
 */
export type ToolResult<T = unknown> =
  | { status: "ok"; data: T }
  | { status: "empty"; reason: EmptyReason; guidance: EmptyGuidance; data?: T }
  | { status: "unavailable"; reason: UnavailableReason; say: string; filledBy?: string };

export function okResult<T>(data: T): ToolResult<T> {
  return { status: "ok", data };
}

export function emptyResult<T>(reason: EmptyReason, data?: T): ToolResult<T> {
  const base = { status: "empty" as const, reason, guidance: EMPTY_GUIDANCE[reason] };

  return data === undefined ? base : { ...base, data };
}

export function unavailableResult<T>(
  reason: UnavailableReason,
  filledBy?: string,
): ToolResult<T> {
  const base = { status: "unavailable" as const, reason, say: UNAVAILABLE_GUIDANCE[reason] };

  return filledBy === undefined ? base : { ...base, filledBy };
}

/**
 * 감사 기록에 남길 한 줄 요약(`ai_tool_calls.result_summary`).
 *
 * **원문·이름·금액을 담지 않는다**(CLAUDE.md §5.3). 남기는 것은 상태와 셀 수 있는
 * 값뿐이다 — "무엇을 돌려줬는가" 가 아니라 "몇 건을 돌려줬는가" 다.
 */
export function summarizeResult(result: ToolResult, count?: number): string {
  if (result.status === "ok") {
    return count === undefined ? "ok" : `ok:${count}`;
  }

  if (result.status === "empty") return `empty:${result.reason}`;

  return `unavailable:${result.reason}`;
}

/**
 * 턴·토큰 상한 (S7-20 · 명세서 §5.6 가드레일 · §7.4 파라미터)
 *
 * **값을 코드가 고르지 않는다.** `ai.free_daily_turns` · `ai.session_token_cap` 은
 * `app_settings` 가 갖는다(§7.4). 값이 없으면 임의 기본값을 만들지 않고 **대화를
 * 열지 않는다** — O-15(수수료 기준)에서 세운 것과 같은 규칙이다. 여기서 특히 그래야
 * 하는 이유는, 없는 상한을 '무제한' 으로 읽으면 그 순간 비용 상한이 사라지기 때문이다.
 * 조용히 열리는 쪽보다 명시적으로 막히는 쪽이 낫다.
 *
 * **세션 토큰 상한은 등급과 무관하다.** 턴 제한은 멤버십으로 풀리지만 토큰 상한은
 * 누구에게나 걸린다 — 비용 사고는 한 세션에서 난다(§5.6).
 */

// **어휘는 DB 가 진실이다**(`membership_plan` enum = free | premium · S7-11).
// S7-20 이 `member` 로 적었던 것을 그쪽으로 맞췄다 — 같은 것에 이름이 둘이면
// 경계마다 옮겨야 하고 옮기는 자리가 곧 어긋나는 자리다.
export const MEMBERSHIP_TIERS = ["free", "premium"] as const;
export type MembershipTier = (typeof MEMBERSHIP_TIERS)[number];

export const TURN_BLOCK_REASONS = ["daily_limit", "unconfigured"] as const;
export type TurnBlockReason = (typeof TURN_BLOCK_REASONS)[number];

export type TurnVerdict =
  /** `remaining` 이 null 이면 무제한(멤버십)이다. **0이 아니다.** */
  | { ok: true; remaining: number | null }
  | { ok: false; reason: TurnBlockReason; notice: string };

export const TURN_BLOCK_NOTICE: Record<TurnBlockReason, string> = {
  daily_limit: "오늘 쓸 수 있는 대화 횟수를 다 썼어요. 내일 다시 이어서 이야기해요.",
  unconfigured:
    "대화 한도가 아직 설정되지 않아 클리어를 열 수 없어요. 준비되면 바로 열립니다.",
};

/**
 * 이번 턴을 열어도 되는가.
 *
 * @param usedToday 오늘 이미 쓴 사용자 턴 수(같은 커플 기준).
 * @param freeDailyTurns `app_settings.ai.free_daily_turns`. 없으면 null.
 */
export function turnAllowance(input: {
  usedToday: number;
  freeDailyTurns: number | null;
  membership: MembershipTier;
}): TurnVerdict {
  // 멤버십은 턴 무제한이다(§5.6). 설정값을 보지 않으므로 값이 없어도 막지 않는다 —
  // 막을 이유가 그쪽에는 없다(비용 방어는 아래 토큰 상한이 진다).
  if (input.membership === "premium") return { ok: true, remaining: null };

  if (input.freeDailyTurns === null || !Number.isInteger(input.freeDailyTurns)) {
    return { ok: false, reason: "unconfigured", notice: TURN_BLOCK_NOTICE.unconfigured };
  }

  const remaining = input.freeDailyTurns - input.usedToday;

  if (remaining <= 0) {
    return { ok: false, reason: "daily_limit", notice: TURN_BLOCK_NOTICE.daily_limit };
  }

  return { ok: true, remaining };
}

export const TOKEN_BLOCK_REASONS = ["session_cap", "unconfigured"] as const;
export type TokenBlockReason = (typeof TOKEN_BLOCK_REASONS)[number];

export type TokenVerdict =
  | { ok: true; remaining: number }
  | { ok: false; reason: TokenBlockReason; notice: string };

export const TOKEN_BLOCK_NOTICE: Record<TokenBlockReason, string> = {
  session_cap:
    "이 대화가 길어져서 여기서 한 번 끊을게요. 새 대화를 시작하면 이어서 도와드릴 수 있어요.",
  unconfigured:
    "대화 한도가 아직 설정되지 않아 클리어를 열 수 없어요. 준비되면 바로 열립니다.",
};

/**
 * 세션 토큰 상한.
 *
 * **등급을 인자로 받지 않는다.** 받으면 언젠가 "유료는 예외" 가 되고, 비용 사고는
 * 정확히 그 예외에서 난다.
 */
export function tokenAllowance(input: {
  sessionTokens: number;
  cap: number | null;
}): TokenVerdict {
  if (input.cap === null || !Number.isInteger(input.cap) || input.cap <= 0) {
    return { ok: false, reason: "unconfigured", notice: TOKEN_BLOCK_NOTICE.unconfigured };
  }

  const remaining = input.cap - input.sessionTokens;

  if (remaining <= 0) {
    return { ok: false, reason: "session_cap", notice: TOKEN_BLOCK_NOTICE.session_cap };
  }

  return { ok: true, remaining };
}

export type ConversationGate =
  | { ok: true; turnsRemaining: number | null; tokensRemaining: number }
  | { ok: false; reason: TurnBlockReason | TokenBlockReason; notice: string };

/**
 * 두 상한을 함께 본다. **토큰을 먼저 본다** — 등급과 무관한 제약이 먼저 걸려야
 * "멤버십이면 통과" 라는 착시가 생기지 않는다.
 */
export function conversationGate(input: {
  usedToday: number;
  sessionTokens: number;
  freeDailyTurns: number | null;
  sessionTokenCap: number | null;
  membership: MembershipTier;
}): ConversationGate {
  const tokens = tokenAllowance({
    sessionTokens: input.sessionTokens,
    cap: input.sessionTokenCap,
  });

  if (!tokens.ok) return { ok: false, reason: tokens.reason, notice: tokens.notice };

  const turns = turnAllowance({
    usedToday: input.usedToday,
    freeDailyTurns: input.freeDailyTurns,
    membership: input.membership,
  });

  if (!turns.ok) return { ok: false, reason: turns.reason, notice: turns.notice };

  return { ok: true, turnsRemaining: turns.remaining, tokensRemaining: tokens.remaining };
}

/** `app_settings` 키. 값이 아니라 **키만** 코드가 갖는다. */
export const AI_SETTING_KEYS = {
  freeDailyTurns: { key: "ai.free_daily_turns", field: "value" },
  sessionTokenCap: { key: "ai.session_token_cap", field: "value" },
} as const;

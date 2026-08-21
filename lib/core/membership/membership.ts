/**
 * 멤버십 (S7-11 · 명세서 §2.1 F-C-19 · §3.1 memberships · §6.2 `/membership`)
 *
 * ── 이 파일이 정하는 것 ─────────────────────────────────────────────────────
 * **지금 이 사람이 어느 등급인가**와 **등급이 무엇을 가르는가**뿐이다. 값(가격)은
 * `app_settings` 가 갖고 결제는 어댑터가 한다(D-28).
 *
 * ── 등급은 저장값이 아니라 계산값이다 ──────────────────────────────────────
 * `memberships` 행이 갖는 것은 **무엇을 샀는가**(plan · status · expires_at)이고,
 * **지금 유효한 등급**은 거기에 시각을 더해 계산한다. 저장하면 만료된 순간과 배치가
 * 도는 순간 사이에 화면이 거짓말을 한다(D-71·D-84 와 같은 판단).
 *
 * ── 어휘를 DB 에 맞춘다 ─────────────────────────────────────────────────────
 * `membership_plan` enum 은 `free | premium` 이다. S7-20 이 `free | member` 로
 * 적어 두었던 것을 **DB 쪽으로 맞춘다** — 같은 것에 이름이 둘이면 경계마다 옮겨야 하고
 * 옮기는 자리가 곧 어긋나는 자리다.
 *
 * 프레임워크를 모르는 순수 모듈이다.
 */

export const MEMBERSHIP_PLANS = ["free", "premium"] as const;
export type MembershipPlan = (typeof MEMBERSHIP_PLANS)[number];

export const MEMBERSHIP_PLAN_LABEL: Record<MembershipPlan, string> = {
  free: "무료",
  premium: "멤버십",
};

/**
 * 구독 행의 상태.
 *
 * `canceled` 는 **지금 끊긴 것이 아니라 갱신하지 않겠다는 뜻**이다 — 이미 낸 기간은
 * 그대로 쓴다. 그래서 등급 판정은 `status` 가 아니라 **기한**이 정한다.
 */
export const MEMBERSHIP_STATUSES = ["active", "canceled", "expired"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

// =============================================================================
// 지금 유효한 등급
// =============================================================================

export type MembershipRow = {
  plan: MembershipPlan;
  status: MembershipStatus;
  startedAt: string | null;
  expiresAt: string | null;
};

export const MEMBERSHIP_REASONS = [
  /** 산 적이 없다. */
  "none",
  /** 유효한 구독이 있다. */
  "active",
  /** 해지했지만 남은 기간을 쓰는 중이다. */
  "canceled_until_expiry",
  /** 기한이 지났다. */
  "expired",
] as const;
export type MembershipReason = (typeof MEMBERSHIP_REASONS)[number];

export type MembershipState = {
  /** **지금 유효한 등급.** 저장값이 아니라 계산값이다. */
  plan: MembershipPlan;
  reason: MembershipReason;
  expiresAt: string | null;
  /** 해지 예약 상태인가. 화면이 "언제까지 쓸 수 있는지" 를 적는 근거다. */
  cancelPending: boolean;
};

export const MEMBERSHIP_REASON_NOTE: Record<MembershipReason, string> = {
  none: "아직 멤버십을 쓰고 있지 않아요.",
  active: "멤버십을 쓰고 있어요.",
  canceled_until_expiry: "해지를 예약했어요. 남은 기간까지는 그대로 쓸 수 있어요.",
  expired: "멤버십 기간이 끝났어요. 다시 시작하면 이어서 쓸 수 있어요.",
};

/**
 * 지금 유효한 등급.
 *
 * **기한이 지났으면 `free` 다.** 행의 `plan` 이 `premium` 이어도 그렇다 — 만료를
 * 배치가 옮겨 적기를 기다리면 그 사이에 화면이 거짓말을 한다.
 *
 * **기한이 없는 `premium` 은 유효로 본다.** 무기한 부여(운영 보정·프로모션)를 표현할
 * 자리이며, 없는 기한을 '이미 만료' 로 읽으면 준 것을 안 준 것이 된다.
 */
export function membershipState(input: {
  row: MembershipRow | null;
  now: string;
}): MembershipState {
  const row = input.row;

  if (row === null || row.plan === "free") {
    return { plan: "free", reason: "none", expiresAt: null, cancelPending: false };
  }

  const expired =
    row.expiresAt !== null && Date.parse(row.expiresAt) <= Date.parse(input.now);

  if (expired || row.status === "expired") {
    return { plan: "free", reason: "expired", expiresAt: row.expiresAt, cancelPending: false };
  }

  if (row.status === "canceled") {
    // **해지해도 남은 기간은 쓴다.** 돈을 냈으니 그 기간은 그의 것이다.
    return {
      plan: "premium",
      reason: "canceled_until_expiry",
      expiresAt: row.expiresAt,
      cancelPending: true,
    };
  }

  return { plan: "premium", reason: "active", expiresAt: row.expiresAt, cancelPending: false };
}

/** 남은 일수. **음수를 내지 않는다** — 지난 것은 `membershipState` 가 말한다. */
export function daysLeft(expiresAt: string | null, now: string): number | null {
  if (expiresAt === null) return null;

  const left = Date.parse(expiresAt) - Date.parse(now);

  return left <= 0 ? 0 : Math.ceil(left / 86_400_000);
}

// =============================================================================
// 무엇이 갈리는가 — 지금은 대부분 갈리지 않는다
// =============================================================================

/**
 * 혜택 한 줄.
 *
 * `state` 가 요점이다 —
 * · `differs` : **지금 실제로 갈린다.** 무료에 제한이 있고 멤버십이 그것을 푼다.
 * · `no_limit_yet` : **아직 무료에도 제한이 없다.** 그래서 지금은 차이가 없다.
 * · `not_built` : 그 기능 자체가 아직 없다.
 */
export const BENEFIT_STATES = ["differs", "no_limit_yet", "not_built"] as const;
export type BenefitState = (typeof BENEFIT_STATES)[number];

export type MembershipBenefit = {
  key: string;
  label: string;
  state: BenefitState;
  /** 지금 무료가 어떤 상태인지. **화면이 이 문장을 그대로 적는다.** */
  note: string;
};

/**
 * §2.1 F-C-19 가 적은 넷.
 *
 * **아무것도 닫지 않았다.** 이미 열려 있던 기능을 멤버십 뒤로 옮기면 그 순간
 * 사용자는 **쓰던 것을 잃는다** — 그리고 무료 한도를 얼마로 할지는 **가격 정책**이라
 * 아직 정해진 값이 없다(O-17). 임의로 정하면 그것이 운영 기준처럼 굳는다(D-66·D-40).
 *
 * 그래서 지금 실제로 갈리는 것은 **AI 대화 턴 하나**다 — 무료 일일 한도가 **이미**
 * `app_settings.ai.free_daily_turns` 로 걸려 있었고(S7-20) 멤버십이 그것을 푼다.
 * 나머지 셋은 **무료에도 제한이 없다는 사실을 화면이 그대로 적는다** — "멤버십이면
 * 무제한" 이라고만 적으면 사용자는 무료에 제한이 있는 줄 안다.
 */
export const MEMBERSHIP_BENEFITS: readonly MembershipBenefit[] = [
  {
    key: "ai_turns",
    label: "AI 플래너 대화",
    state: "differs",
    note: "무료는 하루 쓸 수 있는 횟수가 정해져 있어요. 멤버십은 그 제한이 없습니다.",
  },
  {
    key: "reports",
    label: "계약서 검토 리포트",
    state: "no_limit_yet",
    note: "지금은 무료에도 횟수 제한이 없어요. 제한이 생기면 멤버십이 그것을 풉니다.",
  },
  {
    key: "price_detail",
    label: "가격 상세 분포",
    state: "no_limit_yet",
    note: "지금은 참가격 분포를 무료에도 그대로 보여드려요.",
  },
  {
    key: "priority_support",
    label: "우선 응답",
    state: "not_built",
    note: "업체 응답 순서를 다루는 기능을 아직 만들지 않았어요.",
  },
];

export const BENEFIT_STATE_LABEL: Record<BenefitState, string> = {
  differs: "지금 갈려요",
  no_limit_yet: "지금은 차이 없음",
  not_built: "아직 없는 기능",
};

/** 지금 실제로 갈리는 혜택. 화면이 "무엇을 사는가" 를 정직하게 적는 근거다. */
export function differingBenefits(): MembershipBenefit[] {
  return MEMBERSHIP_BENEFITS.filter((benefit) => benefit.state === "differs");
}

/**
 * **지금 사면 무엇이 달라지는지**를 한 줄로.
 *
 * 갈리는 것이 하나도 없으면 **그 사실을 말한다** — "멤버십에 가입하세요" 만 적고
 * 차이를 감추면 그것은 파는 쪽에 유리한 침묵이다(D-03 의 정신).
 */
export function differenceSummary(): string {
  const differing = differingBenefits();

  if (differing.length === 0) {
    return "지금은 무료와 멤버십의 차이가 없어요. 차이가 생기면 여기에 적어 드릴게요.";
  }

  return `지금 실제로 달라지는 것은 ${differing.map((item) => item.label).join(" · ")} 예요.`;
}

// =============================================================================
// 가격 — 코드가 값을 갖지 않는다
// =============================================================================

/**
 * 월 구독가.
 *
 * **값이 없으면 팔지 않는다.** 가격은 사업 결정이고 아직 정해진 값이 없다(O-17) —
 * 코드에 숫자를 박으면 그것이 운영 기준처럼 굳는다(D-40 이 요율 상한에서, D-66 이
 * 어뷰징 임계값에서 세운 것과 같은 규칙). 값이 없을 때 **0원으로 읽지 않는다**:
 * 0원 구독은 "공짜로 준다" 는 뜻인데 우리는 그렇게 정한 적이 없다.
 */
export type MembershipPrice =
  | { ok: true; amount: number; currency: string; cycle: "monthly" }
  | { ok: false; reason: "unconfigured" };

export const PRICE_UNCONFIGURED_NOTICE =
  "멤버십 가격이 아직 정해지지 않아 지금은 가입할 수 없어요. 정해지면 바로 열립니다.";

export function membershipPrice(input: {
  amount: number | null;
  currency: string | null;
}): MembershipPrice {
  if (input.amount === null || !Number.isInteger(input.amount) || input.amount <= 0) {
    return { ok: false, reason: "unconfigured" };
  }

  return { ok: true, amount: input.amount, currency: input.currency ?? "KRW", cycle: "monthly" };
}

/** `app_settings` 키. **값이 아니라 키만** 코드가 갖는다(§7.4). */
export const MEMBERSHIP_SETTING_KEYS = {
  monthlyPrice: { key: "membership.monthly_price", field: "value" },
  currency: { key: "membership.currency", field: "value" },
  periodDays: { key: "membership.period_days", field: "value" },
} as const;

// =============================================================================
// 화면 문구
// =============================================================================

/**
 * **앱에서는 웹으로 보낸다**(§2.1 F-C-19 — "앱은 스토어 정책 준수 링크아웃").
 *
 * 앱 안에서 우리 결제를 붙이면 스토어 정책에 걸린다. 여기서는 **사실만 적고**
 * 실제 분기는 Capacitor 래핑 시점(D-07)에 붙인다 — 지금 분기를 만들면 검증할 수 없는
 * 코드가 남는다.
 */
export const APP_STORE_NOTICE =
  "앱에서는 결제가 웹으로 연결돼요. 스토어 정책에 따른 것이며 결제 수단·금액은 같습니다.";

export const MEMBERSHIP_INTRO =
  "무료와 멤버십 두 가지예요. 지금 무엇이 실제로 달라지는지 아래에 그대로 적었어요.";

/** 해지 안내. **되돌릴 수 있다는 사실**을 함께 적는다. */
export const CANCEL_NOTICE =
  "해지해도 남은 기간까지는 그대로 쓸 수 있어요. 기간이 끝나기 전에 다시 시작할 수 있습니다.";

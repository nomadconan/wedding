/**
 * 에스크로 예치 · 이행 확인 · 릴리즈 (S5-09 · 명세서 §2.1 F-C-16, §3.4 escrow_holds,
 * §4.2, §6.2, D-21 · D-23 · D-24 · D-28, O-03)
 *
 * 프레임워크도 DB 도 모르는 순수 모듈이다. 금액은 **원 단위 정수**로만 다룬다(§6).
 *
 * ── 플랫폼은 보관자다 (D-24) ────────────────────────────────────────────────
 * 에스크로는 **양측이 합의한 조건을 플랫폼이 보관했다가 조건 충족 여부에 따라
 * 집행하는 구조**다. 플랫폼이 돈을 **버는** 것이 아니라 **맡는** 것이며, S4-07 이
 * 노쇼 보증금에서 세운 원칙과 같다. 그래서 이 파일의 문구는 전부 "보관" 이고
 * 화면은 그것을 그대로 적는다.
 *
 * ── 법적 요건이 결제보다 무겁다 (O-03) ──────────────────────────────────────
 * 자금을 **보관**하는 행위는 전자금융거래법상 등록 요건에 걸릴 수 있고 그 결론이
 * O-03 이다. 그래서 이 태스크는 **절차·기록까지**이며(커버리지 표가 그렇게 적었다)
 * 실제 자금 보관은 어댑터 뒤에 있다. 화면이 그 사실을 숨기지 않는다.
 *
 * **여기 없는 것 둘.**
 *  1. **기한 일수.** `app_settings.escrow.confirm_due_days` 가 갖는다(§7.4).
 *  2. **정산 금액.** 릴리즈는 "이 돈을 업체 몫으로 넘긴다" 까지이고, 얼마를 언제
 *     지급하는가는 S5-07 정산의 일이다.
 */

import { twoSidedOutcome, type TwoSidedOutcome } from "../confirmation/two-sided";

/** 입력이 규약을 벗어날 때 던진다. */
export class EscrowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EscrowError";
  }
}

// =============================================================================
// 값 집합 — DB CHECK 와 같아야 한다 (`db:rls` 가 정합을 본다)
// =============================================================================

/**
 * 홀드 상태.
 *
 * `held`(보관 중) → `released`(업체 몫으로 넘김) | `refunded`(고객에게 돌려줌)
 * 이고, 이의가 들어오면 `disputed`(조율 대기)로 갈라진다.
 *
 * **'실패' 상태가 없다.** 예치 자체가 실패하면 홀드 행이 만들어지지 않는다 —
 * 실패한 보관은 보관이 아니다(0030 이 결제에서 pending 을 둔 것과 다른 판단이며,
 * 이유는 에스크로가 **이미 승인된 결제** 위에 서기 때문이다).
 */
export const ESCROW_STATUSES = ["held", "disputed", "released", "refunded"] as const;
export type EscrowStatus = (typeof ESCROW_STATUSES)[number];

export const ESCROW_STATUS_LABEL: Record<EscrowStatus, string> = {
  held: "보관 중",
  disputed: "조율 중",
  released: "업체 지급 대상",
  refunded: "환불 완료",
};

/**
 * 화면이 그대로 적는 설명.
 *
 * **"플랫폼이 돈을 받는다" 로 읽히지 않게 한다**(D-24). 주어가 플랫폼이 아니라
 * **돈**이고, 플랫폼이 하는 일은 "맡아 둔다" 이다.
 */
export const ESCROW_STATUS_DETAIL: Record<EscrowStatus, string> = {
  held: "잔금이 안전거래로 맡겨져 있어요. 서비스 이행이 확인되면 업체에 전달됩니다.",
  disputed: "확인 내용이 달라 운영자가 조율하고 있어요. 그동안 금액은 그대로 맡겨져 있습니다.",
  released: "이행이 확인되어 업체 정산 대상으로 넘어갔어요.",
  refunded: "맡겨져 있던 금액이 고객에게 돌아갔어요.",
};

export const ESCROW_PARTY_NOTICE =
  "웨딩클리어는 이 금액을 **맡아 두는 역할**이며 계약 당사자가 아닙니다. 이행이 확인되면 업체에, 확인되지 않으면 합의·조율 결과에 따라 처리됩니다.";

/**
 * **전자금융업 등록은 미결이다**(O-03).
 *
 * 자금 보관은 결제보다 법적 요건이 무겁다 — 결제는 대금을 **옮기는** 일이지만
 * 에스크로는 **맡는** 일이라 등록·신탁 요건이 따로 붙을 수 있다. 그 결론이 나기
 * 전까지 이 기능은 **절차와 기록**이며, 화면이 그 사실을 숨기지 않는다.
 */
export const ESCROW_LEGAL_PENDING_NOTICE =
  "안전거래(에스크로)는 법적 요건 검토가 끝난 뒤 실제 예치가 시작됩니다. 지금은 절차와 기록만 동작하며, 금액이 실제로 분리 보관되지는 않습니다.";

// =============================================================================
// 예치 대상 — 잔금이다 (F-C-16 · D-21)
// =============================================================================

/**
 * 이 회차가 에스크로 대상인가.
 *
 * **잔금만 예치한다.** 명세 F-C-16 이 "**잔금 예치** → 서비스 이행 확인 → 정산
 * 릴리즈" 라고 적었고, 그 구분에는 이유가 있다.
 *
 *  - **1회차(계약금)는 계약 성립의 증표**다. 취소 시 위약금의 기준이기도 하다
 *    (T-04 `refundDeposit` · 검출 룰 R-02 가 계약금 몰취 조항을 따로 다룬다).
 *    그 돈까지 묶으면 **계약이 성립해도 업체는 아무것도 받지 못한 채** 예식일까지
 *    준비 비용을 먼저 쓴다. 그건 안전거래가 아니라 자금 압박이다.
 *  - **잔금은 이행 전에 내는 돈**이다(D-21 이 `before_event` 로 잡았다). 이행되지
 *    않으면 돌려받아야 하고, 바로 그 위험을 줄이는 것이 에스크로다.
 *
 * 회차가 3회 이상으로 늘어도 규칙은 같다 — **첫 회차를 뺀 나머지**가 대상이다.
 * "첫 회차 = 계약금" 은 S5-06 `purposeOfSeq` 가 이미 세운 규칙이다.
 */
export function isEscrowTarget(input: { seq: number; purpose: string }): boolean {
  if (!Number.isInteger(input.seq) || input.seq < 1) {
    throw new EscrowError(`회차 순번이 규약을 벗어났습니다: ${input.seq}`);
  }

  // 멤버십 결제에는 이행 확인이라는 개념이 없다.
  if (input.purpose === "membership") return false;

  return input.seq > 1;
}

export const ESCROW_TARGET_NOTICE =
  "계약금은 계약 성립의 증표라 바로 업체에 전달되고, **잔금이 안전거래로 맡겨집니다.**";

// =============================================================================
// 이행 확인 — 뼈대는 공통, 해석은 여기서
// =============================================================================

export type ReleaseDecision =
  | { action: "hold"; reason: "waiting"; detail: string }
  | { action: "hold"; reason: "before_event"; detail: string }
  | { action: "dispute"; detail: string }
  | { action: "release"; reason: "agreed" | "timeout"; detail: string };

/**
 * 이행 확인 결과를 에스크로의 뜻으로 옮긴다.
 *
 * ── 무응답의 기본값은 **릴리즈**다 (S4-07 과 반대 방향) ─────────────────────
 * S4-07 은 상담 보증금에서 "양측 무응답의 기본값은 **환불**" 로 정했다. 근거는
 * "몰취가 기본이면 업체는 방치가 이득이 되고 확인 절차가 형해화된다" 였다.
 *
 * **에스크로에서는 그 논리가 뒤집힌다.** 환불이 기본이면 **고객의 방치가 이득**이
 * 된다 — 서비스가 이미 이행됐는데 확인만 안 하면 업체가 영원히 돈을 못 받는다.
 * 예식은 이미 열렸고 업체는 인력·물자를 다 썼는데 대금이 묶이는 것이다.
 *
 * ── 다만 **예식일 경과를 조건으로 넣는다** ──────────────────────────────────
 * 무응답 릴리즈는 **이행이 있었을 개연성**에 기대는 판단이다. 예식일 전에는 그
 * 개연성이 없으므로(아직 아무것도 이행되지 않았다) 기한이 지나도 릴리즈하지 않는다.
 * **두 조건이 모두 맞아야** 한다: 확인 기한 경과 **그리고** 예식일 경과.
 *
 * 고객 보호 장치는 남아 있다 — 이의 창구는 릴리즈 전까지 열려 있고, 릴리즈 뒤에도
 * 해지·환불 경로(S5-08)가 따로 있다. 그리고 **한쪽이라도 '이행되지 않았다' 고 답하면
 * 즉시 조율**이라 자동 릴리즈가 그것을 덮지 않는다.
 */
export function decideRelease(input: {
  coupleConfirmed: boolean | null;
  vendorConfirmed: boolean | null;
  dueAt: string | null;
  /** 예식일(YYYY-MM-DD). null 이면 미정이며 무응답 릴리즈를 하지 않는다. */
  eventDate: string | null;
  now: Date;
}): ReleaseDecision {
  const outcome: TwoSidedOutcome = twoSidedOutcome({
    partyA: input.coupleConfirmed,
    partyB: input.vendorConfirmed,
    dueAt: input.dueAt,
    now: input.now,
  });

  if (outcome === "rejected") {
    return {
      action: "dispute",
      detail: "이행 여부에 대한 확인이 달라 운영자 조율로 넘어갑니다. 금액은 그대로 맡겨져 있어요.",
    };
  }

  if (outcome === "agreed") {
    return {
      action: "release",
      reason: "agreed",
      detail: "양측이 이행을 확인해 업체 정산 대상으로 넘깁니다.",
    };
  }

  if (outcome === "timeout") {
    // **예식일 전에는 자동 릴리즈하지 않는다.** 이행이 있었을 개연성이 없다.
    if (!eventPassed(input.eventDate, input.now)) {
      return {
        action: "hold",
        reason: "before_event",
        detail:
          "확인 기한이 지났지만 아직 예식일 전이라 그대로 맡아 둡니다. 예식이 끝난 뒤 다시 확인합니다.",
      };
    }

    return {
      action: "release",
      reason: "timeout",
      detail:
        "예식일이 지나고 확인 기한 안에 이의가 없어 업체 정산 대상으로 넘깁니다. 문제가 있으면 해지·환불 절차로 요청할 수 있어요.",
    };
  }

  return {
    action: "hold",
    reason: "waiting",
    detail: "양측 이행 확인을 기다리고 있어요.",
  };
}

/** 예식일이 지났는가. 예식 **당일은 아직 지나지 않은 것**으로 본다. */
function eventPassed(eventDate: string | null, now: Date): boolean {
  if (eventDate === null) return false;

  return now.toISOString().slice(0, 10) > eventDate.slice(0, 10);
}

export const TIMEOUT_RELEASE_NOTICE =
  "예식일이 지나고 확인 기한 안에 이의가 없으면 맡겨진 금액이 업체 정산으로 넘어갑니다. 기한 전에는 언제든 이의를 낼 수 있어요.";

// =============================================================================
// 상태 전이 — 종결은 되돌리지 않는다 (D-23)
// =============================================================================

const ALLOWED: Record<EscrowStatus, readonly EscrowStatus[]> = {
  held: ["disputed", "released", "refunded"],
  // 조율 결과는 어느 쪽으로도 갈 수 있다. 다만 다시 `held` 로 돌아가지는 않는다 —
  // 이의가 제기된 사실은 남아야 한다.
  disputed: ["released", "refunded"],
  released: [],
  refunded: [],
};

export function canTransition(from: EscrowStatus, to: EscrowStatus): boolean {
  return ALLOWED[from].includes(to);
}

export const TRANSITION_BLOCKED_NOTICE =
  "이미 종결된 안전거래는 되돌릴 수 없어요. 조정이 필요하면 해지·환불 절차로 진행합니다.";

// =============================================================================
// 정산 연결 — 릴리즈되지 않은 돈은 지급하지 않는다
// =============================================================================

/**
 * 이 예약을 이번 정산에 넣을 수 있는가.
 *
 * **보관 중인 돈을 업체에 지급하면 에스크로가 무의미해진다.** S5-07 의 집계는 "그
 * 기간에 완납된 예약" 을 대상으로 하는데, 완납과 **이행 확인은 다른 사건**이다 —
 * 잔금을 냈다는 것과 서비스가 이행됐다는 것은 별개다.
 *
 * 그래서 **릴리즈되지 않은 홀드가 하나라도 있으면 그 예약은 이번 정산에서 뺀다.**
 * 다음 기간에 다시 후보가 되므로 돈이 사라지지 않고 **늦어질 뿐**이다.
 */
export function settlementEligible(
  holds: readonly { status: EscrowStatus }[],
): { ok: true } | { ok: false; reason: "escrow_open"; detail: string } {
  const open = holds.filter((hold) => hold.status === "held" || hold.status === "disputed");

  if (open.length === 0) return { ok: true };

  return {
    ok: false,
    reason: "escrow_open",
    detail: `안전거래로 맡겨진 금액이 ${open.length}건 남아 있어 이번 정산에서 제외했습니다. 이행이 확인되면 다음 정산에 포함됩니다.`,
  };
}

export const SETTLEMENT_HELD_NOTICE =
  "안전거래로 맡겨진 금액은 이행이 확인된 뒤 정산에 포함됩니다.";

// =============================================================================
// 릴리즈 조건 — 무엇에 합의했는가를 남긴다 (D-23)
// =============================================================================

export type ReleaseCondition = {
  /** 어떤 사건이 이행의 기준인가. */
  basis: "event_completed";
  /** 확인 기한(일). 값은 설정이 갖는다(§7.4). */
  confirmDueDays: number | null;
  /** 무응답 시 어느 쪽으로 가는가. 이 판본은 언제나 release 다. */
  timeoutAction: "release";
  /** 이 조건을 만든 시점의 판본. 규칙이 바뀌어도 과거 건은 재현된다. */
  version: string;
};

export const RELEASE_CONDITION_VERSION = "v1";

/**
 * 예치 시점의 릴리즈 조건을 만든다.
 *
 * **조건을 스냅샷으로 박는다.** 나중에 기한이나 폴백 방향이 바뀌어도 **이 건이
 * 무엇에 합의했는지**는 바뀌면 안 된다 — 요율 스냅샷(D-16)·계약 해시(D-23)와 같은
 * 이유이며, 에스크로에서는 그것이 곧 "언제 이행이 확인됐는가" 의 근거가 된다.
 */
export function buildReleaseCondition(confirmDueDays: number | null): ReleaseCondition {
  if (confirmDueDays !== null && (!Number.isInteger(confirmDueDays) || confirmDueDays < 0)) {
    throw new EscrowError(`확인 기한 일수가 규약을 벗어났습니다: ${confirmDueDays}`);
  }

  return {
    basis: "event_completed",
    confirmDueDays,
    timeoutAction: "release",
    version: RELEASE_CONDITION_VERSION,
  };
}

// =============================================================================
// 화면 문구
// =============================================================================

export const ESCROW_TITLE = "안전거래";

export const ESCROW_EMPTY_TITLE = "맡겨진 금액이 없어요";

export const ESCROW_EMPTY_BODY =
  "잔금을 결제하면 이행이 확인될 때까지 안전거래로 맡겨집니다.";

export const ESCROW_CONFIRM_QUESTION = "서비스가 약속대로 이행됐나요?";

export const ESCROW_CONFIRM_YES = "이행됐어요";

export const ESCROW_CONFIRM_NO = "이행되지 않았어요";

export const ESCROW_DISPUTE_NOTICE =
  "'이행되지 않았어요' 를 고르면 금액은 그대로 맡겨진 채 운영자 조율로 넘어갑니다. 플랫폼이 한쪽 편에서 집행하지 않아요.";

export const ESCROW_STUB_NOTICE =
  "지금은 안전거래가 개발용 대체 수단으로 동작해요. 금액이 실제로 분리 보관되지는 않습니다.";

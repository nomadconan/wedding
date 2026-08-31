/**
 * 플래너 권한 위임 (S6-04 · 명세서 §2.1 F-C-18, §3.7 planner_engagements, §3.9,
 * D-23 · D-43 · D-165 · D-166 · D-167)
 *
 * 프레임워크도 DB 도 모르는 순수 모듈이다.
 *
 * ── 이 파일이 다루는 축 ─────────────────────────────────────────────────────
 * **열람 권한 위임**이다. "이 플래너가 우리 커플의 어떤 **표**를 볼 수 있는가" 이며
 * 판정은 RLS(`has_planner_scope`)가 한다. 과금 축(`planner_scopes` · 카테고리별
 * 이용 여부 · F-C-31)은 **다른 표이고 다른 파일**이다(`scope.ts` · D-43).
 *
 * 한쪽을 끄면 다른 쪽도 꺼진다고 가정하지 않는다 — 그렇게 가정하면 고객은
 * "플래너를 뺐는데 아직 우리 예산을 본다" 를 **나중에** 발견한다. 여기서는 그 사실을
 * 문구로 들고 다니고(`REVOKE_IMPACT`) 화면이 두 경로를 함께 안내한다.
 *
 * ── 범위 어휘를 지어내지 않는다 (D-167) ─────────────────────────────────────
 * 아래 `DELEGATABLE_SCOPES` 는 **RLS 가 실제로 읽는 키**다. 출처는
 * `has_planner_scope(couple_id, '<키>')` 를 부르는 정책이며, `db:rls` 가 이 목록과
 * DB 에서 뽑은 목록이 같은지 매번 대조한다. 여기 없는 키를 화면에 그리면 고객은
 * 위임했다고 믿지만 **아무것도 열리지 않고**, 여기 있는데 화면에 없으면 **정책이
 * 여는 것을 고객이 모른 채** 지나간다. 둘 다 동의가 아니다.
 */

/** 입력이 규약을 벗어날 때 던진다. */
export class DelegationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegationError";
  }
}

// =============================================================================
// 위임할 수 있는 범위 — DB CHECK · RLS 정책과 같아야 한다
// =============================================================================

export type DelegatableScope = {
  /** `scope_json.tables` 에 들어가는 값 그 자체. */
  key: string;
  label: string;
  /** 이 키 하나가 여는 표. **키와 표가 1:1 이 아니다.** */
  opens: readonly string[];
  /** 고객이 "무엇을 보여주는 것인가" 를 묻기 전에 답한다. */
  detail: string;
};

/**
 * 위임 가능한 범위 11종.
 *
 * **`carts` 하나가 `carts`·`cart_items` 를, `quotes` 하나가 `quotes`·`quote_items`
 * 를 연다.** 화면이 "장바구니" 라고만 적으면 담긴 항목까지 보인다는 사실이 가려지므로
 * `opens` 를 함께 들고 다닌다.
 */
export const DELEGATABLE_SCOPES: readonly DelegatableScope[] = [
  {
    key: "couples",
    label: "결혼 준비 기본 정보",
    opens: ["couples"],
    detail: "예식일·지역·예산 총액. 제안을 하려면 이것부터 알아야 해요.",
  },
  {
    key: "tasks",
    label: "준비 체크리스트",
    opens: ["tasks"],
    detail: "무엇이 남았고 언제까지인지. 플래너가 순서를 잡는 근거예요.",
  },
  {
    key: "budgets",
    label: "예산 계획",
    opens: ["budgets"],
    detail: "카테고리별로 잡아 둔 예산. 금액이 그대로 보여요.",
  },
  {
    key: "expenses",
    label: "실제 지출",
    opens: ["expenses"],
    detail: "실제로 쓴 금액과 시점. 예산과 함께 봐야 남은 여유를 알 수 있어요.",
  },
  {
    key: "carts",
    label: "장바구니",
    opens: ["carts", "cart_items"],
    detail: "담아 둔 업체·상품과 그 금액까지 보여요. **담거나 빼지는 못합니다.**",
  },
  {
    key: "wishlists",
    label: "찜 목록",
    opens: ["wishlists"],
    detail: "관심 있게 본 업체·상품.",
  },
  {
    key: "bookings",
    label: "예약·계약 현황",
    opens: ["bookings"],
    detail: "어느 업체와 어디까지 진행됐는지. **결제 내역은 열리지 않아요.**",
  },
  {
    key: "consultations",
    label: "상담·탐방 일정",
    opens: ["consultations"],
    detail: "잡힌 일정과 상태. 이행 확인은 당사자만 합니다.",
  },
  {
    key: "quotes",
    label: "받은 견적",
    opens: ["quotes", "quote_items"],
    detail: "업체가 보낸 견적서와 항목별 금액.",
  },
  {
    key: "guests",
    label: "하객 명단",
    opens: ["guests"],
    detail: "하객 **이름**이 그대로 보여요. 우리 사용자가 아닌 제3자 정보입니다(D-103).",
  },
  {
    key: "seating_plans",
    label: "좌석 배치",
    opens: ["seating_plans"],
    detail: "테이블 배치 초안.",
  },
] as const;

export const DELEGATABLE_SCOPE_KEYS: readonly string[] = DELEGATABLE_SCOPES.map(
  (scope) => scope.key,
);

export function isDelegatableScope(value: string): boolean {
  return DELEGATABLE_SCOPE_KEYS.includes(value);
}

export function scopeLabel(key: string): string {
  return DELEGATABLE_SCOPES.find((scope) => scope.key === key)?.label ?? key;
}

/**
 * 위임해도 열리지 않는 것.
 *
 * **범위 목록에 없는 것을 조용히 빼지 않고 이유와 함께 보인다.** 목록에 없으면
 * 고객은 "아직 안 만든 것" 인지 "일부러 막은 것" 인지 구분할 수 없고, 플래너는
 * "왜 나만 안 보이나" 를 묻는다. 경계를 세운 태스크를 함께 적어 근거를 밝힌다.
 */
export const CLOSED_SCOPES: readonly { label: string; reason: string; origin: string }[] = [
  {
    label: "업체와의 대화",
    reason:
      "대화는 고객과 업체 사이의 것이에요. 위임은 데이터 열람이지 대화 참여가 아닙니다.",
    origin: "S4-01",
  },
  {
    label: "결제·정산 내역",
    reason: "돈이 오간 기록은 위임 대상이 아니에요. 예약 현황까지만 보입니다.",
    origin: "S5-06",
  },
  {
    label: "계약서",
    reason:
      "플래너가 **서명 당사자로 지정된 계약**만 볼 수 있어요. 위임만으로는 열리지 않습니다.",
    origin: "S5-04",
  },
  {
    label: "업로드한 계약서 원문·검토 리포트",
    reason: "원문은 분석 뒤 24시간 안에 파기되며 결과도 올린 사람만 봅니다.",
    origin: "S7-03",
  },
  {
    label: "쿠폰함",
    reason: "받은 쿠폰과 사용 이력은 본인 것이에요.",
    origin: "S5-12",
  },
] as const;

export const VISIBILITY_NOTICE =
  "위임하면 고른 항목을 **읽을 수만** 있어요. 담거나 결제하거나 대화에 들어가지는 못합니다.";

// =============================================================================
// 상태 — 저장하는 값과 계산하는 값을 가른다
// =============================================================================

/**
 * 저장하는 상태.
 *
 * **`expired` 가 없다.** 만료는 `valid_to` 와 지금 시각으로 **계산되는 값**이라
 * 저장하면 배치가 없는 한 영원히 `active` 로 남고, 배치를 만들면 그 배치가 멈춘 동안
 * 만료된 위임이 살아 있게 된다. 계산 가능한 값을 저장하지 않는다.
 */
export const ENGAGEMENT_STATUSES = ["pending", "active", "declined", "revoked"] as const;
export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number];

export function isEngagementStatus(value: string): value is EngagementStatus {
  return (ENGAGEMENT_STATUSES as readonly string[]).includes(value);
}

/** 화면이 실제로 보여주는 국면. 저장된 상태 + 기간으로 **계산한다.** */
export type EngagementPhase =
  /** 커플이 제안했고 플래너의 답을 기다린다. */
  | "awaiting"
  /** 수락됐지만 시작 전이다. */
  | "scheduled"
  /** 지금 열려 있다 — `has_planner_scope` 가 참인 유일한 국면이다. */
  | "effective"
  /** 기간이 지났다. 상태는 여전히 active 지만 아무것도 열리지 않는다. */
  | "expired"
  | "declined"
  | "revoked";

export const PHASE_LABEL: Record<EngagementPhase, string> = {
  awaiting: "수락 대기",
  scheduled: "시작 전",
  effective: "열람 중",
  expired: "기간 종료",
  declined: "거절됨",
  revoked: "해제됨",
};

export const PHASE_DETAIL: Record<EngagementPhase, string> = {
  awaiting: "플래너가 아직 수락하지 않았어요. 수락 전에는 아무것도 열리지 않습니다.",
  scheduled: "수락됐어요. 시작일부터 열립니다.",
  effective: "지금 이 플래너가 고른 항목을 보고 있어요.",
  expired: "기간이 끝나 더는 열리지 않아요. 다시 맡기려면 새로 위임해 주세요.",
  declined: "플래너가 이 제안을 거절했어요.",
  revoked: "위임을 거뒀어요. 이 시점 이후로는 열리지 않습니다.",
};

export type EngagementRow = {
  status: string;
  validFrom: string | null;
  validTo: string | null;
};

/**
 * 지금 이 위임이 어떤 국면인가.
 *
 * **`effective` 판정은 `has_planner_scope`(0005)와 글자 그대로 같아야 한다** —
 * `status='active'` 이고 `valid_from <= now` 이고 `valid_to >= now`. 화면이 DB 보다
 * 너그러우면 "열려 있다" 고 적어 놓고 실제로는 안 보이고, 인색하면 그 반대다.
 * `db:rls` 가 두 판정이 같은 답을 내는지 확인한다.
 */
export function engagementPhase(row: EngagementRow, now: Date): EngagementPhase {
  if (row.status === "declined") return "declined";
  if (row.status === "revoked") return "revoked";
  if (row.status === "pending") return "awaiting";

  if (row.status !== "active") {
    throw new DelegationError(`알 수 없는 위임 상태입니다: ${row.status}`);
  }

  const at = now.getTime();
  const from = row.validFrom === null ? null : Date.parse(row.validFrom);
  const to = row.validTo === null ? null : Date.parse(row.validTo);

  if (from !== null && at < from) return "scheduled";
  if (to !== null && at > to) return "expired";

  return "effective";
}

/** RLS 가 열어 주는 유일한 국면. */
export function isEffective(row: EngagementRow, now: Date): boolean {
  return engagementPhase(row, now) === "effective";
}

/** 지금 실제로 열려 있는 범위 키를 모은다. 만료·대기 위임은 아무것도 내놓지 않는다. */
export function effectiveScopes(
  rows: readonly (EngagementRow & { scopes: readonly string[] })[],
  now: Date,
): string[] {
  const keys = new Set<string>();

  for (const row of rows) {
    if (!isEffective(row, now)) continue;
    for (const key of row.scopes) if (isDelegatableScope(key)) keys.add(key);
  }

  return DELEGATABLE_SCOPE_KEYS.filter((key) => keys.has(key));
}

// =============================================================================
// 전이 — 누가 무엇으로 옮길 수 있는가 (DB 트리거와 같은 표를 본다)
// =============================================================================

export type DelegationActor = "couple" | "planner";

/**
 * 허용 전이를 나열한다. **부정형으로 쓰지 않는다.**
 *
 * 끝난 위임(`declined`·`revoked`)은 되살아나지 않는다 — 다시 맡기려면 새로
 * 제안한다(D-23 이 `planner_scopes` 에서 정한 '재선택은 새 행' 과 같은 규칙).
 */
export const ALLOWED_TRANSITIONS: readonly {
  from: EngagementStatus;
  to: EngagementStatus;
  actor: DelegationActor;
}[] = [
  { from: "pending", to: "active", actor: "planner" },
  { from: "pending", to: "declined", actor: "planner" },
  { from: "pending", to: "revoked", actor: "couple" },
  { from: "active", to: "revoked", actor: "couple" },
] as const;

export function transitionAllowed(
  from: string,
  to: string,
  actor: DelegationActor,
): boolean {
  return ALLOWED_TRANSITIONS.some(
    (rule) => rule.from === from && rule.to === to && rule.actor === actor,
  );
}

// =============================================================================
// 폼 판정 — 범위와 기간
// =============================================================================

export const DELEGATION_ERRORS = [
  "scope_empty",
  "scope_unknown",
  "period_missing",
  "period_order",
  "period_past",
] as const;

export type DelegationErrorCode = (typeof DELEGATION_ERRORS)[number];

export const DELEGATION_MESSAGE: Record<DelegationErrorCode, string> = {
  scope_empty: "무엇을 보여줄지 하나 이상 골라 주세요. 비어 있으면 아무것도 열리지 않아요.",
  scope_unknown: "고를 수 없는 범위가 섞여 있어요. 목록에 있는 것만 위임할 수 있습니다.",
  period_missing: "시작일과 종료일을 모두 정해 주세요.",
  period_order: "종료일이 시작일보다 뒤여야 해요.",
  period_past: "이미 지난 날짜로는 위임할 수 없어요.",
};

export type DelegationForm = {
  scopes: readonly string[];
  validFrom: string;
  validTo: string;
};

export type DelegationValidation =
  | { ok: true }
  | { ok: false; errors: DelegationErrorCode[] };

/**
 * 위임 폼 판정.
 *
 * **막은 이유를 한 번에 모아 돌려준다** — 하나씩 알려 주면 고치고 저장하기를
 * 반복하게 된다(S5-13 이 쿠폰 폼에서 정한 방식과 같다).
 *
 * **기간의 상한을 만들지 않는다.** "최대 몇 개월" 은 운영 파라미터이고 정해진 바가
 * 없다 — 코드가 고르면 그 숫자가 곧 기준처럼 굳는다(§7.4). 대신 **끝은 반드시
 * 있어야 한다**(D-166): 무기한 위임은 고객이 해제를 기억해야만 끝난다.
 */
export function validateDelegation(form: DelegationForm, now: Date): DelegationValidation {
  const errors: DelegationErrorCode[] = [];

  if (form.scopes.length === 0) errors.push("scope_empty");
  else if (form.scopes.some((key) => !isDelegatableScope(key))) errors.push("scope_unknown");

  const from = form.validFrom === "" ? NaN : Date.parse(form.validFrom);
  const to = form.validTo === "" ? NaN : Date.parse(form.validTo);

  if (Number.isNaN(from) || Number.isNaN(to)) {
    errors.push("period_missing");
  } else {
    if (to <= from) errors.push("period_order");
    if (to <= now.getTime()) errors.push("period_past");
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// =============================================================================
// 해제가 무엇을 바꾸는가 — 축이 둘이라는 사실을 문구가 들고 다닌다 (D-43)
// =============================================================================

export type RevokeImpact = {
  /** 열람이 즉시 끊긴다. */
  readingStops: true;
  /** 카테고리 선택(과금)은 **그대로다.** */
  categoriesUnchanged: true;
  /** 이미 성사된 계약의 수수료도 그대로다. */
  settledFeesUnchanged: true;
  notes: string[];
};

/**
 * 위임을 거두면 무엇이 바뀌는가.
 *
 * **카테고리 선택을 함께 끄지 않는다**(D-43). 자동으로 끄면 "왜 카테고리가 혼자
 * 풀렸나" 를 답할 수 없고, 그 해제가 앞으로의 계약 수수료를 바꾸므로 **돈이 걸린
 * 변경을 고객이 누르지 않은 채** 일어난다. 대신 화면이 두 번째 경로를 안내한다.
 */
export function revokeImpact(): RevokeImpact {
  return {
    readingStops: true,
    categoriesUnchanged: true,
    settledFeesUnchanged: true,
    notes: [
      "이 플래너는 더 이상 우리 정보를 볼 수 없어요. 거둔 시점은 기록에 남습니다.",
      "**카테고리별 플래너 이용 설정은 그대로예요.** 수수료가 붙지 않게 하려면 플래너 이용 범위에서 따로 해제해 주세요.",
      "이미 확정된 계약의 수수료는 바뀌지 않아요 — 계약 시점에 정해진 금액입니다.",
    ],
  };
}

export const REVOKE_CONFIRM_TITLE = "이 위임을 거두시겠어요?";

/** 카테고리 선택 화면(F-C-31)으로 넘기는 안내. 두 축을 잇는 유일한 자리다. */
export const CROSS_AXIS_NOTICE =
  "열람 위임과 카테고리별 이용 설정은 서로 다른 설정이에요. 하나를 끈다고 다른 하나가 꺼지지 않습니다.";

// =============================================================================
// 화면 문구
// =============================================================================

export const DELEGATION_TITLE = "플래너 권한 위임";

export const DELEGATION_LIST_TITLE = "위임 관리";

export const DELEGATION_EMPTY_TITLE = "아직 위임한 플래너가 없어요";

export const DELEGATION_EMPTY_BODY =
  "플래너를 찾아 프로필에서 위임을 제안할 수 있어요. 무엇을 보여줄지와 언제까지인지는 직접 고릅니다.";

/**
 * **수락 전에는 아무것도 열리지 않는다**(D-165).
 *
 * 이 문장을 제안 화면에 두는 이유 — 고객이 "제안하면 바로 보이는가" 를 묻지 않고도
 * 알 수 있어야 한다. 제안만으로 열린다고 읽으면, 플래너가 답하지 않는 동안 고객은
 * 이미 공유된 줄 알고 다음 단계를 진행한다.
 */
export const OFFER_PENDING_NOTICE =
  "제안하면 플래너에게 전달돼요. **플래너가 수락해야** 고른 항목이 열리며, 그 전까지는 아무것도 보이지 않습니다.";

export const PLANNER_INBOX_TITLE = "받은 위임";

export const PLANNER_INBOX_EMPTY_TITLE = "받은 위임 제안이 없어요";

export const PLANNER_INBOX_EMPTY_BODY =
  "고객이 프로필에서 위임을 제안하면 여기에 쌓입니다. 수락해야 고객 정보가 열려요.";

/**
 * 플래너 쪽에 붙는 고지.
 *
 * 수락은 **책임이 함께 오는 행위**다 — 열람한 정보에는 하객 이름 같은 제3자 정보가
 * 섞이고(D-103), 계약이 성사되면 서명 당사자가 된다(F-C-15).
 */
export const PLANNER_ACCEPT_NOTICE =
  "수락하면 고객이 고른 항목을 읽을 수 있어요. **범위와 기간은 고객이 정하며 플래너가 넓힐 수 없습니다.** 하객 명단처럼 제3자 정보가 포함될 수 있으니 다른 곳에 옮겨 적지 마세요.";

/** 위임만으로는 수수료가 생기지 않는다는 사실(D-17). 두 축을 헷갈리지 않게 한다. */
export const NO_FEE_FROM_DELEGATION_NOTICE =
  "위임은 열람 권한일 뿐이라 이것만으로는 수수료가 생기지 않아요. 수수료는 카테고리별 이용을 선택하고 **계약이 성사된 뒤**에 발생합니다.";

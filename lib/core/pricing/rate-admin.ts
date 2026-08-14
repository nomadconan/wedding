/**
 * 요율 관리 (S5-03 · 명세서 §2.3 F-A-15, §3.8, §6.4, D-16 · D-23, O-02)
 *
 * 프레임워크도 DB 도 모르는 순수 모듈이다. 요율은 **basis point 정수**로만 다룬다(§6).
 *
 * ── 해석 엔진을 새로 만들지 않는다 ──────────────────────────────────────────
 * "이 시점 이 업체에 어떤 요율이 적용되는가" 는 `rates.ts`(S5-02 `resolveRate`)가 이미
 * 답한다. 이 파일은 그 위에 **관리 화면이 필요로 하는 판정**을 얹는다 — 저장 전 겹침
 * 확인 · 이력 상태 · 변경 영향 고지.
 *
 * ── 값을 정하지 않는다 (O-02) ───────────────────────────────────────────────
 * 요율 **숫자**는 이 파일 어디에도 없다. 여기 있는 것은 "0~10000bp 를 벗어나면 입력
 * 사고" 라는 **스키마 수준 경계**뿐이며, 업무 상한(예: 5~8%)은 운영 결정이다.
 * 화면이 그 범위를 강제하지 않는 이유도 같다 — 강제하면 코드가 O-02 를 앞질러 답한다.
 */

import { RATE_SCOPES, type RateScope } from "../schemas/rates";

/** 입력이 규약을 벗어날 때 던진다. */
export class RateAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateAdminError";
  }
}

const TOTAL_BP = 10_000;

// =============================================================================
// 값 집합 — DB enum 과 같아야 한다
// =============================================================================

/** `commission_scope_type`. 플래너 요율은 `planner` 를 쓴다(§3.8). */
export const COMMISSION_SCOPES = ["global", "category", "vendor"] as const;
export type CommissionScope = (typeof COMMISSION_SCOPES)[number];

export const PLANNER_SCOPES = ["global", "category", "planner"] as const;
export type PlannerScope = (typeof PLANNER_SCOPES)[number];

export const RATE_TYPES = ["commission", "planner"] as const;
export type RateType = (typeof RATE_TYPES)[number];

export const SCOPE_LABEL: Record<RateScope, string> = {
  global: "전역",
  category: "카테고리",
  vendor: "업체",
  planner: "플래너",
};

/**
 * 적용 우선순위 설명.
 *
 * **화면이 이 문장을 그대로 보여준다.** 운영자가 전역 요율을 고쳤는데 특정 업체에
 * 반영되지 않는 이유를 화면이 먼저 말하지 않으면, 그것은 버그 문의가 된다.
 */
export const SCOPE_PRIORITY_NOTICE =
  "좁은 범위가 넓은 범위를 이깁니다. 업체 → 카테고리 → 전역 순으로 찾고, 먼저 걸리는 요율이 적용돼요.";

// =============================================================================
// 이력 상태 — 저장하지 않고 계산한다
// =============================================================================

/**
 * 요율 행의 지금 상태.
 *
 * **저장하지 않는다.** `effective_from`·`effective_to` 와 시계로 나오는 값이며,
 * 컬럼으로 두면 배치가 늦은 만큼 화면이 거짓을 말한다(0027~0033 이 세운 같은 규칙).
 */
export type RateState = "scheduled" | "active" | "ended";

export const RATE_STATE_LABEL: Record<RateState, string> = {
  scheduled: "예정",
  active: "적용 중",
  ended: "종료",
};

export function rateState(input: {
  effectiveFrom: string;
  effectiveTo: string | null;
  now: Date;
}): RateState {
  const from = Date.parse(input.effectiveFrom);
  const at = input.now.getTime();

  if (!Number.isNaN(from) && at < from) return "scheduled";

  if (input.effectiveTo !== null) {
    const to = Date.parse(input.effectiveTo);

    // 구간은 [from, to) 반개구간이다(0006). 종료 시각 그 순간부터 끝난 것으로 본다 —
    // 경계를 열어 두면 같은 순간에 두 요율이 적용 중이 된다.
    if (!Number.isNaN(to) && at >= to) return "ended";
  }

  return "active";
}

// =============================================================================
// 겹침 — DB 가 막지만 화면이 먼저 알려준다
// =============================================================================

export type RateRow = {
  id: string;
  scopeType: RateScope;
  scopeKey: string | null;
  serviceLevel?: string | null;
  feeRateBp: number;
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type OverlapCheck =
  | { ok: true }
  | { ok: false; conflicts: RateRow[]; detail: string };

/**
 * 같은 스코프에 기간이 겹치는 행이 있는가.
 *
 * **DB 의 EXCLUDE 제약이 최종 경계다**(0006). 여기서 또 보는 이유는 **저장 버튼을
 * 누르기 전에** 알려주기 위해서다 — 제약 위반 메시지를 그대로 보여주면 운영자는
 * 어느 행과 부딪혔는지, 무엇을 고쳐야 하는지 알 수 없다.
 *
 * 구간은 **[from, to) 반개구간**이다(0006 과 같은 해석). 한쪽의 끝과 다른 쪽의 시작이
 * 같으면 **겹치지 않는다** — 그 순간에 적용되는 요율이 하나여야 하기 때문이다.
 */
export function findOverlaps(input: {
  candidate: Omit<RateRow, "id"> & { id?: string };
  existing: readonly RateRow[];
}): OverlapCheck {
  const { candidate } = input;
  const from = Date.parse(candidate.effectiveFrom);

  if (Number.isNaN(from)) {
    throw new RateAdminError(`시작 시각을 읽을 수 없습니다: ${candidate.effectiveFrom}`);
  }

  const to = candidate.effectiveTo === null ? Infinity : Date.parse(candidate.effectiveTo);

  if (Number.isNaN(to)) {
    throw new RateAdminError(`종료 시각을 읽을 수 없습니다: ${candidate.effectiveTo}`);
  }

  if (to <= from) {
    throw new RateAdminError("종료 시각은 시작 시각보다 뒤여야 합니다.");
  }

  const conflicts = input.existing.filter((row) => {
    // 자기 자신은 겹침이 아니다(수정할 때).
    if (candidate.id !== undefined && row.id === candidate.id) return false;
    if (row.scopeType !== candidate.scopeType) return false;
    if ((row.scopeKey ?? "") !== (candidate.scopeKey ?? "")) return false;

    const rowFrom = Date.parse(row.effectiveFrom);
    const rowTo = row.effectiveTo === null ? Infinity : Date.parse(row.effectiveTo);

    return rowFrom < to && from < rowTo;
  });

  if (conflicts.length === 0) return { ok: true };

  return {
    ok: false,
    conflicts,
    detail: `같은 범위에 기간이 겹치는 요율이 ${conflicts.length}건 있어요. 기존 요율을 먼저 종료하거나 시작일을 옮겨 주세요.`,
  };
}

// =============================================================================
// 입력 검증 — 스키마 경계까지만, 업무 상한은 운영 결정이다
// =============================================================================

export type RateDraft = {
  type: RateType;
  scopeType: RateScope;
  scopeKey: string | null;
  serviceLevel?: string | null;
  feeRateBp: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  memo?: string | null;
};

export type RateValidation = { ok: true } | { ok: false; field: string; detail: string };

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * 저장 전 검증.
 *
 * **업무 상한을 두지 않는다**(O-02). 여기서 보는 것은 0~10000bp 라는 **스키마 수준
 * 경계**뿐이다 — "수수료는 5~8%" 같은 범위를 코드가 강제하면 **미결정이 조용히
 * 확정된다**(D-03 이 금지한 것은 광고이지만, 값을 코드가 정하지 않는다는 원칙은
 * `feeBasisOf`·`resolveSplitPlans` 가 이미 세웠다).
 *
 * 대신 **입력 사고**는 막는다: 스코프와 키의 짝, uuid 형식, 기간 순서, bp 정수.
 */
export function validateRate(draft: RateDraft): RateValidation {
  const allowed: readonly string[] =
    draft.type === "commission" ? COMMISSION_SCOPES : PLANNER_SCOPES;

  if (!allowed.includes(draft.scopeType)) {
    return {
      ok: false,
      field: "scopeType",
      detail: `${draft.type === "commission" ? "업체" : "플래너"} 요율에 쓸 수 없는 범위예요: ${draft.scopeType}`,
    };
  }

  if (draft.scopeType === "global") {
    if (draft.scopeKey !== null) {
      return { ok: false, field: "scopeKey", detail: "전역 요율에는 대상을 지정하지 않습니다." };
    }
  } else if (draft.scopeKey === null || draft.scopeKey.trim() === "") {
    return { ok: false, field: "scopeKey", detail: "적용 대상을 지정해 주세요." };
  }

  // uuid 스코프의 키 형식. DB CHECK 와 같은 규칙이며 여기서 먼저 걸러 준다.
  if (
    (draft.scopeType === "vendor" || draft.scopeType === "planner") &&
    !UUID.test(draft.scopeKey ?? "")
  ) {
    return { ok: false, field: "scopeKey", detail: "대상 식별자 형식이 올바르지 않습니다." };
  }

  if (!Number.isInteger(draft.feeRateBp) || draft.feeRateBp < 0 || draft.feeRateBp > TOTAL_BP) {
    return {
      ok: false,
      field: "feeRateBp",
      detail: "요율은 0~10000 사이의 정수(bp)여야 합니다. 1% = 100bp 입니다.",
    };
  }

  const from = Date.parse(draft.effectiveFrom);

  if (Number.isNaN(from)) {
    return { ok: false, field: "effectiveFrom", detail: "시작 시각을 읽을 수 없습니다." };
  }

  if (draft.effectiveTo !== null) {
    const to = Date.parse(draft.effectiveTo);

    if (Number.isNaN(to) || to <= from) {
      return { ok: false, field: "effectiveTo", detail: "종료 시각은 시작 시각보다 뒤여야 합니다." };
    }
  }

  return { ok: true };
}

/** bp → 사람이 읽는 퍼센트. 소수 둘째 자리까지이며 **표시 전용**이다. */
export function formatRateBp(feeRateBp: number): string {
  if (!Number.isInteger(feeRateBp)) {
    throw new RateAdminError(`요율은 bp 정수여야 합니다: ${feeRateBp}`);
  }

  return `${(feeRateBp / 100).toFixed(2)}%`;
}

// =============================================================================
// 종료 — 지우지 않고 닫는다 (D-23)
// =============================================================================

export type EndRateDecision =
  | { ok: true; effectiveTo: string }
  | { ok: false; reason: "already_ended" | "before_start"; detail: string };

/**
 * 요율을 끝낸다.
 *
 * **행을 지우지 않는다.** 과거 계약의 요율은 스냅샷으로 박혀 있지만(D-16), **"그때
 * 어떤 요율표가 있었나" 를 재현하는 근거**는 이 표다. 지우면 정산 분쟁에서 "이 요율이
 * 어디서 나왔나" 를 답할 수 없다(D-23). 그래서 종료는 `effective_to` 를 닫는 것이고,
 * DB 는 DELETE 권한 자체를 회수해 뒀다(0034).
 *
 * **시작 전으로 닫을 수 없다.** 그러면 구간이 음수가 되고, 그런 행은 "존재한 적 없는
 * 요율" 이 되어 이력의 뜻이 사라진다.
 */
export function endRate(input: {
  effectiveFrom: string;
  effectiveTo: string | null;
  endAt: string;
}): EndRateDecision {
  if (input.effectiveTo !== null) {
    return {
      ok: false,
      reason: "already_ended",
      detail: "이미 종료 시각이 정해진 요율이에요.",
    };
  }

  const from = Date.parse(input.effectiveFrom);
  const end = Date.parse(input.endAt);

  if (Number.isNaN(end)) throw new RateAdminError(`종료 시각을 읽을 수 없습니다: ${input.endAt}`);

  if (end <= from) {
    return {
      ok: false,
      reason: "before_start",
      detail: "시작 시각보다 앞선 시점으로 종료할 수 없어요. 잘못 만든 행이면 다른 요율로 덮어 주세요.",
    };
  }

  return { ok: true, effectiveTo: input.endAt };
}

// =============================================================================
// 변경 영향 — 소급되지 않는다 (D-16)
// =============================================================================

/**
 * **요율 변경은 기존 계약에 소급되지 않는다.**
 *
 * `bookings.applied_fee_rate_bp` 는 계약 확정 시점 스냅샷이고 불변 트리거가 지킨다
 * (0028). 정산도 그 스냅샷을 집계하지 정산 시점 요율로 재계산하지 않는다(0033).
 *
 * 화면이 이 문장을 **저장 버튼 옆에** 두는 이유 — 운영자가 "요율을 내렸으니 지난
 * 정산도 줄겠지" 라고 기대하면, 그 기대가 어긋났을 때 장애로 신고된다.
 */
export const NO_RETROACTIVE_NOTICE =
  "요율 변경은 이미 확정된 계약에 소급되지 않습니다. 지난 거래는 계약 시점에 박힌 요율로 정산돼요.";

/**
 * 요율이 하나도 없을 때의 안내.
 *
 * **이것이 F-A-15 의 존재 이유다**(§부록 — "개발 블로커 해제 장치"). 값이 없으면
 * 계약 발행이 막히고(S5-06 `CONTRACT_RATE_UNRESOLVED`) 거래 흐름 전체가 서지 않는다.
 * 그 사실을 화면이 **경고가 아니라 안내**로 적는다 — 고장이 아니라 아직 안 넣은 값이다
 * (S5-07 이 정산 '설정 대기' 에서 세운 것과 같은 표현 규칙).
 */
export const NO_RATE_TITLE = "적용할 요율이 없어요";

export const NO_RATE_BODY =
  "요율이 하나도 없으면 계약을 발행할 수 없어요. 값이 아직 정해지지 않았다면 임시 요율을 넣고 나중에 새 요율로 바꿀 수 있습니다 — 지난 계약에는 소급되지 않아요.";

export const RATE_VALUE_UNDECIDED_NOTICE =
  "수수료 요율 값은 아직 확정되지 않았습니다(O-02). 이 화면이 그 값을 넣는 자리이며, 코드나 명세에 요율을 박아 두지 않았습니다.";

// =============================================================================
// 시뮬레이터 — "이 시점 이 업체에 무엇이 적용되나"
// =============================================================================

export type SimulationInput = {
  type: RateType;
  vendorId?: string | null;
  plannerId?: string | null;
  category?: string | null;
  at: string;
  serviceLevel?: string | null;
};

/**
 * 시뮬레이터 조회에 쓸 스코프 후보를 만든다.
 *
 * **`resolveRate` 가 요구하는 형태로 옮기기만 한다** — 우선순위 자체는 S5-02 가 갖고
 * (`COMMISSION_SCOPE_ORDER`·`PLANNER_FEE_SCOPE_ORDER`) 여기서 다시 정하지 않는다.
 * 두 곳에서 순서를 정하면 언젠가 화면과 정산이 다른 요율을 말한다.
 */
export function simulationScopeKeys(input: SimulationInput): Record<string, string> {
  const keys: Record<string, string> = {};

  if (input.type === "commission") {
    if (input.vendorId) keys.vendor = input.vendorId;
  } else if (input.plannerId) {
    keys.planner = input.plannerId;
  }

  if (input.category) keys.category = input.category;

  return keys;
}

export const SIMULATION_EMPTY_NOTICE =
  "이 조건에 적용되는 요율이 없어요. 이 상태로는 계약을 발행할 수 없습니다.";

/** 스코프 목록이 값 집합과 어긋나지 않는지 확인하는 용도. `db:rls` 가 함께 본다. */
export const ALL_RATE_SCOPES: readonly RateScope[] = RATE_SCOPES;

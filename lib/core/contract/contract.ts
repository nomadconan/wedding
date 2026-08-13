/**
 * 표준계약 템플릿 · 3자 서명 (S5-04 · S5-05 · 명세서 §2.1 F-C-15, §3.4, §7.7,
 * D-21 · D-23 · D-24 · D-28)
 *
 * 프레임워크도 DB 도 모르는 순수 모듈이다.
 *
 * **여기 없는 것 셋.**
 *  1. **조항 문안.** O-03 법무 검수 전까지 확정하지 않는다(§7.7). 이 파일이 담는 것은
 *     **슬롯 구조**(코드·제목·순서·근거 출처)이며 본문은 없다. 아래 `assertNoClauseNumbers`
 *     와 vitest 가 조항 번호가 들어오는 것을 막는다 — T-04 가 `detect_rules.basis_ref` 에
 *     걸어 둔 가드와 같은 방식이고, DB 도 같은 정규식으로 한 번 더 본다(0029).
 *  2. **금액·요율·기한 값.** 요율은 `commission_rates`·`planner_fee_rates`(S5-02)가,
 *     서명 기한은 `app_settings.contract.signing_deadline_days` 가 갖는다.
 *  3. **위약금 산정.** `lib/core/pricing/penalty.ts`(T-04)가 이미 갖고 있다. 새로 만들지
 *     않으며, 계약 취소의 금전 처리는 S5-08 의 일이다.
 */

/** 계약 상태. **'서명 중' 이 없다** — 몇 명이 서명했는지는 서명 행을 세는 계산값이다. */
export const CONTRACT_STATUSES = ["draft", "issued", "active", "cancelled"] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const CONTRACT_STATUS_LABEL: Record<ContractStatus, string> = {
  draft: "발행 전",
  issued: "서명 대기",
  active: "계약 확정",
  cancelled: "취소됨",
};

/** 서명 당사자 역할(D-21). 커플·업체는 항상, 플래너는 선택 시 추가된다. */
export const SIGNER_ROLES = ["couple", "vendor", "planner"] as const;
export type SignerRole = (typeof SIGNER_ROLES)[number];

export const SIGNER_ROLE_LABEL: Record<SignerRole, string> = {
  couple: "고객",
  vendor: "업체",
  planner: "플래너",
};

/** 본인확인 수단. 스텁 여부가 증적에 남는다(D-28). */
export const VERIFICATION_METHODS = ["sms", "sms_stub"] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

// =============================================================================
// 당사자 — 커플은 소유자 한 명이 서명한다
// =============================================================================

/**
 * 이 계약이 요구하는 서명 역할.
 *
 * **커플이 두 명인데 서명은 한 번이다.** §1.4 가 "결제·계약 서명 권한은 소유자와 분리"
 * 라고 적었고 RLS 도 `is_couple_owner` 로 쓰여 있다(0005). 배우자에게도 서명을 요구하면
 * 한쪽이 자리에 없을 때 계약이 멈추고 그 지연의 책임이 업체·플랫폼으로 넘어온다.
 * 대신 **계약서 본문에는 커플 양측을 당사자로 적는다** — 서명 주체와 계약 당사자는
 * 다른 층위다.
 */
export function requiredSignerRoles(input: { plannerParty: boolean }): SignerRole[] {
  return input.plannerParty ? ["couple", "vendor", "planner"] : ["couple", "vendor"];
}

export const COUPLE_SIGNER_NOTICE =
  "계약 서명은 커플 대표 계정이 합니다. 배우자도 계약 내용을 볼 수 있어요.";

// =============================================================================
// 서명 진행
// =============================================================================

export type SignatureRow = { signerRole: SignerRole; signedAt: string | null };

export type SigningProgress = {
  required: SignerRole[];
  signed: SignerRole[];
  pending: SignerRole[];
  complete: boolean;
};

export function signingProgress(
  signatures: readonly SignatureRow[],
  required: readonly SignerRole[],
): SigningProgress {
  const signed = required.filter((role) =>
    signatures.some((row) => row.signerRole === role && row.signedAt !== null),
  );
  const pending = required.filter((role) => !signed.includes(role));

  return {
    required: [...required],
    signed,
    pending,
    complete: pending.length === 0 && required.length > 0,
  };
}

/**
 * 계약의 지금 상태.
 *
 * **기한 경과를 저장하지 않는다.** `signing_deadline_at` 과 시계로 계산되는 값이고,
 * 저장하면 배치가 늦은 만큼 화면이 거짓을 말한다(IDEA-01 · S5-01 에서 세운 규칙).
 */
export type SigningState = "draft" | "awaiting" | "expired" | "active" | "cancelled";

export function signingState(input: {
  status: ContractStatus;
  deadlineAt: string | null;
  complete: boolean;
  now: Date;
}): SigningState {
  if (input.status === "cancelled") return "cancelled";
  if (input.status === "active") return "active";
  if (input.status === "draft") return "draft";

  if (input.complete) return "awaiting"; // 전원 서명했으나 아직 확정 처리 전
  if (input.deadlineAt === null) return "awaiting";

  const deadline = Date.parse(input.deadlineAt);

  if (Number.isNaN(deadline)) return "awaiting";

  // 기한 당일 그 시각이 되면 지난 것으로 본다 — 옛 조건으로 계약이 성립하는 쪽이 더 나쁘다.
  return input.now.getTime() >= deadline ? "expired" : "awaiting";
}

export const SIGNING_STATE_LABEL: Record<SigningState, string> = {
  draft: "아직 발행되지 않았어요",
  awaiting: "서명을 기다리고 있어요",
  expired: "서명 기한이 지났어요",
  active: "계약이 확정됐어요",
  cancelled: "취소된 계약이에요",
};

/** 서명을 받을 수 있는가. 기한이 지나면 받지 않는다. */
export function canSign(state: SigningState): state is "awaiting" {
  return state === "awaiting";
}

/**
 * 조항을 고칠 수 있는가.
 *
 * **서명이 하나라도 있으면 못 고친다**(D-23). 발행 전(`draft`)에는 자유롭게 고치고,
 * 발행 후에도 아직 아무도 서명하지 않았다면 고칠 수 있다 — 그때는 되돌릴 수 있는
 * 상태이고, 서명이 붙는 순간 "무엇에 서명했는가" 가 고정된다. DB 트리거가 같은 판정을
 * 한 번 더 한다(0029 `assert_contract_immutable`).
 */
export function canEditClauses(input: { status: ContractStatus; signedCount: number }): boolean {
  if (input.status === "cancelled" || input.status === "active") return false;

  return input.signedCount === 0;
}

export const CLAUSE_LOCKED_NOTICE =
  "이미 서명이 시작돼 계약 내용을 바꿀 수 없어요. 바꿔야 한다면 이 계약을 취소하고 다시 발행해야 합니다.";

// =============================================================================
// 조항 슬롯 — 구조만, 문안은 없다 (§7.7)
// =============================================================================

export type ClauseSlot = {
  code: string;
  order: number;
  title: string;
  /** 근거 **출처 수준**만. 조항 번호를 적지 않는다. */
  basisNote: string;
  /** 법무 검수 후에만 채워진다. 미확정 동안 `undefined` 다. */
  body?: string;
};

/**
 * 문안 미확정 기본 판본의 슬롯.
 *
 * **DB 시드(0029)와 같은 목록이어야 한다.** 화면은 DB 의 템플릿을 읽어 그리고, 이 상수는
 * 목록이 어긋났을 때 알아채기 위한 대조본이다(`db:rls` 가 두 목록을 견준다).
 */
export const PLACEHOLDER_TEMPLATE_VERSION = "v0-placeholder";

export const PLACEHOLDER_CLAUSE_SLOTS: readonly ClauseSlot[] = [
  { code: "parties", order: 1, title: "계약 당사자", basisNote: "표준약관" },
  { code: "scope", order: 2, title: "계약 대상과 범위", basisNote: "표준약관" },
  { code: "amount", order: 3, title: "총액과 포함 항목", basisNote: "표준약관" },
  { code: "payment", order: 4, title: "결제 회차와 기한", basisNote: "표준약관" },
  { code: "change", order: 5, title: "변경과 추가금", basisNote: "표준약관" },
  { code: "cancel", order: 6, title: "취소와 위약", basisNote: "소비자분쟁해결기준" },
  { code: "dispute", order: 7, title: "분쟁 처리", basisNote: "소비자분쟁해결기준" },
  { code: "privacy", order: 8, title: "개인정보 처리", basisNote: "개인정보보호법(출처 수준)" },
  { code: "etc", order: 9, title: "그 밖의 약정", basisNote: "표준약관" },
];

/**
 * 조항 번호 표기. **법무 검수 전에는 어디에도 나올 수 없다.**
 *
 * T-04 가 `detect_rules.basis_ref` 에 같은 가드를 걸었고(`제N조`·`N항`), 여기서는
 * 영문 표기까지 함께 본다. DB 도 같은 정규식으로 CHECK 를 걸어 두었다(0029) — 층이
 * 둘이어야 하는 이유는, 한쪽만 있으면 다른 경로로 들어오기 때문이다.
 */
const CLAUSE_NUMBER_PATTERNS = [/제\s*\d+\s*조/, /\d+\s*항/, /article\s*\d+/i] as const;

export function hasClauseNumber(text: string): boolean {
  return CLAUSE_NUMBER_PATTERNS.some((pattern) => pattern.test(text));
}

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

/** 조항 번호가 섞이면 던진다. 호출부는 저장 전에 부른다. */
export function assertNoClauseNumbers(slots: readonly ClauseSlot[]): void {
  for (const slot of slots) {
    for (const value of [slot.title, slot.basisNote, slot.body ?? ""]) {
      if (hasClauseNumber(value)) {
        throw new ContractError(
          `조항 번호를 임의로 부여할 수 없습니다(§7.7 · O-03 대기): ${slot.code} — ${value}`,
        );
      }
    }
  }
}

/** 문안 미확정 판본인가. 화면이 라벨을 붙이는 조건이다. */
export function isPlaceholderTemplate(input: { clauseBodyStatus: string }): boolean {
  return input.clauseBodyStatus !== "reviewed";
}

export const PLACEHOLDER_CLAUSE_NOTICE =
  "조항 문안은 법무 검수 전이라 아직 비어 있어요. 지금 보이는 것은 계약서의 **구조와 근거 출처**이며, 검수가 끝나면 같은 자리에 문안이 들어옵니다.";

export const PLACEHOLDER_SLOT_TEXT = "문안 미확정";

// =============================================================================
// 정본 — 서명 시점 내용을 고정한다 (D-23)
// =============================================================================

export type ContractContent = {
  templateVersion: string;
  clauses: readonly ClauseSlot[];
  totalAmount: number;
  appliedFeeRateBp: number;
  appliedPlannerFeeRateBp: number;
  installments: readonly { seq: number; amount: number; ratioBp: number }[];
  parties: {
    coupleId: string;
    vendorId: string;
    plannerId: string | null;
  };
};

/**
 * 정본 문자열.
 *
 * **해시는 이 문자열에서 나온다.** 서명자가 무엇에 서명했는지를 나중에 증명하려면
 * 같은 입력에서 항상 같은 문자열이 나와야 하므로, 키 순서를 코드가 정하고 배열을
 * 순번으로 정렬한다 — `JSON.stringify` 를 그대로 쓰면 키 순서가 입력에 따라 달라진다.
 *
 * 해시 계산 자체는 이 파일에 두지 않는다. `node:crypto` 를 `lib/core` 에 넣으면
 * Expo 로 옮길 때 걸린다(CLAUDE.md §3.1 — 프레임워크·런타임 무관 원칙).
 * 서버가 `lib/contract/hash.ts` 에서 이 문자열을 해시한다.
 */
export function canonicalContent(content: ContractContent): string {
  const clauses = [...content.clauses]
    .sort((a, b) => a.order - b.order || a.code.localeCompare(b.code))
    .map((slot) => [slot.code, slot.order, slot.title, slot.basisNote, slot.body ?? ""].join(""));

  const installments = [...content.installments]
    .sort((a, b) => a.seq - b.seq)
    .map((item) => [item.seq, item.ratioBp, item.amount].join(":"));

  return [
    `template=${content.templateVersion}`,
    `couple=${content.parties.coupleId}`,
    `vendor=${content.parties.vendorId}`,
    `planner=${content.parties.plannerId ?? "-"}`,
    `total=${content.totalAmount}`,
    `fee=${content.appliedFeeRateBp}`,
    `plannerFee=${content.appliedPlannerFeeRateBp}`,
    `installments=${installments.join(",")}`,
    `clauses=${clauses.join("")}`,
  ].join("\n");
}

export const CONTENT_HASH_NOTICE =
  "서명하면 지금 보이는 내용이 그대로 고정돼요. 이후 조항·금액이 바뀌면 새 계약을 발행해야 합니다.";

// =============================================================================
// 견적 → 계약
// =============================================================================

export type QuoteEligibility =
  | { ok: true }
  | { ok: false; reason: "not_accepted" | "expired" | "already_contracted"; detail: string };

/**
 * 이 견적으로 계약을 발행할 수 있는가.
 *
 * **만료된 견적으로는 발행하지 않는다.** 견적의 `valid_until` 은 "이 금액을 이때까지
 * 보장한다" 는 업체의 약속이고, 지난 뒤에 그 금액으로 계약을 만들면 업체가 동의하지
 * 않은 조건이 된다. 업체가 다시 보내면 된다 — 재발행은 값이 싸고, 잘못된 금액의 계약은
 * 비싸다.
 *
 * **수락된 견적만** 계약이 된다(`accepted`). 고객이 아직 고르지 않은 견적으로 계약을
 * 발행하면 업체가 계약을 밀어붙이는 통로가 된다.
 */
export function quoteEligibility(input: {
  status: string;
  validUntil: string | null;
  now: Date;
  hasActiveContract: boolean;
}): QuoteEligibility {
  if (input.hasActiveContract) {
    return {
      ok: false,
      reason: "already_contracted",
      detail: "이 예약에는 이미 유효한 계약이 있습니다. 계약은 예약당 하나입니다(D-21).",
    };
  }

  if (input.status !== "accepted") {
    return {
      ok: false,
      reason: "not_accepted",
      detail: "고객이 수락한 견적만 계약으로 발행할 수 있습니다.",
    };
  }

  if (input.validUntil !== null) {
    const until = Date.parse(input.validUntil);

    if (!Number.isNaN(until) && input.now.getTime() >= until) {
      return {
        ok: false,
        reason: "expired",
        detail: "유효기간이 지난 견적입니다. 업체가 견적을 다시 보내야 합니다.",
      };
    }
  }

  return { ok: true };
}

export const QUOTE_EXPIRED_NOTICE =
  "이 견적은 유효기간이 지났어요. 금액을 다시 확인받아야 계약을 발행할 수 있습니다.";

/**
 * 계약 총액.
 *
 * **견적 총액을 그대로 쓴다.** 항목을 다시 더하지 않는다 — 견적은 이미 항목 합이
 * 총액과 맞도록 DB 가 강제하고 있고(S4-12 의 cap·참조 CHECK), 여기서 다시 더하면
 * 두 진실이 생긴다. 항목은 계약서에 **그대로 옮겨 적히는 내용**이지 계산 입력이 아니다.
 */
export function contractTotalFromQuote(quote: { totalAmount: number }): number {
  if (!Number.isInteger(quote.totalAmount) || quote.totalAmount < 0) {
    throw new ContractError(`견적 총액이 규약을 벗어났습니다: ${quote.totalAmount}`);
  }

  return quote.totalAmount;
}

// =============================================================================
// 화면 문구 (D-24)
// =============================================================================

/** 플랫폼은 계약 당사자가 아니다. 계약 화면은 그 사실을 숨기지 않는다. */
export const CONTRACT_BROKER_NOTICE =
  "웨딩클리어는 통신판매중개자이며 이 계약의 당사자가 아닙니다. 계약은 고객과 업체 사이에 맺어지고, 플랫폼은 계약서 보관과 분쟁 조율을 맡습니다.";

export const CONTRACT_EMPTY_TITLE = "아직 발행된 계약이 없어요";

export const SIGN_VERIFICATION_NOTICE =
  "서명 전에 본인확인을 거칩니다. 확인 결과와 서명 시각이 증적으로 남아요.";

export const STUB_VERIFICATION_NOTICE =
  "지금은 본인확인이 개발용 대체 수단으로 동작해요. 실제 서비스에서는 문자 인증을 거칩니다.";

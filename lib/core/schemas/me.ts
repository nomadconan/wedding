import { z } from "zod";

import { notYet, type MetricValue } from "../stats/metric";

/**
 * 마이페이지 · 개인정보 (S3-09 · 명세서 §2.1 F-C-23, §4.2, §6.2 `/me`, §7.3)
 *
 * 프레임워크를 모르는 순수 모듈이다.
 *
 * **여기서 다루는 값은 대부분 되돌릴 수 없다.** 삭제 요청·연동 해제·동의 철회는
 * 누르고 나서 "그런 뜻이 아니었다" 가 통하지 않는다. 그래서 이 파일은 각 행동이
 * **무엇을 없애고 무엇을 남기는지**를 문구가 아니라 값으로 갖는다.
 */

// =============================================================================
// 계정·데이터 삭제 요청
// =============================================================================

/**
 * 삭제 범위.
 *
 * 명세가 값을 못박지 않았으므로 text + CHECK 다(0001 원칙). 둘로 나누는 이유는
 * **계정을 지우는 것과 준비 기록을 지우는 것이 다른 요구**이기 때문이다 —
 * 결혼 준비가 끝나 기록만 지우고 싶은 사람과 서비스를 떠나는 사람은 다르다.
 */
export const DELETION_SCOPES = ["account", "service_data"] as const;

export type DeletionScope = (typeof DELETION_SCOPES)[number];

export const DELETION_SCOPE_LABEL: Record<DeletionScope, string> = {
  account: "계정과 모든 데이터",
  service_data: "준비 기록만 (계정은 유지)",
};

export const DELETION_SCOPE_NOTE: Record<DeletionScope, string> = {
  account: "로그인 정보까지 지웁니다. 같은 이메일로 다시 가입할 수 있어요.",
  service_data: "장바구니·찜·온보딩 답변을 지우고 로그인은 그대로 둡니다.",
};

/**
 * 처리 상태.
 *
 * `pending` 접수 · `in_progress` 처리 중 · `completed` 완료 · `rejected` 반려 ·
 * `cancelled` 사용자가 거둠.
 */
export const DELETION_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "rejected",
  "cancelled",
] as const;

export type DeletionStatus = (typeof DELETION_STATUSES)[number];

export const DELETION_STATUS_LABEL: Record<DeletionStatus, string> = {
  pending: "접수됨",
  in_progress: "처리 중",
  completed: "처리 완료",
  rejected: "반려됨",
  cancelled: "요청을 거뒀어요",
};

/** 아직 끝나지 않은 요청. 이 상태에서 새 요청을 또 받지 않는다. */
export function isOpenRequest(status: DeletionStatus): boolean {
  return status === "pending" || status === "in_progress";
}

/**
 * **거둘 수 있는가.**
 *
 * `pending` 일 때만 허용한다. 처리가 시작되면 이미 지워진 데이터가 있을 수 있고,
 * 그때의 '취소' 는 지킬 수 없는 약속이 된다. 삭제는 되돌릴 수 없는 행위이므로
 * 되돌릴 수 있는 구간과 없는 구간을 **상태로 갈라 둔다** — 화면 문구가 아니라 값이다.
 *
 * 접수만 하고 SLA 동안 기다리는 구조라 이 구간은 자연히 존재한다.
 */
export function canCancelRequest(status: DeletionStatus): boolean {
  return status === "pending";
}

export const DELETION_CANCEL_BLOCKED_NOTE =
  "처리가 시작된 요청은 거둘 수 없어요. 이미 지워진 정보가 있을 수 있습니다.";

/**
 * **바로 지울 수 없는 것.**
 *
 * 계약·결제·정산 기록은 관계 법령이 정한 기간 동안 보존해야 한다. 그 사실을 감추면
 * "다 지웠다" 고 알린 뒤 기록이 남아 있는 상태가 되고, 그건 고지 위반이자 신뢰 문제다.
 *
 * **보존 기간을 숫자로 쓰지 않는다.** 구체 연수는 법무 검수(O-03) 전에 확정할 수 없고,
 * 틀린 숫자를 고지하는 것이 안 쓰는 것보다 나쁘다. 무엇이 남는지 **항목**으로만 밝힌다.
 */
export const DELETION_RETAINED_ITEMS = [
  { key: "contract", label: "계약 기록", reason: "거래 당사자 사이의 계약 증빙이라 남습니다." },
  { key: "payment", label: "결제·환불 기록", reason: "대금 결제와 환불 증빙이라 남습니다." },
  { key: "settlement", label: "정산 기록", reason: "업체 정산 내역이라 남습니다." },
  {
    key: "audit",
    label: "처리 이력",
    reason: "삭제 요청을 언제 접수하고 처리했는지의 기록이라 남습니다.",
  },
] as const;

export const DELETION_RETAINED_NOTICE =
  "아래 기록은 관계 법령에서 정한 기간 동안 보관해야 해서 바로 지울 수 없어요. 그 기간이 지나면 함께 파기됩니다.";

export const DeletionRequestSchema = z.object({
  scope: z.enum(DELETION_SCOPES),
  /** 무엇이 남는지 확인했다는 표시. 확인 없이 접수하지 않는다. */
  acknowledgedRetention: z.literal(true, {
    errorMap: () => ({ message: "남는 기록을 확인해 주세요." }),
  }),
  reason: z.string().trim().max(500).nullable().default(null),
});

export type DeletionRequestInput = z.input<typeof DeletionRequestSchema>;

// =============================================================================
// 프로필
// =============================================================================

/**
 * 연락처는 **해시로만** 저장한다(§7.2·§7.3). 그래서 화면에 되돌려 보여줄 수 없다 —
 * 마스킹조차 원문이 있어야 만들 수 있기 때문이다. 등록 여부만 말한다.
 */
export type PhoneState = { kind: "registered" } | { kind: "none" };

export const PHONE_STATE_TEXT: Record<PhoneState["kind"], string> = {
  registered: "등록됨 (보안을 위해 저장된 번호는 보여드리지 않아요)",
  none: "등록되지 않음",
};

export const ProfileUpdateSchema = z.object({
  displayName: z.string().trim().min(1, "이름을 입력해 주세요.").max(40),
  /**
   * 새 연락처. 넘기면 해시해서 바꾸고, `null` 이면 그대로 둔다.
   * **지우려면 빈 문자열이 아니라 `remove: true`** 다 — 빈 문자열은 "안 넘김" 과
   * 구별되지 않아 실수로 지워질 수 있다.
   */
  phone: z.string().trim().min(9).max(20).nullable().default(null),
  removePhone: z.boolean().default(false),
  marketingOptIn: z.boolean(),
});

export type ProfileUpdateInput = z.input<typeof ProfileUpdateSchema>;

// =============================================================================
// 동의
// =============================================================================

/**
 * 철회할 수 있는 동의와 그렇지 않은 것.
 *
 * 서비스 이용의 전제인 동의(약관·개인정보 처리)는 철회하면 서비스를 쓸 수 없게 되므로
 * **철회 버튼이 아니라 탈퇴(삭제 요청)** 로 이어져야 한다. 그 둘을 같은 버튼으로 두면
 * 사용자가 무엇을 하는지 모른 채 계정을 잃는다.
 */
export const WITHDRAWABLE_CONSENT_TYPES = ["marketing"] as const;

export function isWithdrawable(consentType: string): boolean {
  return (WITHDRAWABLE_CONSENT_TYPES as readonly string[]).includes(consentType);
}

export const CONSENT_TYPE_LABEL: Record<string, string> = {
  terms: "이용약관",
  privacy: "개인정보 처리방침",
  marketing: "마케팅 정보 수신",
  document_ai: "계약서 AI 분석·파기 정책",
};

export const CONSENT_REQUIRED_NOTE =
  "서비스 이용에 필요한 동의라 따로 철회할 수 없어요. 그만 쓰시려면 아래에서 삭제를 요청해 주세요.";

// =============================================================================
// 커플 연동 해제
// =============================================================================

/**
 * **나가는 사람의 멤버 행만 지운다.** 장바구니·찜은 지우지 않는다.
 *
 * 그 데이터는 `couple_id` 에 매달린 **커플의 것**이지 개인의 것이 아니다. 나가는
 * 사람이 지우면 남는 사람의 준비 기록이 함께 사라진다. 복사해 나누는 것도 답이
 * 아니다 — `added_by` 가 두 벌이 되어 "누가 담았는가" 의 기록이 어긋나고, 상대의
 * 동의 없이 데이터를 복제하는 셈이 된다.
 *
 * 자기 데이터를 없애고 싶으면 **삭제 요청**이라는 별도 경로가 있다. 두 행동은
 * 뜻이 다르므로 버튼도 따로 둔다.
 */
export type UnlinkBlocker = { code: string; message: string };

/**
 * **소유자는 나갈 수 없다.**
 *
 * 커플 데이터의 소유자(`couples.owner_id`)가 빠지면 남은 배우자의 장바구니·찜에
 * 주인이 없어진다. S2-07 에서 마지막 owner 의 강등을 막은 것과 같은 이유다.
 * 소유자가 관계를 끝내려면 삭제 요청을 쓴다.
 */
export function unlinkBlocker(role: string, memberCount: number): UnlinkBlocker | null {
  if (role === "owner") {
    return {
      code: "COUPLE_OWNER_CANNOT_LEAVE",
      message:
        "커플을 만든 계정은 연동만 해제할 수 없어요. 함께 보던 기록의 주인이 없어지기 때문입니다. 아래에서 삭제를 요청해 주세요.",
    };
  }

  if (memberCount < 2) {
    return { code: "COUPLE_NOT_LINKED", message: "연동된 배우자가 없어요." };
  }

  return null;
}

export const UNLINK_KEEPS_NOTICE =
  "연동을 해제해도 함께 담아 둔 장바구니와 찜은 남습니다. 커플을 만든 계정의 기록이기 때문이에요. 내 정보를 지우려면 삭제를 요청해 주세요.";

// =============================================================================
// 아직 없는 것 (§6.2 `/me` 의 나머지)
// =============================================================================

/** 자리는 두되 숫자를 지어내지 않는다(S2-08·S3-11 과 같은 원칙). */
export const ME_PENDING_SECTIONS = [
  {
    key: "membership",
    label: "멤버십·결제수단",
    reason: "멤버십 구독을 아직 만들지 않았습니다.",
    filledBy: "S7-11",
  },
  {
    key: "purge_history",
    label: "문서 파기 이력",
    reason: "계약서 업로드·파기를 아직 만들지 않았습니다.",
    filledBy: "S7-03",
  },
  {
    key: "notifications",
    label: "알림 수신 설정",
    reason: "알림센터를 아직 만들지 않았습니다.",
    filledBy: "S4-13",
  },
] as const satisfies readonly { key: string; label: string; reason: string; filledBy: string }[];

export type MePendingKey = (typeof ME_PENDING_SECTIONS)[number]["key"];

export function mePendingMetric(key: MePendingKey): MetricValue<number> {
  const section = ME_PENDING_SECTIONS.find((item) => item.key === key);

  if (section === undefined) throw new RangeError(`알 수 없는 항목입니다: ${key}`);

  return notYet(section.reason, section.filledBy);
}

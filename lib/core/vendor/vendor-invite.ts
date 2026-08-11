// 업체 멤버 초대 (S2-09 · 명세서 §2.2 F-V-13, §3.9, D-23)
//
// **React/Next 를 import 하지 않는다**(CLAUDE.md §3.1).
//
// S2-07 이 "가입된 이메일만 연결하고 미가입은 422" 로 남긴 자리를 채운다.

// =============================================================================
// 토큰 — 커플 초대와 다르게 간다
// =============================================================================

/**
 * **커플 초대(S3-01)와 왜 다른가.**
 *
 * 커플 초대는 배우자에게 **말로 불러 주는** 8자 코드다 — 그래서 짧고 헷갈리는
 * 글자(O·0·I·1)를 뺐다. 업체 초대는 **이메일로 링크를 보낸다.** 사람이 옮겨 적을
 * 일이 없으므로 짧을 이유가 없고, 짧은 코드는 추측에 약하다.
 *
 * 그리고 무게가 다르다 — 업체 멤버 권한은 가격·정산에 닿는다(§3.9). 커플 초대는
 * 잘못 들어와도 그 커플의 준비 정보까지지만, 업체 초대는 상품 가격과 정산을 볼 수
 * 있는 자리다. 그래서 더 긴 토큰을 쓴다.
 *
 * **공통으로 가져가는 것은 판정의 모양이다** — 만료·사용 여부를 한 함수가 보고
 * (`inviteBlocker` 와 같은 자리), 기한을 상수·파라미터로 둔다.
 */
export const VENDOR_INVITE_TOKEN_BYTES = 32;

/**
 * 초대 링크 유효 시간의 **폴백**.
 *
 * 진짜 값은 `app_settings.vendor_invite.ttl_hours` 가 갖는다(§7.4). 설정이 없을 때
 * 초대를 아예 못 보내게 하는 것보다는 보수적인 기본값으로 보내는 편이 낫다 —
 * 초대는 만료돼도 다시 보내면 되는 일이라 위험이 작다.
 */
export const VENDOR_INVITE_TTL_FALLBACK_HOURS = 72;

export function inviteExpiresAt(issuedAt: string, ttlHours: number | null): string {
  const hours = ttlHours ?? VENDOR_INVITE_TTL_FALLBACK_HOURS;
  const base = new Date(issuedAt).getTime();

  return new Date(base + hours * 3_600_000).toISOString();
}

// =============================================================================
// 판정 — 커플 초대의 `inviteBlocker` 와 같은 모양
// =============================================================================

export type InviteBlocker = { code: string; message: string };

export type VendorInviteState = {
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
};

/**
 * 이 초대를 지금 쓸 수 있는가.
 *
 * 순서가 중요하다 — **거둔 것을 먼저 본다.** 만료도 되고 거둬지기도 한 초대에
 * "만료됐어요" 라고 답하면 재발송을 기대하게 되는데, 실제로는 업체가 거둔 것이다.
 */
export function vendorInviteBlocker(
  invite: VendorInviteState,
  now: string,
): InviteBlocker | null {
  if (invite.revokedAt !== null) {
    return { code: "REVOKED", message: "취소된 초대예요. 업체에 다시 요청해 주세요." };
  }

  if (invite.acceptedAt !== null) {
    return { code: "ALREADY_USED", message: "이미 사용된 초대예요." };
  }

  if (Date.parse(invite.expiresAt) <= Date.parse(now)) {
    return { code: "EXPIRED", message: "만료된 초대예요. 업체에 재발송을 요청해 주세요." };
  }

  return null;
}

// =============================================================================
// 이메일
// =============================================================================

/** 저장·비교는 소문자로 한다. 대소문자가 다른 같은 주소로 두 번 초대되면 안 된다. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * 초대받은 이메일과 로그인한 계정이 같은가.
 *
 * **일치해야 수락된다.** 토큰이 유출되면 아무나 업체 멤버가 되는데, 그건 가격·정산
 * 접근이다(§3.9). 다른 이메일로 가입한 사람은 초대받은 주소로 로그인해야 한다 —
 * 불편하지만, 링크 하나로 남의 업체에 들어갈 수 있는 것보다 낫다.
 */
export function emailMatches(inviteEmail: string, accountEmail: string | null): boolean {
  if (accountEmail === null) return false;

  return normalizeEmail(inviteEmail) === normalizeEmail(accountEmail);
}

export const EMAIL_MISMATCH_MESSAGE =
  "초대받은 이메일로 로그인해 주세요. 다른 계정으로는 수락할 수 없어요.";

// =============================================================================
// 이미 다른 업체 멤버인 경우
// =============================================================================

/**
 * **거절한다.**
 *
 * DB 는 한 사람이 여러 업체에 속하는 것을 막지 않는다(`vendor_members` 의 유니크는
 * `(vendor_id, user_id)` 다). 그런데 앱은 `findMemberVendor()` 가 `limit(1)` 로
 * **하나만 고른다** — 두 업체에 속하면 어느 업체 화면이 뜰지 비결정적이 된다.
 *
 * 그 모호함은 초대 시점에 막는 편이 낫다. 다중 소속을 지원하려면 업체 전환 UI 와
 * 세션의 '현재 업체' 개념이 함께 필요하고, 그건 별도 결정이다.
 * (DB 제약으로 올리지 않은 이유: 기존 데이터·픽스처가 다중 소속을 쓰고 있고,
 *  제약은 되돌리기 어려운 변경이라 결정이 선 뒤에 건다.)
 */
export const ALREADY_MEMBER_ELSEWHERE_MESSAGE =
  "이미 다른 업체에 소속된 계정이에요. 한 계정은 한 업체에만 속할 수 있어요.";

export const ALREADY_MEMBER_HERE_MESSAGE = "이미 이 업체의 멤버예요.";

// =============================================================================
// 상태 표기
// =============================================================================

export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";

export function inviteStatus(invite: VendorInviteState, now: string): InviteStatus {
  if (invite.revokedAt !== null) return "revoked";
  if (invite.acceptedAt !== null) return "accepted";
  if (Date.parse(invite.expiresAt) <= Date.parse(now)) return "expired";

  return "pending";
}

export const INVITE_STATUS_LABEL: Record<InviteStatus, string> = {
  pending: "대기 중",
  accepted: "수락됨",
  revoked: "취소됨",
  expired: "기간 지남",
};

/** 재발송할 수 있는가. 수락된 것은 다시 보낼 이유가 없다. */
export function canResend(invite: VendorInviteState, now: string): boolean {
  const status = inviteStatus(invite, now);

  return status === "pending" || status === "expired";
}

// =============================================================================
// 화면 문구
// =============================================================================

export const INVITE_SENT_NOTE =
  "초대 메일을 보냈어요. 받는 분이 가입한 뒤 링크를 열면 멤버로 합류해요.";
export const INVITE_UNREGISTERED_NOTE =
  "아직 가입하지 않은 이메일이에요. 초대 링크를 보내 두면 가입 후에 합류할 수 있어요.";
export const INVITES_EMPTY_TITLE = "보낸 초대가 없어요";
export const INVITES_EMPTY_DESCRIPTION =
  "이메일로 초대하면 상대가 가입 여부와 상관없이 합류할 수 있어요.";

/**
 * 외부 발송은 아직 스텁이다(D-28).
 *
 * 화면이 이 사실을 감추면 업체는 메일이 갔다고 믿고 기다린다. **보낸 기록은 남지만
 * 실제로 나가지는 않는다**는 것을 그대로 적는다.
 */
export const INVITE_DELIVERY_PENDING_NOTE =
  "메일 발송사 연동 전이라 실제 메일은 아직 나가지 않아요. 링크를 복사해 직접 전달해 주세요.";

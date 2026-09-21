// 알림 → 화면 이동 (C-4d 가 열고 C-4e 가 채웠다 · 명세서 §2.1 F-C-21 확장 · D-98)
//
// 프레임워크를 모르는 순수 모듈이다(CLAUDE.md §3.1).
//
// ── 무엇이 문제였나 ─────────────────────────────────────────────────────────
// **알림에서 나가는 링크가 하나도 없었다**(B-1 조사 4-3). "청첩장 주문할 때가
// 됐어요" 를 읽고 나서 **어디로 가야 하는지**는 사용자가 스스로 찾아야 했다 — 알림이
// 일을 알려 주기만 하고 **그 일을 할 수 있는 자리로 잇지 않으면** 알림이 아니라 잔소리다.
//
// ── 왜 레지스트리인가 (D-98) ────────────────────────────────────────────────
// 글의 CTA(`TOOL_CTAS`)가 이미 같은 판단을 했다 — **없는 화면으로 보내지 않는다.**
// 경로를 호출부에서 문자열로 조립하면 라우트가 바뀌었을 때 알림만 조용히 404 가 되고,
// 그것은 **누른 사람만 알게 되는 고장**이다. 여기 한 곳에 모아 두면 검사가 실재를 본다.
//
// ── 전수다 (C-4e 완료 조건) ─────────────────────────────────────────────────
// **템플릿 하나하나에 대해 '가는 곳' 이거나 '없다는 사실과 이유' 가 적혀 있다.**
// 빠진 키가 있으면 단위 테스트가 잡는다 — 목록에 없다는 것과 "링크가 없다고 정했다"
// 는 **다른 상태**이며, 전자는 우리가 아직 안 본 자리다.
//
// ── 참조가 모자라면 링크를 만들지 않는다 ────────────────────────────────────
// `payload_json` 은 **참조 ID와 숫자만** 담는다(§7.3). 그 참조가 없으면 `null` 을
// 돌려주고 화면은 링크 없이 문장만 그린다 — **잘못된 곳으로 보내는 것보다 안 보내는
// 편이 낫다.** 던지지 않는 이유는 알림 하나의 참조 누락이 알림함 전체를 500 으로
// 만들면 안 되기 때문이다(`TOOL_CTAS` 가 모르는 키를 떨어뜨리는 것과 같은 판단).
//
// ── 같은 알림도 읽는 사람에 따라 갈 곳이 다르다 ─────────────────────────────
// **발송부가 정한 수신자를 근거로 삼는다. 화면 구조로 추측하지 않는다.**
// `notifyConsultation({ audience })` 가 `"both"` 로 보내는 다섯(확정·취소·이행확인
// 요청·처리결과·조율)과 `notifyNewMessage` 의 채팅은 **커플과 업체 양쪽**에 간다.
// 커플에게는 `/consultations`, 업체에게는 `/vendor/consultations` 이며, 한쪽 경로를
// 양쪽에 주면 다른 쪽은 권한 거부 화면을 본다. 그래서 그 여섯만 역할로 가르고,
// 나머지는 **실제로 한쪽에만 가므로** 갈리지 않는다.

/** 링크 판정에 필요한 만큼의 역할. `profiles.role` 값을 그대로 받는다. */
export type LinkViewerRole =
  | "guest"
  | "consumer"
  | "couple_partner"
  | "planner"
  | "vendor_owner"
  | "vendor_staff"
  | "ops"
  | "admin"
  | null;

export type NotificationLink = { href: string; label: string };

/**
 * 링크가 **없다고 정한** 자리. 목록에서 빠진 것과 다르다.
 *
 * `reason` 은 **왜 없는지**이며 운영·다음 사람이 읽는다. 화면에는 그리지 않는다 —
 * 사용자에게 "우리가 아직 못 이었다" 를 알릴 이유가 없고, 알림 문장이 이미 무엇을
 * 하라는지 말한다.
 */
export type NoLink = { kind: "none"; reason: string };

type Resolver = (
  payload: Record<string, unknown>,
  role: LinkViewerRole,
) => NotificationLink | null;

type LinkEntry = Resolver | NoLink;

const asId = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/** 업체 쪽 화면을 보는 사람인가. 양쪽에 가는 알림이 이것으로 갈린다. */
export function isVendorViewer(role: LinkViewerRole): boolean {
  return role === "vendor_owner" || role === "vendor_staff";
}

/** 참조 하나로 경로를 만드는 흔한 모양. 참조가 없으면 링크도 없다. */
const byRef =
  (key: string, path: (id: string) => string, label: string): Resolver =>
  (payload) => {
    const id = asId(payload[key]);

    return id === null ? null : { href: path(id), label };
  };

/** 참조가 필요 없는 고정 화면. 한쪽 면에만 가는 알림이 쓴다. */
const toPage =
  (href: string, label: string): Resolver =>
  () => ({ href, label });

/** 양쪽에 가는 알림. 읽는 사람의 면으로 가른다. */
const bySide =
  (consumer: NotificationLink, vendor: NotificationLink): Resolver =>
  (_payload, role) =>
    isVendorViewer(role) ? vendor : consumer;

/** 양쪽에 가는 상담 알림의 도착지는 면만 다르고 문구는 같다. */
const consultationBySide = (label: string): Resolver =>
  bySide({ href: "/consultations", label }, { href: "/vendor/consultations", label });

/**
 * 템플릿 키 → 가는 곳.
 *
 * **실재하는 경로만 적는다.** 단위 테스트가 정적 경로마다 화면 파일이 있는지
 * 대조하고, **31종 전부가 여기 있는지**를 `NOTIFICATION_TEMPLATES` 와 양방향으로 센다.
 */
export const NOTIFICATION_LINKS: Readonly<Record<string, LinkEntry>> = {
  // ── 기한 (C-4d · 커플에게 간다) ───────────────────────────────────────────
  "task_due.remind": toPage("/checklist", "체크리스트에서 보기"),
  "task_due.order": (payload) => {
    const vendorId = asId(payload.vendorId);
    const productId = asId(payload.productId);

    if (vendorId === null || productId === null) return null;

    return { href: `/explore/${vendorId}/${productId}`, label: "상품에서 보기" };
  },

  // ── D-day (커플) ──────────────────────────────────────────────────────────
  // **홈이 아니라 체크리스트다.** "며칠 남았어요" 다음에 할 일은 *남은 준비를 보는 것*
  // 이고, 홈은 그 목록의 요약만 보여 준다.
  "dday.remind": toPage("/checklist", "남은 준비 보기"),

  // ── 찜 가격 변동 (커플) ───────────────────────────────────────────────────
  // **아직 아무도 보내지 않는 템플릿이다** — 문장 틀만 있고 발송부가 없다(S3-06).
  // 그래도 가는 곳을 정해 둔다: 배치가 서는 날 링크까지 함께 살아나고, 그 사이에도
  // "이 알림은 어디로 가야 하는가" 가 미결로 남지 않는다.
  "price_change.drop": toPage("/wishlist", "찜 목록 보기"),

  // ── 커플 연동 (커플) ──────────────────────────────────────────────────────
  // 이것도 발송부가 아직 없다(S3-01). 수락으로 바뀌는 것은 **함께 보는 상태**이고
  // 그 상태를 보여 주는 화면은 내 정보다.
  "couple_invite.accepted": toPage("/me", "연동 상태 보기"),

  // ── 채팅 (양쪽) ───────────────────────────────────────────────────────────
  // 업체에는 방 단위 화면이 없다 — `/vendor/chat` 하나가 목록과 대화를 겸한다.
  "chat.new_message": (payload, role) => {
    if (isVendorViewer(role)) return { href: "/vendor/chat", label: "대화 열기" };

    const roomId = asId(payload.roomId);

    return roomId === null ? null : { href: `/chat/${roomId}`, label: "대화 열기" };
  },

  // ── 문의·견적 ─────────────────────────────────────────────────────────────
  // 문의에는 상세 라우트가 없다 — 목록이 그 건을 펴서 보여 준다.
  // 받은 문의는 **업체에게만**, 견적 도착·거절은 **커플에게만** 간다(발송부 근거).
  "inquiry.received": toPage("/vendor/inquiries", "문의 인박스 열기"),
  "inquiry.quote_arrived": toPage("/inquiries", "받은 견적 보기"),
  "inquiry.declined": toPage("/inquiries", "문의함 열기"),

  // ── 상담·탐방 ─────────────────────────────────────────────────────────────
  // 상담 상세 라우트가 없고 목록이 상태와 행동을 다 보여 준다.
  // 신청은 업체에게만, 승인·거절은 커플에게만, 나머지 다섯은 양쪽에 간다.
  "schedule.requested": toPage("/vendor/consultations", "상담 신청 보기"),
  "schedule.approved": toPage("/consultations", "상담 보기"),
  "schedule.rejected": toPage("/consultations", "상담 보기"),
  "schedule.confirmed": consultationBySide("확정된 일정 보기"),
  "schedule.cancelled": consultationBySide("상담 보기"),
  "schedule.confirm_request": consultationBySide("이행 확인하기"),
  "schedule.resolved": consultationBySide("처리 결과 보기"),
  "schedule.disputed": consultationBySide("상담 보기"),

  // ── 업체 멤버 초대 ────────────────────────────────────────────────────────
  // **가는 곳이 없다.** 수락 화면은 `/vendor/invite/[token]` 인데 **토큰을 payload 에
  // 넣지 않는다** — 넣으면 알림 한 건이 곧 업체 접근 열쇠가 된다(0026 이 그렇게 정했고
  // 이 규칙을 링크 하나 때문에 되돌리지 않는다). 수락 링크는 이메일이 나른다.
  // 초대받은 사람은 아직 멤버가 아니라 `/vendor/members` 로 보내면 거부 화면을 본다.
  "vendor_invite.received": {
    kind: "none",
    reason:
      "수락 화면이 토큰을 요구하는데 토큰은 payload 에 담지 않는다(알림이 접근 열쇠가 된다). 아직 멤버가 아니라 다른 업체 화면으로도 보낼 수 없다. 수락 링크는 이메일이 나른다.",
  },

  // ── 계약 (커플 대표에게 간다) ─────────────────────────────────────────────
  "contract.issued": byRef("contractId", (id) => `/contracts/${id}`, "계약서 보기"),
  "contract.activated": byRef("contractId", (id) => `/contracts/${id}`, "계약서 보기"),
  // 해지 화면은 **예약 아래**에 있다. 그래서 발송부가 예약 참조를 함께 싣는다(C-4e).
  "contract.cancel_requested": byRef(
    "bookingId",
    (id) => `/bookings/${id}/cancel`,
    "해지 진행 보기",
  ),
  "contract.cancel_settled": byRef(
    "bookingId",
    (id) => `/bookings/${id}/cancel`,
    "정산 내역 보기",
  ),

  // ── 결제 (커플 대표) ──────────────────────────────────────────────────────
  // 회차 단위 화면이 없다 — 예약 상세가 회차를 보여 준다. 그래서 발송부가 예약
  // 참조를 함께 싣는다(C-4e). 완납은 계약이 끝났다는 말이라 계약서로 간다.
  "payment.succeeded": byRef("bookingId", (id) => `/bookings/${id}`, "결제 내역 보기"),
  "payment.failed": byRef("bookingId", (id) => `/bookings/${id}`, "결제 다시 시도하기"),
  "payment.fully_paid": byRef("contractId", (id) => `/contracts/${id}`, "계약서 보기"),

  // ── 정산 (업체) ───────────────────────────────────────────────────────────
  "settlement.confirmed": toPage("/vendor/settlements", "정산 명세 보기"),
  "settlement.paid": toPage("/vendor/settlements", "정산 명세 보기"),

  // ── 안전거래 ──────────────────────────────────────────────────────────────
  // 앞의 셋은 커플 대표에게 간다. 화면이 예약 아래라 발송부가 예약 참조를 싣는다(C-4e).
  "escrow.held": byRef("bookingId", (id) => `/bookings/${id}/escrow`, "안전거래 보기"),
  "escrow.released": byRef("bookingId", (id) => `/bookings/${id}/escrow`, "안전거래 보기"),
  "escrow.refunded": byRef("bookingId", (id) => `/bookings/${id}/escrow`, "안전거래 보기"),
  // 이것만 업체 멤버에게 간다 — 업체에게는 정산으로 가는 사건이다.
  "escrow.released_vendor": toPage("/vendor/escrow", "안전거래 정산 보기"),
};

/**
 * 이 알림에서 어디로 가는가. 없으면 `null` 이고 화면은 문장만 그린다.
 *
 * **모르는 템플릿도 `null` 이다** — 링크가 없다고 정한 것과 목록에 없는 것을 화면은
 * 똑같이 다룬다(둘 다 "보낼 곳을 모른다"). 그 둘을 가르는 것은 **검사**의 일이며,
 * 목록에 없는 키는 단위 테스트가 잡는다.
 */
export function notificationLink(
  templateKey: string | null,
  payload: Record<string, unknown> | null,
  role: LinkViewerRole = null,
): NotificationLink | null {
  if (templateKey === null) return null;

  const entry = NOTIFICATION_LINKS[templateKey];

  if (entry === undefined) return null;
  if (typeof entry !== "function") return null;

  return entry(payload ?? {}, role);
}

/** 링크를 만들 수 있는 템플릿 키. */
export const LINKED_TEMPLATE_KEYS: readonly string[] = Object.keys(NOTIFICATION_LINKS).filter(
  (key) => typeof NOTIFICATION_LINKS[key] === "function",
);

/** **없다고 정한** 템플릿 키와 그 이유. 늘어나면 이유가 함께 남는다. */
export const UNLINKED_TEMPLATES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(NOTIFICATION_LINKS)
    .filter(([, entry]) => typeof entry !== "function")
    .map(([key, entry]) => [key, (entry as NoLink).reason]),
);

/**
 * 링크가 참조를 요구하는 템플릿 → 그 참조 키.
 *
 * **발송부가 그 참조를 싣는지**를 검사가 대조한다 — 여기 적힌 키를 payload 에
 * 담지 않으면 링크는 조용히 `null` 이 되고, 그것은 누른 사람만 아는 고장이다.
 * (`chat.new_message` 와 `task_due.order` 는 조건이 둘 이상이라 각자 검사한다.)
 */
export const LINK_REQUIRED_REFS: Readonly<Record<string, string>> = {
  "contract.issued": "contractId",
  "contract.activated": "contractId",
  "contract.cancel_requested": "bookingId",
  "contract.cancel_settled": "bookingId",
  "payment.succeeded": "bookingId",
  "payment.failed": "bookingId",
  "payment.fully_paid": "contractId",
  "escrow.held": "bookingId",
  "escrow.released": "bookingId",
  "escrow.refunded": "bookingId",
};

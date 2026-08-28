// CS·신고 티켓 (S8-09 · F-A-06)
//
// ══════════════════════════════════════════════════════════════════════════
// **판정 어휘를 쓰지 않는다. 우리가 무엇을 했는지를 적는다.**
// ══════════════════════════════════════════════════════════════════════════
//
// 종결 어휘가 '사실·허위' 가 아니라 **'조치했다·조치하지 않기로 했다'** 다.
// 신고 내용이 사실인지 우리는 대개 알 수 없고(당사자 둘의 말이 다르다) 안다 해도
// 그것을 선언하는 것은 조율자의 자리가 아니다(D-24). 우리가 답할 수 있는 것은
// **"우리가 무엇을 했고 왜 그렇게 했는가"** 뿐이다.
//
// **'조치하지 않음' 에도 사유가 필수다.** 예외를 두면 거절이 곧 무시가 되고,
// 신고자는 자기 신고가 읽혔는지조차 알 수 없다(S8-04·S8-11 이 정한 것과 같은 규칙).

import { z } from "zod";

export const TICKET_CATEGORIES = [
  "account",
  "payment",
  "vendor",
  "content",
  "abuse",
  "bug",
  "other",
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_CATEGORY_LABEL: Record<TicketCategory, string> = {
  account: "계정·로그인",
  payment: "결제·환불",
  vendor: "업체 관련",
  content: "게시물·콘텐츠",
  abuse: "괴롭힘·부적절한 연락",
  bug: "오류 제보",
  other: "그 밖의 문의",
};

export const TICKET_STATUSES = ["open", "assigned", "resolved", "rejected"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  open: "접수",
  assigned: "담당 배정",
  resolved: "조치함",
  rejected: "조치하지 않음",
};

export const TICKET_STATUS_HINT: Record<TicketStatus, string> = {
  open: "아직 아무도 맡지 않았습니다.",
  assigned: "담당자가 정해졌습니다. 담당자 없이 이 상태가 될 수 없습니다.",
  resolved: "우리가 무엇을 했는지 사유에 적습니다. 신고 내용이 사실이라는 뜻은 아닙니다.",
  rejected: "조치하지 않기로 했다는 뜻입니다. 신고자가 틀렸다는 뜻은 아닙니다.",
};

/** 종결 상태. **되돌리지 않는다** — 다시 열려면 새 티켓을 받는다. */
export function isTerminal(status: string): boolean {
  return status === "resolved" || status === "rejected";
}

// =============================================================================
// 접수 (소비자)
// =============================================================================

/**
 * **상태·담당자·처리 사유를 받지 않는다.**
 *
 * 스키마에 칸이 없고 DB 컬럼 권한도 주지 않는다(0062) — 신고자가 `status='resolved'`
 * 로 접수하면 그 티켓은 **운영자 큐에 아예 뜨지 않는다**(FIX-43). `assignee_id` 도
 * 같다: 남의 이름으로 "담당" 기록이 만들어진다.
 */
export const TicketCreateSchema = z.object({
  category: z.enum(TICKET_CATEGORIES),
  subject: z.string().trim().min(1, "무엇에 대한 것인지 한 줄로 적어 주세요.").max(200),
  body: z.string().trim().max(5_000).nullable(),
});
export type TicketCreateInput = z.infer<typeof TicketCreateSchema>;

// =============================================================================
// 처리 (운영자)
// =============================================================================

export const TICKET_ACTIONS = ["assign", "resolve", "reject"] as const;
export type TicketAction = (typeof TICKET_ACTIONS)[number];

export const TICKET_ACTION_LABEL: Record<TicketAction, string> = {
  assign: "담당 맡기",
  resolve: "조치함으로 종결",
  reject: "조치하지 않음으로 종결",
};

/**
 * 처리 입력.
 *
 * **배정에도 사유를 요구한다.** 담당이 바뀌는 것도 나중에 "왜 이 사람이 봤나" 를
 * 답해야 하는 사건이다 — 사유를 요구하는 자리에 예외를 만들면 그 자리부터 빈칸이 된다.
 */
export const TicketActionSchema = z.object({
  ticketId: z.string().uuid(),
  action: z.enum(TICKET_ACTIONS),
  note: z.string().trim().min(1, "무엇을 왜 했는지 적어 주세요.").max(1_000),
});
export type TicketActionInput = z.infer<typeof TicketActionSchema>;

/** 이 조치를 지금 할 수 있는가. **종결된 티켓은 다시 만지지 않는다.** */
export function canApply(status: string, action: TicketAction): boolean {
  if (isTerminal(status)) return false;
  if (action === "assign") return status === "open" || status === "assigned";

  return true;
}

export function statusAfter(action: TicketAction): TicketStatus {
  if (action === "assign") return "assigned";

  return action === "resolve" ? "resolved" : "rejected";
}

// =============================================================================
// 업체 제재
// =============================================================================

/**
 * **집행할 수 있는 것만 집행한다.**
 *
 * 업체 정지는 `vendors.status = 'suspended'` 이고, `vendors_select_public` 이
 * `status = 'active'` 만 공개하므로 **정지하면 탐색·검색·상세에서 실제로 사라진다.**
 * 집행이 실재하므로 콘솔이 한다.
 *
 * **사용자 정지는 만들지 않는다.** `profiles` 에 상태 칸이 없고, 칸만 만들면 화면은
 * "정지됨" 이라 적는데 그 사용자는 계속 서비스를 쓴다 — 화면이 거짓말을 하게 된다.
 * 무엇을 근거로 정지하고 정지가 무엇을 막으며 이의제기를 어떻게 받는지는
 * **O-14(커뮤니티 운영 정책)와 같은 층의 미결**이다.
 */
export const VENDOR_SANCTIONS = ["suspend", "reinstate"] as const;
export type VendorSanction = (typeof VENDOR_SANCTIONS)[number];

export const VENDOR_SANCTION_LABEL: Record<VendorSanction, string> = {
  suspend: "업체 공개 중지",
  reinstate: "공개 재개",
};

export const VENDOR_SANCTION_HINT: Record<VendorSanction, string> = {
  suspend:
    "탐색·검색·업체 상세에서 즉시 사라집니다. 이미 진행 중인 예약·계약은 그대로 남습니다 — 그것은 별도 절차입니다.",
  reinstate: "다시 공개됩니다. 왜 되돌리는지도 기록에 남습니다.",
};

export const VendorSanctionSchema = z.object({
  vendorId: z.string().uuid(),
  sanction: z.enum(VENDOR_SANCTIONS),
  reason: z.string().trim().min(1, "사유를 적어 주세요.").max(1_000),
  /** 어느 티켓에서 나온 조치인가. 없어도 되지만 있으면 근거가 이어진다. */
  ticketId: z.string().uuid().nullable(),
});
export type VendorSanctionInput = z.infer<typeof VendorSanctionSchema>;

/** 사용자 제재를 왜 만들지 않았는지. **화면이 이 문장을 그대로 적는다.** */
export const USER_SANCTION_UNAVAILABLE = {
  openIssue: "O-14",
  message:
    "사용자 계정 정지는 아직 집행 수단이 없습니다. 상태 칸만 만들면 화면은 '정지됨'이라 적는데 그 사용자는 계속 서비스를 쓰게 되고, 그것이 더 나쁩니다. 무엇을 근거로 정지하고 정지가 무엇을 막는지는 운영 정책이 정해져야 합니다.",
} as const;

// =============================================================================
// 옆 큐
// =============================================================================

/**
 * 신고가 쌓이는 자리가 넷이다. **합치지 않는다.**
 *
 * S8-03 이 분쟁에서 넷을 한 큐로 합친 것과 다른 판단이다(D-121). 분쟁 넷은 **같은
 * 사건(예약 하나)에 대한 다른 기록**이라 하나를 안 보면 그 사건을 놓쳤다. 신고 넷은
 * **대상도 조치도 다르다** — 게시물을 가리는 일, 후기를 내리는 일, 룰을 손보는 일,
 * 계정·결제 문의에 답하는 일이 한 목록에 섞이면 처리 절차가 서로 다른 건이 같은 줄에
 * 놓인다(S7-17 이 커뮤니티 신고를 CS 와 나눈 것과 같은 이유).
 *
 * 대신 **열린 건수와 링크를 함께 보인다** — 합치지 않되 놓치지 않게 한다.
 */
export const SIBLING_QUEUES = [
  { key: "community", label: "커뮤니티 신고", href: "/admin/community-reports", action: "게시물을 가리거나 되돌립니다" },
  { key: "review", label: "후기 신고", href: "/admin/reviews", action: "후기를 내리거나 그대로 둡니다" },
  { key: "finding", label: "리포트 오탐 신고", href: "/admin/ai-quality", action: "검출 룰을 손볼 자리로 받습니다" },
] as const;

export type SiblingQueueKey = (typeof SIBLING_QUEUES)[number]["key"];

/** 큐 요약. **0건도 줄을 남긴다** — 사라지면 그 큐가 없는 줄 안다. */
export type QueueCount = { key: SiblingQueueKey; open: number };

export type TicketSummary = {
  open: number;
  assigned: number;
  resolved: number;
  rejected: number;
  /** 담당자가 없는 열린 티켓. **가장 먼저 봐야 하는 값**이다. */
  unassigned: number;
};

export function summarize(
  tickets: readonly { status: string; assigneeId: string | null }[],
): TicketSummary {
  const count = (status: string) => tickets.filter((ticket) => ticket.status === status).length;

  return {
    open: count("open"),
    assigned: count("assigned"),
    resolved: count("resolved"),
    rejected: count("rejected"),
    unassigned: tickets.filter(
      (ticket) => !isTerminal(ticket.status) && ticket.assigneeId === null,
    ).length,
  };
}

/**
 * 접수 후 경과 시간.
 *
 * **'지연' 이라고 적지 않는다.** 처리 기한(SLA)이 정해지지 않았고(F-A-01 의 심사 SLA 와
 * 달리 CS 기한은 명세에 없다) 지어낸 기한은 곧 운영 기준으로 굳는다(D-119 가 삭제
 * 요청에서 정한 것과 같다). 화면은 경과 시간만 보여주고 판정하지 않는다.
 */
export function elapsedHours(createdAt: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(createdAt)) / 3_600_000));
}

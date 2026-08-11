// 채팅 도메인 규칙 (S4-04 · 명세서 §2.1 F-C-27, §2.2 F-V-15, §3.7, §7.3, D-23)
//
// **React/Next 를 import 하지 않는다.** 소비자 화면·업체 인박스·API 가 같은 값을
// 쓰고, Expo 전환 시 그대로 옮겨진다(CLAUDE.md §3.1).
//
// 여기서 다루는 것은 "무엇을 말했는가" 가 아니라 **"그 말이 어떤 상태인가"** 다 —
// 읽혔는가 · 회수됐는가 · 업체가 답해야 할 시간이 얼마나 남았는가.

// =============================================================================
// 편 (§3.7 chat_sender_type)
// =============================================================================

export const CHAT_SENDER_TYPES = ["couple", "vendor", "system"] as const;

export type ChatSenderType = (typeof CHAT_SENDER_TYPES)[number];

/** 화면이 서 있는 편. 이 값으로 말풍선 좌우와 안읽음 대상이 갈린다. */
export type ChatSide = "couple" | "vendor";

/**
 * 이 메시지가 '나의 것' 인가.
 *
 * `system` 은 어느 편도 아니다 — 서버가 남긴 카드이므로 양쪽 모두에게 가운데
 * 카드로 그린다(아래 `SYSTEM_CARD_KINDS`).
 */
export function isMine(senderType: ChatSenderType, side: ChatSide): boolean {
  return senderType === side;
}

// =============================================================================
// 방 상태 (§3.7 chat_rooms.status)
// =============================================================================

export const CHAT_ROOM_STATUSES = ["active", "archived", "blocked"] as const;

export type ChatRoomStatus = (typeof CHAT_ROOM_STATUSES)[number];

export const ROOM_STATUS_LABEL: Record<ChatRoomStatus, string> = {
  active: "대화 중",
  archived: "보관됨",
  blocked: "차단됨",
};

/**
 * 지금 보낼 수 있는가.
 *
 * DB 도 같은 판정을 한다(0021 `chat_room_is_open()` 이 INSERT 정책에 들어 있다).
 * 화면이 먼저 막는 것은 UX 이고 **경계는 RLS 다** — 여기서 true 가 나와도 정책이
 * 거절하면 거절이 맞다(CLAUDE.md §5.5).
 */
// 타입 술어로 둔다 — 부정하면 남은 상태가 archived|blocked 로 좁혀져,
// 화면이 `ROOM_CLOSED_NOTE` 를 열쇠 누락 없이 안전하게 색인할 수 있다.
export function canSend(status: ChatRoomStatus): status is "active" {
  return status === "active";
}

export const ROOM_CLOSED_NOTE: Record<Exclude<ChatRoomStatus, "active">, string> = {
  archived: "보관된 대화예요. 지난 내용은 그대로 볼 수 있어요.",
  blocked: "차단된 대화예요. 새 메시지를 보낼 수 없고 지난 내용만 남습니다.",
};

// =============================================================================
// 회수 (S4-01 — 수정·삭제 없음, 회수만)
// =============================================================================

/**
 * 회수된 메시지 자리에 쓰는 문구.
 *
 * "삭제되었습니다" 라고 쓰지 않는다 — 지워지지 않았기 때문이다. 본문은
 * `chat_messages` 에 남아 있고 분쟁 조율 때 운영자가 본다(D-23·D-24). 화면이
 * "삭제" 라고 말하면 사용자는 지워졌다고 믿게 되고, 그것은 사실이 아니다.
 */
export const RETRACTED_TEXT = "보낸 사람이 회수한 메시지예요.";

export const RETRACT_CONFIRM =
  "회수하면 상대 화면에서 내용이 가려져요. 다만 분쟁 조율을 위해 기록 자체는 남습니다.";

/**
 * 회수할 수 있는가.
 *
 * **자기가 보낸 것만.** 그리고 `system` 카드는 서버가 남긴 것이라 회수 대상이
 * 아니다. 시간 제한은 두지 않는다 — 제한을 두면 "늦게 깨달은 실수" 를 못 내리고,
 * 어차피 원본이 보존되므로 회수가 증적을 훼손하지 않는다.
 */
export function canRetract(
  message: { senderId: string | null; senderType: ChatSenderType; retractedAt: string | null },
  viewerId: string,
): boolean {
  if (message.senderType === "system") return false;
  if (message.retractedAt !== null) return false;

  return message.senderId === viewerId;
}

// =============================================================================
// 안읽음 (§3.7 chat_room_reads — 참여자별 층)
// =============================================================================

/**
 * 내가 아직 안 읽은 메시지 수.
 *
 * **상대 편 것만 센다.** 내가 보낸 메시지는 내가 읽을 대상이 아니다. `system`
 * 카드는 센다 — 일정 제안처럼 사용자가 확인해야 할 내용이기 때문이다.
 *
 * `lastReadAt` 이 null 이면 한 번도 열지 않은 방이므로 상대 편 메시지가 전부
 * 안읽음이다.
 */
export function unreadCount(
  messages: readonly { senderType: ChatSenderType; createdAt: string }[],
  lastReadAt: string | null,
  side: ChatSide,
): number {
  return messages.filter((message) => {
    if (message.senderType === side) return false;
    if (lastReadAt === null) return true;

    return message.createdAt > lastReadAt;
  }).length;
}

/** 배지 표기. 99를 넘으면 숫자를 늘리지 않는다 — 375px 에서 배지가 깨진다. */
export function unreadBadge(count: number): string | null {
  if (count <= 0) return null;

  return count > 99 ? "99+" : String(count);
}

// =============================================================================
// 응답 SLA (§2.2 F-V-15, §7.4 가변 파라미터)
// =============================================================================

/**
 * SLA 눈금. **값은 코드가 아니라 `app_settings.chat.sla_response_minutes` 가 갖는다**
 * (0022). 이 타입은 그 행의 모양일 뿐이다.
 */
export type SlaThreshold = { minutes: number; warnPercent: number };

export type SlaLevel =
  /** 기다리는 사람이 없다. 업체가 마지막으로 답했거나 아직 아무도 묻지 않았다. */
  | "clear"
  /** 기다리는 중이고 아직 여유가 있다. */
  | "waiting"
  /** 눈금의 warnPercent 를 넘겼다. */
  | "due"
  /** 눈금을 넘겼다. */
  | "overdue";

export type SlaState = {
  level: SlaLevel;
  /** 고객이 기다린 시간(분). 기다리는 사람이 없으면 null. */
  elapsedMinutes: number | null;
  /** 눈금까지 남은 시간(분). 이미 넘겼으면 음수. 기다리는 사람이 없으면 null. */
  remainingMinutes: number | null;
};

export const SLA_UNSET_NOTE =
  "응답 기준 시간이 설정되지 않아 타이머를 표시하지 않아요. 운영 설정에서 정할 수 있어요.";

/**
 * 지금 이 방의 SLA 상태.
 *
 * **결정적 계산이므로 LLM 이 아니라 순수 함수다**(CLAUDE.md §3.1). 그리고 눈금이
 * 없으면 `null` 을 돌려준다 — 기본값을 지어내면 화면이 "지연" 이라고 단정하게 되고,
 * 그 단정은 업체 평가로 이어진다(§2.3 — 평가적 단정 금지).
 *
 * @param awaitingSince `chat_rooms.awaiting_vendor_since`. null 이면 기다리는 사람이 없다.
 * @param now 기준 시각. 호출부가 넘긴다 — 함수 안에서 시계를 읽으면 테스트가 흔들린다.
 */
export function slaState(
  awaitingSince: string | null,
  now: Date,
  threshold: SlaThreshold | null,
): SlaState | null {
  if (threshold === null) return null;
  if (threshold.minutes <= 0) return null;

  if (awaitingSince === null) {
    return { level: "clear", elapsedMinutes: null, remainingMinutes: null };
  }

  const started = new Date(awaitingSince).getTime();
  if (Number.isNaN(started)) return null;

  // 시계가 뒤로 간 경우(서버·클라이언트 시각차)는 0으로 클램프한다. 음수 경과는
  // "아직 시작 안 한 대기" 라는 뜻이 없다.
  const elapsedMinutes = Math.max(0, Math.floor((now.getTime() - started) / 60_000));
  const remainingMinutes = threshold.minutes - elapsedMinutes;
  const warnAt = Math.floor((threshold.minutes * threshold.warnPercent) / 100);

  const level: SlaLevel =
    elapsedMinutes >= threshold.minutes ? "overdue" : elapsedMinutes >= warnAt ? "due" : "waiting";

  return { level, elapsedMinutes, remainingMinutes };
}

export const SLA_LEVEL_LABEL: Record<SlaLevel, string> = {
  clear: "응답 완료",
  waiting: "응답 대기",
  due: "응답 임박",
  overdue: "응답 지연",
};

/** 경과·잔여 시간을 사람이 읽는 문구로. 분 단위 아래는 버린다. */
export function formatDuration(minutes: number): string {
  const abs = Math.abs(minutes);
  const days = Math.floor(abs / (60 * 24));
  const hours = Math.floor((abs % (60 * 24)) / 60);
  const mins = abs % 60;

  if (days > 0) return hours > 0 ? `${days}일 ${hours}시간` : `${days}일`;
  if (hours > 0) return mins > 0 ? `${hours}시간 ${mins}분` : `${hours}시간`;

  return `${mins}분`;
}

/** 인박스 정렬 — 지연이 위, 그다음 오래 기다린 순, 그다음 최근 대화 순(F-V-15). */
export function inboxOrder<T extends { sla: SlaState | null; lastMessageAt: string | null }>(
  rooms: readonly T[],
): T[] {
  const rank: Record<SlaLevel, number> = { overdue: 0, due: 1, waiting: 2, clear: 3 };

  return [...rooms].sort((a, b) => {
    const aRank = a.sla ? rank[a.sla.level] : 3;
    const bRank = b.sla ? rank[b.sla.level] : 3;
    if (aRank !== bRank) return aRank - bRank;

    const aWait = a.sla?.elapsedMinutes ?? -1;
    const bWait = b.sla?.elapsedMinutes ?? -1;
    if (aWait !== bWait) return bWait - aWait;

    return (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? "");
  });
}

// =============================================================================
// 첨부 (§3.10 chat-attachments, §7.6 ≤20MB)
// =============================================================================

/** §7.6 "업로드 전 클라이언트 리사이즈 ≤20MB". 서버도 같은 값으로 다시 막는다. */
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * 허용 MIME.
 *
 * 이미지와 PDF 로 좁힌다. 채팅에서 실제로 오가는 것은 견적서·시안·현장 사진이고,
 * 임의 실행 파일을 주고받을 이유가 없다. 목록을 넓히는 것은 언제든 되지만
 * 좁히는 것은 이미 올라간 파일 때문에 어렵다.
 */
export const ATTACHMENT_ALLOWED_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "application/pdf",
] as const;

export const ATTACHMENT_MAX_COUNT = 5;

export type AttachmentMeta = {
  /** chat-attachments 버킷의 **객체 키**. 서명 URL 을 저장하지 않는다(S4-01). */
  path: string;
  name: string;
  mime: string;
  size: number;
};

export type AttachmentRejection = { code: string; message: string };

/** 업로드 전 검증. 클라이언트와 서버가 같은 함수를 부른다. */
export function validateAttachment(file: {
  name: string;
  mime: string;
  size: number;
}): AttachmentRejection | null {
  if (file.size <= 0) {
    return { code: "CHAT_ATTACHMENT_EMPTY", message: "빈 파일은 보낼 수 없어요." };
  }

  if (file.size > ATTACHMENT_MAX_BYTES) {
    return {
      code: "CHAT_ATTACHMENT_TOO_LARGE",
      message: `파일은 ${Math.floor(ATTACHMENT_MAX_BYTES / 1024 / 1024)}MB까지 보낼 수 있어요.`,
    };
  }

  if (!(ATTACHMENT_ALLOWED_MIME as readonly string[]).includes(file.mime)) {
    return {
      code: "CHAT_ATTACHMENT_MIME",
      message: "이미지와 PDF만 보낼 수 있어요.",
    };
  }

  if (file.name.trim() === "") {
    return { code: "CHAT_ATTACHMENT_NAME", message: "파일 이름이 비어 있어요." };
  }

  return null;
}

/**
 * 저장 경로. `<roomId>/<messageNonce>/<안전한 파일명>`.
 *
 * **방 id 를 앞에 둔다** — 서버가 서명 URL 을 내주기 전에 경로에서 방을 읽어
 * 참여 여부를 확인할 수 있어야 한다(0021 이 storage.objects 정책 대신 서버 판정을
 * 택한 이유가 이것이다).
 *
 * 파일명은 ASCII 로 좁힌다. Storage 키에 한글·공백이 들어가면 서명 URL 인코딩이
 * 환경마다 갈린다.
 */
export function attachmentPath(roomId: string, nonce: string, fileName: string): string {
  const safe = fileName
    .normalize("NFKD")
    .replace(/[^\w.\-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-80);

  return `${roomId}/${nonce}/${safe === "" ? "file" : safe}`;
}

/** 경로에서 방 id 를 되읽는다. 서명 URL 발급 전 참여 판정에 쓴다. */
export function roomIdFromAttachmentPath(path: string): string | null {
  const head = path.split("/")[0] ?? "";

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(head)
    ? head
    : null;
}

/** 서명 URL 유효 시간(초). §3.10 이 계약 원문에 쓴 5분과 같은 값을 쓴다. */
export const ATTACHMENT_SIGNED_URL_SECONDS = 300;

// =============================================================================
// system 카드 (§3.7 "상담 일정 제안 카드는 system 메시지로 남긴다")
// =============================================================================

/**
 * system 메시지의 payload 는 `attachments` 가 아니라 **본문 자리에 실리지 않는다** —
 * 본문은 사람이 읽는 문장이고, 카드는 구조다. 그래서 카드 종류를 본문 앞에 붙는
 * 접두어로 인코딩하지 않고, `body` 에 사람이 읽을 문장을 두되 **종류는 별도 규약**
 * 으로 둔다.
 *
 * 지금 정의된 종류는 하나뿐이고 **이번 범위에서 만들지 않는다**(아래 참조).
 */
export const SYSTEM_CARD_KINDS = ["consultation_proposal"] as const;

export type SystemCardKind = (typeof SYSTEM_CARD_KINDS)[number];

/**
 * 상담 일정 제안 카드 — **S4-07 에서 연결했다.**
 *
 * F-C-27 은 "카드에서 바로 F-C-29 예약으로 연결" 이라고 쓴다. S4-04 시점에는 F-C-29
 * (상담·탐방 예약)가 없어 **그리는 쪽만** 만들고 버튼을 비활성으로 뒀다 — 없는 화면을
 * 가리키는 버튼은 "만들어 두고 켜지 않은 것" 이 아니라 **깨진 것을 켜 둔** 상태였기
 * 때문이다.
 *
 * 이제 `/consultations` 와 업체 상세의 예약 폼이 있으므로 카드가 그리로 보낸다.
 * 아래는 그때 갈라 둔 기록이며, `filledBy` 는 이미 채워졌다.
 *   · **그리는 쪽은 만든다.** `sender_type='system'` 메시지를 말풍선이 아니라 카드로
 *     그리는 것은 채팅 화면의 일이고, 안 만들면 S4-07 이 채팅 화면을 다시 뜯어야 한다.
 *   · **보내는 쪽은 만들지 않는다.** 존재할 수 없는 상담 id 를 참조하는 카드를 지어낼
 *     수 없다. 어떤 API 도 system 메시지를 만들지 않는다(0021 이 RLS 로도 막았다 —
 *     클라이언트는 sender_type='system' 을 INSERT 할 수 없다).
 *   · 화면은 **왜 비활성인지와 어느 태스크에서 채워지는지**를 그대로 적는다
 *     (S2-08·S3-11 이 세운 '못 채우는 자리' 표기 원칙).
 */
export const CONSULTATION_CARD = {
  kind: "consultation_proposal" as SystemCardKind,
  label: "상담 일정 제안",
  cta: "상담·탐방 예약하기",
  /** 업체 상세의 예약 폼으로 보낸다 — 실제로 시간대를 고르는 자리가 거기다. */
  href: (vendorId: string) => `/explore/${vendorId}#book`,
} as const;

/**
 * 업체가 채팅에서 상담을 제안할 때 남기는 문장.
 *
 * **일정을 카드에 박지 않는다.** 업체가 "이 시각으로 잡아 두었다" 고 쓰면 고객은
 * 확정된 것으로 읽는데, 실제 예약은 고객이 신청하고 업체가 승인해야 성립한다
 * (F-C-29). 그래서 카드는 **예약 화면으로 보내는 안내**이지 예약 그 자체가 아니다.
 */
export const CONSULTATION_PROPOSAL_BODY =
  "상담·탐방 일정을 잡아 보시겠어요? 아래에서 가능한 시간을 확인하고 신청하실 수 있어요.";

// =============================================================================
// 빠른 답변 템플릿 (§2.2 F-V-15)
// =============================================================================

/**
 * 업체가 자주 쓰는 첫 응답.
 *
 * **코드가 갖는다.** 업체별 커스텀 템플릿은 표가 하나 더 필요한데(§3 에 없다)
 * 그것은 이번 범위가 아니다 — 지금 필요한 것은 "응답 시간을 줄이는 것" 이고,
 * 고정 문안만으로도 그 목적은 달성된다. 업체별 문안은 수신 채널·담당자 설정과
 * 같은 성격이라 **S4-14(업체 알림·연동 설정)** 에서 표와 함께 다루는 것이 맞다.
 *
 * 문안 원칙 — **확정적 약속을 담지 않는다.** "가능합니다" 가 아니라 "확인해
 * 드릴게요" 다. 템플릿이 계약상 약속이 되면 업체가 보내지 않은 말에 묶인다.
 * 가격·할인 문구도 넣지 않는다(§2.2 — 유료 노출·리베이트 전제 금지와 같은 취지로,
 * 플랫폼이 업체의 가격 언어를 대신 쓰지 않는다).
 */
export const QUICK_REPLIES = [
  {
    key: "greeting",
    label: "첫 인사",
    body: "안녕하세요, 문의 주셔서 감사합니다. 확인 후 순차적으로 안내드릴게요.",
  },
  {
    key: "date_check",
    label: "날짜 확인",
    body: "원하시는 예식일과 예상 하객 수를 알려주시면 가능 여부를 확인해 드릴게요.",
  },
  {
    key: "estimate",
    label: "견적 안내",
    body: "등록된 총액 기준으로 안내드리고 있어요. 선택하신 옵션에 따라 달라지는 부분은 함께 정리해 드릴게요.",
  },
  {
    key: "visit",
    label: "방문 안내",
    body: "직접 보시면 결정에 도움이 되실 거예요. 편하신 날짜를 알려주시면 일정을 조율해 드릴게요.",
  },
  {
    key: "delay",
    label: "회신 지연 안내",
    body: "확인에 시간이 조금 걸리고 있어요. 늦어도 내일 중으로 답변드리겠습니다.",
  },
] as const satisfies readonly { key: string; label: string; body: string }[];

export type QuickReplyKey = (typeof QUICK_REPLIES)[number]["key"];

// =============================================================================
// 본문
// =============================================================================

/** §3.7 chat_messages_not_empty_chk 와 같은 판정. 화면이 먼저 막고 DB 가 다시 막는다. */
export const MESSAGE_MAX_LENGTH = 4000;

export function messageProblem(
  body: string,
  attachments: readonly AttachmentMeta[],
): string | null {
  const trimmed = body.trim();

  if (trimmed === "" && attachments.length === 0) return "보낼 내용이 없어요.";
  if (trimmed.length > MESSAGE_MAX_LENGTH) {
    return `메시지는 ${MESSAGE_MAX_LENGTH}자까지 보낼 수 있어요.`;
  }
  if (attachments.length > ATTACHMENT_MAX_COUNT) {
    return `첨부는 한 번에 ${ATTACHMENT_MAX_COUNT}개까지 보낼 수 있어요.`;
  }

  return null;
}

// =============================================================================
// 전송 계층 안내 (O-11 결정 — D-29 초안)
// =============================================================================

/**
 * 화면이 사용자에게 밝히는 사실.
 *
 * S3-05 가 장바구니에서 "상대 변경은 새로 고칠 때 보인다" 를 화면에 적은 것과 같은
 * 이유다 — 반영 시점을 사용자가 알아야 오해가 없다. 다만 채팅은 **연결됐을 때가
 * 기본**이므로 문장의 방향이 반대다.
 */
export const REALTIME_CONNECTED_NOTE = "실시간으로 연결돼 있어요.";
export const REALTIME_FALLBACK_NOTE = "실시간 연결이 끊겨 주기적으로 새로 확인하고 있어요.";

/** 소켓이 끊겼을 때 다시 조회하는 주기(ms). */
export const POLL_INTERVAL_MS = 15_000;

/** 소켓이 붙어 있어도 이 주기로 한 번씩 맞춰 본다 — 신호를 놓친 구간을 메운다. */
export const RECONCILE_INTERVAL_MS = 60_000;

// =============================================================================
// 목록 문구
// =============================================================================

export const ROOMS_EMPTY_TITLE = "아직 진행 중인 대화가 없어요";
export const ROOMS_EMPTY_DESCRIPTION =
  "업체 상세에서 '문의하기'를 누르면 대화가 시작돼요. 주고받은 내용은 그대로 남습니다.";
export const VENDOR_INBOX_EMPTY_TITLE = "아직 들어온 문의가 없어요";
export const VENDOR_INBOX_EMPTY_DESCRIPTION =
  "고객이 업체 상세에서 대화를 시작하면 여기에 쌓여요.";

/** 대화 목록의 미리보기. 회수된 메시지는 본문 대신 회수 문구를 보여준다. */
export function previewText(
  message: { body: string | null; retractedAt: string | null; attachmentCount: number } | null,
): string {
  if (message === null) return "아직 주고받은 메시지가 없어요.";
  if (message.retractedAt !== null) return RETRACTED_TEXT;

  const body = (message.body ?? "").trim();
  if (body !== "") return body;

  return message.attachmentCount > 0 ? `첨부 ${message.attachmentCount}개` : "";
}

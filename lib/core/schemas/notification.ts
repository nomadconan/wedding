import { z } from "zod";

/**
 * 알림 (S4-13 · 명세서 §2.1 F-C-21, §3.7, §4.2, §6.2 `/notifications`, D-23·D-28)
 *
 * 프레임워크를 모르는 순수 모듈이다. 발송 어댑터(`lib/notify`)와 화면이 같은 값을 쓴다.
 *
 * **여기서 다루는 것은 '무엇을 보냈는가' 가 아니라 '무엇을 보낼 자격이 있는가' 다.**
 * 본문은 저장하지 않는다(§7.3) — 아래 `NOTIFICATION_TEMPLATES` 가 그 이유와 대안이다.
 */

// =============================================================================
// 토픽 (§2.1 F-C-21)
// =============================================================================

/**
 * F-C-21 이 든 네 가지 — D-day 리마인더 · 일정 확정·변경 · 계약 단계 · 케어 메시지 —
 * 에 지금 실제로 보낼 수 있는 것(가격 변동·커플 초대)을 더했다.
 *
 * **아직 보내지 않는 토픽도 목록에 둔다.** 수신 설정은 "받을지 말지를 **미리**"
 * 정하는 화면이다. 토픽이 생긴 뒤에 설정 항목이 나타나면 사용자는 원치 않는 첫 알림을
 * 받고 나서야 끌 수 있다. 대신 화면이 **아직 보내지 않는다는 사실**을 함께 적는다
 * (S2-08·S3-11 에서 세운 원칙과 같다).
 */
export const NOTIFICATION_TOPICS = [
  "dday",
  "schedule",
  "contract",
  "care",
  "price_change",
  "couple_invite",
  "chat",
] as const;

export type NotificationTopic = (typeof NOTIFICATION_TOPICS)[number];

export const TOPIC_LABEL: Record<NotificationTopic, string> = {
  dday: "D-day 리마인더",
  schedule: "일정 확정·변경",
  contract: "계약 단계",
  care: "케어 메시지",
  price_change: "찜한 상품 가격 변동",
  couple_invite: "배우자 초대",
  chat: "업체 채팅 새 메시지",
};

export const TOPIC_DESCRIPTION: Record<NotificationTopic, string> = {
  dday: "예식일이 다가오면 남은 날짜를 알려드려요.",
  schedule: "상담·탐방 일정이 확정되거나 바뀌면 알려드려요.",
  contract: "계약 단계가 바뀌면 알려드려요.",
  care: "준비 단계에 맞춰 도움이 될 만한 안내를 보내드려요.",
  price_change: "찜한 상품의 가격이 바뀌면 알려드려요.",
  couple_invite: "배우자 초대와 연동 상태를 알려드려요.",
  chat: "업체와의 대화에 새 메시지가 오면 알려드려요.",
};

/**
 * **지금 실제로 발송하는 토픽.** 나머지는 설정만 받아 두고 아직 보내지 않는다.
 * 담당 태스크를 함께 적어 화면이 그대로 노출한다.
 */
export const TOPIC_PENDING: Partial<Record<NotificationTopic, string>> = {
  schedule: "S4-07",
  contract: "S5-04",
  care: "S7-08",
  price_change: "S3-06",
  couple_invite: "S3-01",
};

export function isTopicLive(topic: NotificationTopic): boolean {
  return TOPIC_PENDING[topic] === undefined;
}

// =============================================================================
// 채널
// =============================================================================

/**
 * §2.1 이 든 세 가지. **`in_app` 을 더했다** — 알림센터 화면 자체가 채널이고,
 * 외부 발송을 끄더라도 앱 안에서는 볼 수 있어야 한다. 외부 채널을 전부 끈 사용자에게
 * 아무 기록도 남기지 않으면 "안내한 적 없다" 가 되어 D-23 의 취지에 어긋난다.
 */
export const NOTIFICATION_CHANNELS = ["in_app", "email", "sms", "push"] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const CHANNEL_LABEL: Record<NotificationChannel, string> = {
  in_app: "앱 알림함",
  email: "이메일",
  sms: "문자·알림톡",
  push: "푸시",
};

/** 앱 알림함은 끌 수 없다. 끄면 증적을 남길 자리가 사라진다. */
export const ALWAYS_ON_CHANNELS: readonly NotificationChannel[] = ["in_app"];

/** 아직 계약하지 않은 발송 채널. 설정은 받아 두되 켜도 나가지 않는다(D-28). */
export const CHANNEL_PENDING: Partial<Record<NotificationChannel, string>> = {
  sms: "발송 대행 계약 전이라 아직 나가지 않아요.",
  push: "앱 출시 전이라 아직 나가지 않아요.",
};

// =============================================================================
// 수신 설정
// =============================================================================

export const ChannelFlagsSchema = z.record(z.enum(NOTIFICATION_CHANNELS), z.boolean());

export type ChannelFlags = Partial<Record<NotificationChannel, boolean>>;

/**
 * 이 사람에게 이 토픽·채널로 보내도 되는가.
 *
 * **기본값은 켜짐이다.** 설정 행이 없다는 것은 "아직 고르지 않았다" 이지 "거부했다" 가
 * 아니다. 다만 `in_app` 은 설정과 무관하게 항상 켜져 있다.
 */
export function isAllowed(
  topic: NotificationTopic,
  channel: NotificationChannel,
  prefs: ChannelFlags | null | undefined,
): boolean {
  if (ALWAYS_ON_CHANNELS.includes(channel)) return true;

  return prefs?.[channel] ?? true;
}

export const PrefsUpdateSchema = z.object({
  topic: z.enum(NOTIFICATION_TOPICS),
  channel: z.enum(NOTIFICATION_CHANNELS),
  enabled: z.boolean(),
});

export const NotificationActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("mark_read"), id: z.string().uuid() }),
  /**
   * 전체 읽음.
   *
   * **넣는다.** 알림은 쌓이는 목록이고 하나씩 누르게 하면 실제로는 아무도 누르지 않아
   * '안 읽음' 배지가 영구히 남는다. 그러면 읽음 기록 자체가 신호로서 죽는다.
   * 본인이 자기 열람을 표시하는 것이므로 증적을 훼손하지 않는다 — 서버가 채우는
   * `sent_at`·`delivered_at` 은 여전히 손댈 수 없다(S4-03 에서 권한으로 막았다).
   */
  z.object({ action: z.literal("mark_all_read") }),
  z.object({ action: z.literal("set_pref"), ...PrefsUpdateSchema.shape }),
]);

export type NotificationAction = z.infer<typeof NotificationActionSchema>;

// =============================================================================
// 본문 — 저장하지 않고 재구성한다 (§7.3)
// =============================================================================

/**
 * **알림 본문을 DB 에 저장하지 않는다.**
 *
 * §7.3 은 "`entity_events`·`notifications` 에 원문 내용을 저장하지 않는다. 참조 ID와
 * 해시만 남긴다" 고 정한다. 알림 본문에는 업체명·금액·예식일처럼 개인을 특정할 수 있는
 * 값이 그대로 들어가고, 그것을 남기면 알림함이 곧 개인정보 저장소가 된다.
 *
 * 대신 셋을 남긴다 —
 *  · `template_key`  어떤 문장 틀로 만들었는지
 *  · `payload_json`  그 틀에 끼울 **참조 ID와 숫자**만 (이름·주소 같은 식별정보 금지)
 *  · `body_hash`     보낸 시점 본문의 해시
 *
 * 화면은 **읽을 때마다 틀 + 참조로 다시 만든다.** 참조가 가리키는 값이 그 사이 바뀌면
 * 문장도 바뀌는데, 그게 문제가 되는 상황(분쟁)에서는 `body_hash` 로 "그때 보낸 문장과
 * 지금 만든 문장이 같은가" 를 판정할 수 있다. 본문을 통째로 보관하지 않고도 답할 수
 * 있는 질문은 여기까지이고, D-23 이 요구하는 것도 딱 여기까지다 — 재구성해야 하는
 * 사실은 "무엇을 보냈는가" 가 아니라 "언제 보냈고 도달했고 열람됐는가" 다.
 */
export const NOTIFICATION_TEMPLATES = {
  "dday.remind": {
    topic: "dday",
    /** `{days}` 만 받는다. 예식일 자체를 넣지 않는다 — 날짜는 개인을 특정하는 값이다. */
    render: (params: Record<string, unknown>) =>
      `예식일까지 ${Number(params.days ?? 0)}일 남았어요.`,
  },
  "price_change.drop": {
    topic: "price_change",
    render: (params: Record<string, unknown>) =>
      `찜한 상품 가격이 ${Number(params.rateBp ?? 0) / 100}% 내렸어요.`,
  },
  "couple_invite.accepted": {
    topic: "couple_invite",
    render: () => "배우자가 초대를 수락했어요. 이제 같은 정보를 함께 봅니다.",
  },
  /**
   * 채팅 새 메시지 (S4-04).
   *
   * **본문을 넣지 않는다.** 참조(roomId)만 담고 문장은 고정이다 — 메시지 내용을
   * payload 에 실으면 §7.3 의 "증적에 원문을 담지 않는다" 를 정면으로 어긴다.
   * 알림은 "왔다" 만 말하고, 무엇이 왔는지는 대화 화면이 보여준다.
   *
   * 업체 이름도 넣지 않는다. 공개 상호이긴 하나 `payload_json` 은 참조 ID와 숫자만
   * 담기로 한 자리이고(§7.3), 이름을 넣기 시작하면 어디까지가 식별정보인지 판단이
   * 호출부마다 갈린다.
   */
  "chat.new_message": {
    topic: "chat",
    render: () => "업체와의 대화에 새 메시지가 도착했어요.",
  },
} as const satisfies Record<
  string,
  { topic: NotificationTopic; render: (params: Record<string, unknown>) => string }
>;

export type TemplateKey = keyof typeof NOTIFICATION_TEMPLATES;

/** 저장된 참조로 문장을 다시 만든다. 틀이 사라졌으면 지어내지 않는다. */
export function renderBody(templateKey: string, params: Record<string, unknown>): string | null {
  const template = (NOTIFICATION_TEMPLATES as Record<string, { render: (p: Record<string, unknown>) => string }>)[
    templateKey
  ];

  return template ? template.render(params) : null;
}

export const BODY_UNAVAILABLE_TEXT =
  "이 알림의 문장 틀이 더 이상 없어 내용을 다시 만들 수 없어요. 보낸 시각과 상태는 그대로 남아 있습니다.";

// =============================================================================
// 멱등 · 재시도
// =============================================================================

/**
 * 같은 알림을 두 번 보내지 않기 위한 키.
 *
 * 배치는 실패하면 다시 돈다. 그때 어제 보낸 것을 또 보내면 사용자는 같은 말을 두 번
 * 듣고, 우리는 "몇 번 보냈는가" 를 셀 수 없게 된다. **키를 만드는 규칙을 코드가
 * 갖는다** — 호출부마다 다르게 지으면 중복 판정이 호출부 수만큼 갈린다.
 *
 * 규칙: `<템플릿>:<대상 id>:<기간 구분>`. 기간 구분은 "하루에 한 번" 처럼 같은 뜻의
 * 알림이 반복될 때 그 주기를 표현한다.
 */
export function dedupeKey(parts: {
  templateKey: string;
  subjectId: string;
  period?: string | null;
}): string {
  return [parts.templateKey, parts.subjectId, parts.period ?? "once"].join(":");
}

/**
 * 재시도 상한.
 *
 * 무한 재시도는 발송사 쪽 영구 오류(잘못된 주소 등)에서 큐를 영원히 막는다.
 * 상한에 닿으면 `failed_at` 을 남기고 멈춘다 — 실패도 기록이며, 조용히 사라지는 것보다
 * "여기서 멈췄다" 가 분쟁에서 쓸 수 있는 사실이다.
 */
export const MAX_SEND_ATTEMPTS = 3;

export function canRetry(attemptCount: number): boolean {
  return attemptCount < MAX_SEND_ATTEMPTS;
}

export const SEND_BLOCKED_BY_PREFS = "수신 설정에서 꺼 둔 채널입니다.";
export const SEND_CHANNEL_NOT_READY = "발송 대행 계약 전이라 아직 보낼 수 없습니다.";

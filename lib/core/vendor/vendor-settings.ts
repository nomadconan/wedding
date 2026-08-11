// 업체 알림·연동 설정 도메인 규칙 (S4-14 · 명세서 §2.2 F-V-14, §3.9, D-23 · D-28)
//
// **React/Next 를 import 하지 않는다**(CLAUDE.md §3.1). 화면·API·발송 경로가 같은
// 값을 쓴다.

import type { NotificationChannel, NotificationTopic } from "../schemas/notification";

// =============================================================================
// 수신 대상 (담당자 배정)
// =============================================================================

export const RECIPIENT_MODES = ["all", "assignee_first", "specific"] as const;

export type RecipientMode = (typeof RECIPIENT_MODES)[number];

export const RECIPIENT_MODE_LABEL: Record<RecipientMode, string> = {
  all: "멤버 전원",
  assignee_first: "담당자 우선",
  specific: "지정한 담당자만",
};

export const RECIPIENT_MODE_DESCRIPTION: Record<RecipientMode, string> = {
  all: "업체에 속한 모든 분이 알림을 받아요.",
  assignee_first: "담당자가 지정된 건은 그분만, 아직 없으면 전원이 받아요.",
  specific: "기본 담당자만 받아요. 담당자를 정하지 않으면 아무도 못 받으니 함께 지정해 주세요.",
};

/**
 * **라운드로빈을 두지 않는다.**
 *
 * 목적이 공평 분배가 아니라 **응답 책임**이기 때문이다 — 누가 받았는지 모르면
 * SLA 책임이 흐려진다(F-V-15). 그리고 라운드로빈은 마지막 배정자를 상태로 들고
 * 있어야 해서 동시 요청에서 어긋나는데, 담당자가 1~2명인 규모에서는 그 복잡도를
 * 살 이유가 없다. 필요해지면 그때 만든다.
 */
export const ROUND_ROBIN_NOTE =
  "순번 배정(라운드로빈)은 두지 않았어요. 누가 응답을 맡았는지가 분명해야 응답 기한도 뜻이 있어서예요.";

/**
 * 이 건의 알림을 받을 사람.
 *
 * **순수 함수다.** 멤버 목록과 설정을 받아 대상만 고른다 — DB 도 발송도 모른다.
 *
 * `specific` 인데 담당자가 없으면 **전원**으로 떨어진다. 아무도 못 받는 상태를
 * 만들지 않기 위해서다 — 알림이 안 가는 것은 설정 실수의 대가치고 너무 크다.
 */
export function resolveRecipients(input: {
  mode: RecipientMode;
  memberIds: readonly string[];
  /** 이 건에 배정된 담당자(채팅방·문의). 없으면 null. */
  assignedTo: string | null;
  /** 업체 기본 담당자. */
  defaultAssignee: string | null;
}): string[] {
  const members = [...new Set(input.memberIds)];

  if (input.mode === "all") return members;

  const target = input.assignedTo ?? input.defaultAssignee;

  if (target === null) return members;
  if (!members.includes(target)) return members;

  if (input.mode === "specific") return [target];

  // assignee_first — 배정된 사람이 있으면 그 사람만.
  return [target];
}

// =============================================================================
// 채널 (조직 층 + 개인 층)
// =============================================================================

/**
 * 조직 설정과 개인 설정을 합친다.
 *
 * **둘 다 통과해야 보낸다.** 조직이 "우리는 이메일로 받는다" 를 정하고, 개인이 그
 * 안에서 자기 채널을 끈다. 어느 한쪽만 두면 —
 *   · 개인만: 새 staff 가 들어올 때마다 아무도 못 받는 상태가 되고, 대표가 조직의
 *     수신 방식을 정할 수 없다.
 *   · 조직만: 개인이 야간 푸시를 끌 수 없다.
 *
 * **`in_app` 은 어느 층에서도 끄지 못한다**(0020 이 세운 규칙) — 앱 알림함을 끄면
 * 증적을 남길 자리가 사라진다.
 */
export function isVendorChannelAllowed(input: {
  channel: NotificationChannel;
  vendorFlags: Partial<Record<NotificationChannel, boolean>> | null | undefined;
  personalFlags: Partial<Record<NotificationChannel, boolean>> | null | undefined;
}): boolean {
  if (input.channel === "in_app") return true;

  // 설정 행이 없다는 것은 "아직 고르지 않았다" 이지 "거부했다" 가 아니다(0020 원칙).
  const org = input.vendorFlags?.[input.channel] ?? true;
  const personal = input.personalFlags?.[input.channel] ?? true;

  return org && personal;
}

/** 업체가 다루는 토픽. 소비자 전용 토픽(dday·care 등)은 업체 설정에 띄우지 않는다. */
export const VENDOR_TOPICS: readonly NotificationTopic[] = [
  "inquiry",
  "chat",
  "schedule",
  "contract",
  "vendor_invite",
];

export const VENDOR_TOPIC_LABEL: Partial<Record<NotificationTopic, string>> = {
  inquiry: "문의·견적 도착",
  chat: "채팅 새 메시지",
  schedule: "상담·탐방 일정",
  contract: "계약 단계",
  vendor_invite: "멤버 초대",
};

// =============================================================================
// 영업시간 (§2.2 F-V-14)
// =============================================================================

export type BusinessHour = {
  /** 0=일요일 … 6=토요일. `extract(dow from date)` 와 같은 규약(0007). */
  weekday: number;
  /** "HH:MM". */
  start: string;
  end: string;
};

/**
 * **영업시간은 SLA 판정에 쓰지 않는다.**
 *
 * 쓰면 **업체가 자기 SLA 기준을 자기가 정하는 구조**가 된다. 영업시간을 "화요일
 * 14~15시" 로 적으면 미응답 판정이 사실상 사라지는데, SLA 는 고객 보호 장치다
 * (F-V-15 미응답 에스컬레이션). 규제 대상이 규제 기준을 정하면 규제가 아니다 —
 * S4-12 가 "업체가 견적 없이 responded 로 바꾸면 SLA 시계를 스스로 끄는 셈" 이라
 * 막았던 것과 같은 문제다.
 *
 * 그렇다고 새벽 3시에 "지연됐습니다" 를 보내는 것도 맞지 않다. 그래서 **가른다** —
 *   · 판정 기준(고객의 권리) : 벽시계 그대로. 업체 설정이 못 움직인다.
 *   · 알림 시각(업체의 편의) : 영업시간을 존중해 다음 영업 시작으로 미룬다.
 *   · 고객 안내             : 영업시간을 화면에 적어 기대를 맞춘다.
 */
export const BUSINESS_HOURS_SLA_NOTE =
  "영업시간은 응답 기한 계산에는 쓰이지 않아요. 기한은 실제 시간으로 세고, 영업시간은 알림을 보내는 시각과 고객 안내에만 반영돼요.";

export const BUSINESS_HOURS_CUSTOMER_NOTE = (hours: readonly BusinessHour[]): string | null => {
  if (hours.length === 0) return null;

  return "영업시간 외에 보내신 문의는 다음 영업일에 답변이 올 수 있어요.";
};

const WEEKDAY_LABEL = ["일", "월", "화", "수", "목", "금", "토"] as const;

export function formatBusinessHours(hours: readonly BusinessHour[]): string[] {
  return [...hours]
    .sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start))
    .map((hour) => `${WEEKDAY_LABEL[hour.weekday]} ${hour.start}~${hour.end}`);
}

function minutesOf(time: string): number {
  const [hour, minute] = time.split(":");

  return Number(hour) * 60 + Number(minute);
}

/**
 * 지금이 영업시간인가.
 *
 * `offsetMinutes` 를 **호출자가 넘긴다** — 서버가 자기 타임존을 쓰면 배포 환경에
 * 따라 답이 달라진다(S2-06 이 세운 규칙, S4-07 슬롯 계산과 같은 방식).
 */
export function isWithinBusinessHours(
  hours: readonly BusinessHour[],
  at: Date,
  offsetMinutes: number,
): boolean {
  // 영업시간을 등록하지 않았으면 언제나 영업 중으로 본다 — 등록하지 않았다는 이유로
  // 알림을 미루면 설정을 안 한 업체가 손해를 본다.
  if (hours.length === 0) return true;

  const local = new Date(at.getTime() + offsetMinutes * 60_000);
  const weekday = local.getUTCDay();
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();

  return hours.some(
    (hour) =>
      hour.weekday === weekday &&
      minutes >= minutesOf(hour.start) &&
      minutes < minutesOf(hour.end),
  );
}

/**
 * 다음 영업 시작 시각. 영업시간 밖 알림을 여기까지 미룬다.
 *
 * 최대 8일을 훑는다 — 일주일을 다 돌아도 못 찾으면 등록이 잘못된 것이므로 null 을
 * 돌려주고 호출부가 즉시 발송으로 떨어진다(미루다 영영 안 가는 것보다 낫다).
 */
export function nextBusinessStart(
  hours: readonly BusinessHour[],
  from: Date,
  offsetMinutes: number,
): Date | null {
  if (hours.length === 0) return null;

  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const probe = new Date(from.getTime() + dayOffset * 86_400_000 + offsetMinutes * 60_000);
    const weekday = probe.getUTCDay();

    const candidates = hours
      .filter((hour) => hour.weekday === weekday)
      .map((hour) => minutesOf(hour.start))
      .sort((a, b) => a - b);

    for (const startMinutes of candidates) {
      // 그날 자정(현지) 의 UTC 시각 + 시작 분.
      const midnightLocal = Date.UTC(
        probe.getUTCFullYear(),
        probe.getUTCMonth(),
        probe.getUTCDate(),
      );
      const startUtc = midnightLocal - offsetMinutes * 60_000 + startMinutes * 60_000;

      if (startUtc > from.getTime()) return new Date(startUtc);
    }
  }

  return null;
}

export function businessHoursProblem(hours: readonly BusinessHour[]): string | null {
  for (const hour of hours) {
    if (hour.weekday < 0 || hour.weekday > 6) return "요일 값이 올바르지 않아요.";
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hour.start)) return "시작 시각 형식이 올바르지 않아요.";
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hour.end)) return "종료 시각 형식이 올바르지 않아요.";
    if (minutesOf(hour.end) <= minutesOf(hour.start)) {
      return "종료 시각은 시작 시각보다 뒤여야 해요.";
    }
  }

  return null;
}

// =============================================================================
// 템플릿 (S4-04 빠른 답변 · S4-12 견적 이월)
// =============================================================================

export const TEMPLATE_KINDS = ["quick_reply", "quote"] as const;

export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export const TEMPLATE_KIND_LABEL: Record<TemplateKind, string> = {
  quick_reply: "빠른 답변",
  quote: "견적 템플릿",
};

export const TEMPLATE_KIND_DESCRIPTION: Record<TemplateKind, string> = {
  quick_reply: "채팅에서 자주 쓰는 문장을 저장해 두고 한 번에 넣어요.",
  quote: "자주 내는 견적 구성을 저장해 두고 불러와요. 금액 상한과 항목 검증은 보낼 때 그대로 적용돼요.",
};

/**
 * 두 종류를 한 표에 둔 이유 — 모양은 다르지만 **수명주기·권한·화면이 같다.**
 * 업체가 저장해 두고 꺼내 쓰는 것이고, 만들고 지우는 화면이 하나다.
 *
 * 견적 템플릿은 **초안**이라 상품 참조에 FK 를 걸지 않았다(0026). 실제 견적은
 * S4-12 의 검증을 그대로 지나므로 무결성 경계는 거기고, 여기서 막으면 초안이
 * 상품 삭제를 막아서게 된다. 사라진 상품을 가리키는 템플릿은 **적용 시점에** 걸린다.
 */
export const TEMPLATE_DRAFT_NOTE =
  "견적 템플릿은 초안이에요. 보낼 때 등록된 상품·추가금인지, 금액이 상한 이하인지 다시 확인해요.";

export const TEMPLATE_STALE_NOTE = "저장할 때 쓰던 상품이 지금은 없어요. 다시 골라 주세요.";

// =============================================================================
// 화면 문구
// =============================================================================

export const SETTINGS_OWNER_ONLY_NOTE =
  "알림 수신 대상과 영업시간은 대표만 바꿀 수 있어요. 빠른 답변·견적 템플릿은 담당자도 만들 수 있어요.";
export const SETTINGS_EMPTY_HOURS = "영업시간을 등록하지 않아 알림을 바로 보내고 있어요.";

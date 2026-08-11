// 상담·탐방 예약 도메인 규칙 (S4-07 · 명세서 §2.1 F-C-29, §2.2 F-V-17, §3.4, §3.11,
// D-22 · D-23 · D-24)
//
// **React/Next 를 import 하지 않는다**(CLAUDE.md §3.1). 소비자 화면·업체 화면·API·
// 배치가 같은 값을 쓴다.
//
// §3.11 의 판정은 **사람의 재량이 아니라 규칙**이다. 그래서 그 규칙을 여기 순수
// 함수로 두고, 화면·API·배치가 전부 이 함수를 부른다. 판정이 세 곳에 흩어지면
// 세 곳이 서로 다른 답을 내는 날이 온다.

// =============================================================================
// 유형 (§3.4 값 집합)
// =============================================================================

export const CONSULTATION_TYPES = ["visit_consult", "venue_tour", "phone", "video"] as const;

export type ConsultationType = (typeof CONSULTATION_TYPES)[number];

export const TYPE_LABEL: Record<ConsultationType, string> = {
  visit_consult: "방문 상담",
  venue_tour: "현장 탐방",
  phone: "전화 상담",
  video: "화상 상담",
};

export const TYPE_DESCRIPTION: Record<ConsultationType, string> = {
  visit_consult: "업체를 방문해 상담해요.",
  venue_tour: "실제 공간을 둘러봐요.",
  phone: "전화로 이야기해요.",
  video: "화상으로 이야기해요.",
};

/**
 * 보증금을 받는 유형인가.
 *
 * §3.4: "**앞의 두 유형만 보증금 대상**이다". 방문·탐방은 업체가 자리를 비워 두고
 * 사람을 붙여 기다리므로 노쇼의 비용이 실재한다. 전화·화상은 그렇지 않다 —
 * 안 나타나도 업체가 잃는 것이 시간뿐이라 보증금을 받을 근거가 약하다.
 */
export function requiresDeposit(type: ConsultationType): boolean {
  return type === "visit_consult" || type === "venue_tour";
}

// =============================================================================
// 상태 (§3.4 값 집합)
// =============================================================================

export const CONSULTATION_STATUSES = [
  "requested",
  "approved",
  "rejected",
  "confirmed",
  "completed",
  "no_show",
  "cancelled",
  "disputed",
] as const;

export type ConsultationStatus = (typeof CONSULTATION_STATUSES)[number];

export const STATUS_LABEL: Record<ConsultationStatus, string> = {
  requested: "승인 대기",
  approved: "승인됨",
  rejected: "거절됨",
  confirmed: "확정",
  completed: "다녀옴",
  no_show: "불참",
  cancelled: "취소됨",
  disputed: "조율 중",
};

/** 고객 화면에 그대로 적는 문장. 업체에 대한 평가어를 쓰지 않는다(§2.3). */
export const STATUS_NOTE: Record<ConsultationStatus, string> = {
  requested: "업체의 승인을 기다리고 있어요.",
  approved: "업체가 승인했어요. 보증금 결제를 마치면 확정돼요.",
  rejected: "이번 일정은 어렵다고 답변이 왔어요.",
  confirmed: "일정이 확정됐어요.",
  completed: "다녀온 것으로 확인됐어요. 보증금은 환불돼요.",
  no_show: "참석하지 않은 것으로 확인됐어요.",
  cancelled: "취소된 예약이에요.",
  disputed: "양측 확인이 달라 운영자가 조율하고 있어요.",
};

/** 자리를 차지하는 상태. DB 의 EXCLUDE 조건과 같은 집합이어야 한다. */
export function holdsSlot(status: ConsultationStatus): boolean {
  return status === "approved" || status === "confirmed";
}

/** 아직 살아 있는 예약인가. 목록에서 위로 올릴지 판단한다. */
export function isLive(status: ConsultationStatus): boolean {
  return status === "requested" || status === "approved" || status === "confirmed";
}

// =============================================================================
// 이행 결과 (§3.4 값 집합)
// =============================================================================

export const CONSULTATION_OUTCOMES = [
  "fulfilled",
  "no_show_couple",
  "no_show_vendor",
  "undetermined",
] as const;

export type ConsultationOutcome = (typeof CONSULTATION_OUTCOMES)[number];

export const OUTCOME_LABEL: Record<ConsultationOutcome, string> = {
  fulfilled: "정상 진행",
  no_show_couple: "고객 불참",
  no_show_vendor: "업체 불참",
  undetermined: "확인 안 됨",
};

/** 당사자가 고를 수 있는 답. `undetermined` 는 **답이 아니라 결론**이라 뺀다. */
export const CONFIRM_CHOICES: readonly ConsultationOutcome[] = [
  "fulfilled",
  "no_show_couple",
  "no_show_vendor",
];

/** 고객 쪽 문구. 자기 불참을 고르는 선택지가 있어야 대조가 성립한다. */
export const COUPLE_CHOICE_LABEL: Record<string, string> = {
  fulfilled: "예정대로 만났어요",
  no_show_couple: "제가 가지 못했어요",
  no_show_vendor: "업체가 나오지 않았어요",
};

export const VENDOR_CHOICE_LABEL: Record<string, string> = {
  fulfilled: "예정대로 진행했어요",
  no_show_couple: "고객이 오지 않았어요",
  no_show_vendor: "저희가 응대하지 못했어요",
};

// =============================================================================
// §3.11 판정 — 이 파일의 핵심
// =============================================================================

/** 보증금을 어떻게 처리하는가. */
export type DepositAction = "refund" | "forfeit" | "dispute";

export type Verdict = {
  outcome: ConsultationOutcome;
  deposit: DepositAction;
  /** 다음 상태. */
  status: ConsultationStatus;
  /**
   * **왜 그렇게 정했는가.** `consultation_deposits.resolution_reason` 에 그대로
   * 들어간다 — 플랫폼의 재량이 아니라 §3.11 규칙이 정한 결과임을 남기기 위해서다
   * (D-24 중개자 지위).
   */
  reason: string;
};

/**
 * §3.11 판정 규칙표를 그대로 옮긴 것.
 *
 * | 상황 | 결과 |
 * |---|---|
 * | 양측 모두 이행 확인 | 전액 환불 |
 * | 양측 모두 고객 노쇼 확인 | 몰취 |
 * | 양측 모두 업체 노쇼 확인 | 전액 환불(+업체 페널티 검토) |
 * | 응답 불일치 | disputed → 운영자 조율 |
 * | **양측 모두 기한 내 무응답** | **환불**(기본값) |
 *
 * **무응답 기본값이 환불인 것이 이 규칙의 핵심 설계다**(§3.11 NOTE). 기본값이
 * 몰취면 업체는 아무것도 하지 않는 편이 유리해지고, 그러면 확인 절차 자체가
 * 형해화된다. 기본값은 **방치가 이득이 되지 않는 방향**으로 정한다.
 *
 * **한쪽만 답한 경우도 `disputed` 다.** §3.11 이 "한쪽이라도 기한 내 무응답이면"
 * 이라고 쓴다. 답한 쪽 말만 듣고 처리하면 답하지 않은 쪽의 권리가 사라지고,
 * 특히 업체만 답하고 고객이 못 봤을 때 몰취가 자동으로 일어난다.
 *
 * @param couple 고객의 주장. 기한 내 무응답이면 null.
 * @param vendor 업체의 주장. 기한 내 무응답이면 null.
 */
export function resolveVerdict(
  couple: ConsultationOutcome | null,
  vendor: ConsultationOutcome | null,
): Verdict {
  // 양측 무응답 — 기본값은 환불이다.
  if (couple === null && vendor === null) {
    return {
      outcome: "undetermined",
      deposit: "refund",
      status: "completed",
      reason:
        "both_no_response_default_refund: 양측이 기한 내에 확인하지 않아 규칙상 기본값인 환불로 처리했습니다.",
    };
  }

  // 한쪽만 응답 — 답하지 않은 쪽의 몫을 대신 판단하지 않는다.
  if (couple === null || vendor === null) {
    return {
      outcome: "undetermined",
      deposit: "dispute",
      status: "disputed",
      reason:
        "one_side_no_response: 한쪽만 확인해 자동 처리할 수 없습니다. 운영자 조율로 넘깁니다.",
    };
  }

  // 응답 불일치 — 증적 타임라인으로 판단해야 한다.
  if (couple !== vendor) {
    return {
      outcome: "undetermined",
      deposit: "dispute",
      status: "disputed",
      reason: "mismatch: 양측 확인이 서로 달라 운영자 조율로 넘깁니다.",
    };
  }

  if (couple === "fulfilled") {
    return {
      outcome: "fulfilled",
      deposit: "refund",
      status: "completed",
      reason: "both_fulfilled: 양측이 정상 진행을 확인해 보증금을 전액 환불합니다.",
    };
  }

  if (couple === "no_show_couple") {
    return {
      outcome: "no_show_couple",
      deposit: "forfeit",
      status: "no_show",
      reason: "both_no_show_couple: 양측이 고객 불참을 확인해 보증금을 업체에 지급합니다.",
    };
  }

  if (couple === "no_show_vendor") {
    return {
      outcome: "no_show_vendor",
      deposit: "refund",
      // 업체 귀책이라 고객은 불참한 적이 없다. 상태는 '불참' 이 아니다.
      status: "completed",
      reason:
        "both_no_show_vendor: 양측이 업체 불참을 확인해 보증금을 전액 환불합니다. 업체 페널티는 별도 검토 대상입니다.",
    };
  }

  // `undetermined` 를 양쪽이 골랐다면 그것은 답이 아니다.
  return {
    outcome: "undetermined",
    deposit: "dispute",
    status: "disputed",
    reason: "undetermined_response: 확인 내용이 결론을 내기에 부족해 운영자 조율로 넘깁니다.",
  };
}

// =============================================================================
// 취소 (§3.11 — N시간 전까지의 취소는 노쇼가 아니다)
// =============================================================================

/**
 * 지금 취소하면 무료인가.
 *
 * `freeCancelHours` 는 **`app_settings.consultation.free_cancel_hours`** 가 갖는다.
 * 값이 없으면 `null` 을 받고, 그러면 **무료 취소로 본다** — 기준을 정하지 않은 채
 * 고객에게 불리한 쪽으로 판정할 수는 없다(D-24: 플랫폼은 판정자가 아니다).
 */
export function isFreeCancel(
  scheduledAt: string,
  now: Date,
  freeCancelHours: number | null,
): boolean {
  if (freeCancelHours === null) return true;

  const scheduled = new Date(scheduledAt).getTime();
  if (Number.isNaN(scheduled)) return true;

  return scheduled - now.getTime() >= freeCancelHours * 3_600_000;
}

/** 취소 시 보증금을 어떻게 하는가. */
export function cancelVerdict(
  scheduledAt: string,
  now: Date,
  freeCancelHours: number | null,
): Verdict {
  if (isFreeCancel(scheduledAt, now, freeCancelHours)) {
    return {
      outcome: "fulfilled",
      deposit: "refund",
      status: "cancelled",
      reason: `free_cancel_window: 예정 시각 ${freeCancelHours ?? 0}시간 전까지의 취소라 노쇼가 아니며 전액 환불합니다.`,
    };
  }

  return {
    outcome: "no_show_couple",
    deposit: "forfeit",
    status: "cancelled",
    reason: `late_cancel: 무료 취소 기한(${freeCancelHours}시간 전)을 지나 취소해 노쇼와 같이 처리합니다.`,
  };
}

export const FREE_CANCEL_UNSET_NOTE =
  "무료 취소 기한이 설정되지 않아 지금은 언제 취소해도 전액 환불돼요.";

export function freeCancelDeadline(
  scheduledAt: string,
  freeCancelHours: number | null,
): string | null {
  if (freeCancelHours === null) return null;

  const scheduled = new Date(scheduledAt).getTime();
  if (Number.isNaN(scheduled)) return null;

  return new Date(scheduled - freeCancelHours * 3_600_000).toISOString();
}

/** 이행 확인 응답 기한. 예정 시각이 지난 뒤부터 센다. */
export function confirmDueAt(
  scheduledAt: string,
  confirmDueHours: number | null,
): string | null {
  if (confirmDueHours === null) return null;

  const scheduled = new Date(scheduledAt).getTime();
  if (Number.isNaN(scheduled)) return null;

  return new Date(scheduled + confirmDueHours * 3_600_000).toISOString();
}

// =============================================================================
// 슬롯 만들기 (F-C-29 — 업체가 등록한 가능 시간대에서 고른다)
// =============================================================================

export type AvailabilityRule = {
  /** 0=일요일 … 6=토요일. `extract(dow from date)` 와 같은 규약(0007). */
  weekday: number;
  /** "HH:MM" 또는 "HH:MM:SS". */
  startTime: string;
  endTime: string;
  slotMinutes: number;
};

export type Slot = {
  /** ISO. 그 날짜·시각의 시작. */
  startsAt: string;
  minutes: number;
  /** 이미 잡혀 있어 고를 수 없는가. */
  taken: boolean;
};

function minutesOf(time: string): number {
  const [hour, minute] = time.split(":");

  return Number(hour) * 60 + Number(minute);
}

/**
 * 그 날짜에 고를 수 있는 슬롯.
 *
 * **날짜와 시각을 UTC 로 다루지 않는다.** 업체가 등록한 "토요일 14:00" 은 한국 시각이고,
 * 그 값을 UTC 로 읽으면 9시간 어긋난다. 그래서 오프셋을 **호출자가 넘긴다** — 서버가
 * 자기 타임존을 쓰면 배포 환경에 따라 답이 달라진다(S2-06 이 '지금' 을 호출자에게
 * 넘긴 것과 같은 규칙).
 *
 * @param date       'YYYY-MM-DD'
 * @param offsetMinutes 그 지역의 UTC 오프셋(분). 한국은 540.
 * @param taken      이미 잡힌 예약의 시작 ISO 목록.
 */
export function slotsForDate(
  rules: readonly AvailabilityRule[],
  date: string,
  offsetMinutes: number,
  taken: readonly string[],
): Slot[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];

  // 그 지역 자정의 UTC 시각.
  const midnightUtc = Date.parse(`${date}T00:00:00Z`) - offsetMinutes * 60_000;
  if (Number.isNaN(midnightUtc)) return [];

  // 그 지역 기준 요일. UTC 요일을 쓰면 자정 근처에서 하루가 밀린다.
  const weekday = new Date(Date.parse(`${date}T00:00:00Z`)).getUTCDay();
  const takenSet = new Set(taken.map((value) => new Date(value).getTime()));

  const slots: Slot[] = [];

  for (const rule of rules) {
    if (rule.weekday !== weekday) continue;
    if (rule.slotMinutes <= 0) continue;

    const start = minutesOf(rule.startTime);
    const end = minutesOf(rule.endTime);

    for (let at = start; at + rule.slotMinutes <= end; at += rule.slotMinutes) {
      const startsAt = new Date(midnightUtc + at * 60_000);

      slots.push({
        startsAt: startsAt.toISOString(),
        minutes: rule.slotMinutes,
        taken: takenSet.has(startsAt.getTime()),
      });
    }
  }

  return slots.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/** 지난 시각의 슬롯은 고를 수 없다. */
export function isBookableSlot(slot: Slot, now: Date): boolean {
  return !slot.taken && new Date(slot.startsAt).getTime() > now.getTime();
}

// =============================================================================
// 보증금 문구 (D-24 — 플랫폼은 판정자가 아니라 조율자다)
// =============================================================================

/**
 * **보증금은 플랫폼의 벌금이 아니다.** 양측이 합의한 조건을 플랫폼이 잠시 보관했다가
 * §3.11 규칙대로 집행하는 것이다. 화면 문구가 이것을 흐리면 통신판매중개자의 지위와
 * 어긋나고(D-24), 사용자는 플랫폼이 재량으로 돈을 가져간다고 읽는다.
 */
export const DEPOSIT_NOTICE =
  "보증금은 웨딩클리어의 수수료가 아니라 예약을 지키기 위한 보관금이에요. 예정대로 다녀오시면 전액 돌려드리고, 처리 기준은 양측이 미리 합의한 규칙을 그대로 따릅니다.";

export const DEPOSIT_REFUND_NOTE = "다녀오신 것이 확인되면 전액 환불돼요.";
export const DEPOSIT_UNSET_NOTE =
  "보증금 금액이 설정되지 않아 지금은 보증금 없이 예약할 수 있어요.";

export const DEPOSIT_STATUSES = [
  "pending",
  "held",
  "refunded",
  "forfeited",
  "disputed",
  "failed",
] as const;

export type DepositStatus = (typeof DEPOSIT_STATUSES)[number];

export const DEPOSIT_STATUS_LABEL: Record<DepositStatus, string> = {
  pending: "결제 대기",
  held: "보관 중",
  refunded: "환불됨",
  forfeited: "업체에 지급됨",
  disputed: "조율 중",
  failed: "결제 실패",
};

// =============================================================================
// 화면 문구
// =============================================================================

export const CONSULTATIONS_EMPTY_TITLE = "아직 예약한 상담이 없어요";
export const CONSULTATIONS_EMPTY_DESCRIPTION =
  "업체 상세에서 상담·탐방을 신청하면 여기에서 일정을 관리할 수 있어요.";
export const VENDOR_CONSULTATIONS_EMPTY_TITLE = "아직 들어온 예약 신청이 없어요";
export const VENDOR_CONSULTATIONS_EMPTY_DESCRIPTION =
  "가능 시간대를 등록하면 고객이 그 안에서 날짜와 시간을 골라 신청해요.";
export const NO_AVAILABILITY_NOTE =
  "이 업체는 아직 상담 가능 시간을 등록하지 않았어요.";
export const CONFIRM_PROMPT = "예정된 상담이 어떻게 진행됐는지 알려주세요.";
export const CONFIRM_ONCE_NOTE =
  "한 번 제출하면 바꿀 수 없어요. 양측 답변이 다르면 운영자가 증적을 보고 조율해요.";
export const DISPUTE_QUEUE_NOTE =
  "운영자 조율 화면은 준비 중이에요(S4-10). 지금은 조율 대기 목록에 쌓이고 있어요.";

/** 3자 일정 공유(D-19). 플래너는 6단계라 아직 붙지 않는다. */
export const PLANNER_SHARE_PENDING = {
  label: "플래너와 일정 공유",
  reason: "플래너 마켓을 아직 만들지 않아 플래너를 지정할 수 없어요.",
  filledBy: "S6-02",
} as const;

/** 캘린더 동기화(F-C-29)는 S4-11 이다. 자리를 밝히고 지어내지 않는다. */
export const CALENDAR_SYNC_PENDING = {
  label: "캘린더 동기화",
  reason: "외부 캘린더 연동을 아직 만들지 않았어요.",
  filledBy: "S4-11",
} as const;

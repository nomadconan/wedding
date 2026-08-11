// 표준 문의·견적 도메인 규칙 (S4-12 · 명세서 §2.1 F-C-13, §2.2 F-V-07, §3.4, D-03·D-23)
//
// **React/Next 를 import 하지 않는다**(CLAUDE.md §3.1). 소비자 문의함·업체 인박스·
// API·배치가 같은 값을 쓴다.
//
// 여기 있는 것은 전부 **결정적 계산**이다. 금액에 LLM 을 쓰지 않는다는 원칙과 같은
// 이유로, "지금" 에 해당하는 값은 전부 호출자가 넘긴다(S2-06 에서 세운 규칙).

// =============================================================================
// 세 경로 (§2.1 — 왜 채팅·문의·문의게시판이 따로 있는가)
// =============================================================================

/**
 * 업체에 말을 거는 길이 셋이다. 화면이 이것을 설명하지 않으면 사용자는 아무 데나
 * 쓰고, 그러면 셋 다 제 역할을 못 한다.
 *
 *  · **문의·견적**(F-C-13)은 **1:N 이고 비교가 목적**이다. 같은 조건을 여러 업체에
 *    한 번에 보내고 **같은 양식의 견적**을 받아 나란히 놓는다. 이 서비스의 본체다.
 *  · **채팅**(F-C-27)은 **1:1 이고 조율이 목적**이다. 견적을 받은 뒤 세부를 맞추거나
 *    일정을 정할 때 쓴다. 실시간이라 상대가 지금 답하는 것을 기다리는 화면이다.
 *  · **문의게시판**(F-C-28)은 **공개가 목적**이다. 남들도 궁금해할 질문을 적으면
 *    다음 사람이 같은 질문을 반복하지 않는다. 그래서 유사 질문을 먼저 보여준다.
 *
 * 겹치는 것처럼 보이지만 **결과물이 다르다** — 문의는 견적서를, 채팅은 합의를,
 * 게시판은 공개 지식을 남긴다. 화면에 이 문장을 그대로 노출한다.
 */
export const CONTACT_PATHS = [
  {
    key: "inquiry",
    label: "문의·견적 요청",
    when: "여러 업체에서 같은 조건으로 견적을 받아 비교하고 싶을 때",
    result: "업체별 표준 견적서",
    href: "/inquiries",
  },
  {
    key: "chat",
    label: "1:1 채팅",
    when: "한 업체와 세부 조건이나 일정을 주고받을 때",
    result: "합의 내용이 남는 대화 기록",
    href: "/chat",
  },
  {
    key: "qna",
    label: "문의게시판",
    when: "다른 사람도 궁금해할 만한 질문을 남길 때",
    result: "공개 Q&A (비슷한 질문을 먼저 볼 수 있다)",
    href: null,
  },
] as const satisfies readonly {
  key: string;
  label: string;
  when: string;
  result: string;
  href: string | null;
}[];

export type ContactPathKey = (typeof CONTACT_PATHS)[number]["key"];

// =============================================================================
// 문의 상태
// =============================================================================

export const INQUIRY_STATUSES = ["open", "closed", "expired"] as const;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];

export const INQUIRY_STATUS_LABEL: Record<InquiryStatus, string> = {
  open: "받는 중",
  closed: "마감함",
  expired: "기간 지남",
};

/**
 * 업체별 응답 상태.
 *
 * **`pending` 과 `declined` 를 뭉치지 않는다.** "아직 답이 없다" 는 업체가 늦은
 * 것이고 "받지 않겠다" 는 업체가 답한 것이다. 고객 입장에서도 기다릴지 다른 곳을
 * 알아볼지가 갈리고, SLA 입장에서도 거절은 **응답이라 시계를 멈춘다.**
 */
export const TARGET_STATUSES = [
  "pending",
  "responded",
  "declined",
  "expired",
  "withdrawn",
] as const;
export type TargetStatus = (typeof TARGET_STATUSES)[number];

export const TARGET_STATUS_LABEL: Record<TargetStatus, string> = {
  pending: "답변 기다리는 중",
  responded: "견적 도착",
  declined: "받지 않음",
  expired: "기한 지남",
  withdrawn: "요청 거둠",
};

/** 고객 화면에 그대로 적는 문장. 상태를 평가어로 바꾸지 않는다(§2.3). */
export const TARGET_STATUS_NOTE: Record<TargetStatus, string> = {
  pending: "아직 답변이 오지 않았어요.",
  responded: "견적이 도착했어요.",
  declined: "이 업체는 이번 요청을 받지 않기로 했어요.",
  expired: "답변 기한이 지났어요.",
  withdrawn: "요청을 거두었어요.",
};

/** SLA 시계가 도는 상태인가. 거절도 만료도 아닌, 아직 기다리는 중일 때만이다. */
export function isAwaiting(status: TargetStatus): status is "pending" {
  return status === "pending";
}

/**
 * 거절 사유. **자유 텍스트가 아니라 코드다.**
 * 사유를 자유롭게 쓰게 하면 (가) 고객마다 다른 문장을 받아 비교가 안 되고,
 * (나) 업체가 다른 업체를 깎아내리는 말을 쓸 자리가 된다(§2.2).
 */
export const DECLINE_REASONS = [
  { code: "no_availability", label: "그날 예약이 이미 찼어요" },
  { code: "out_of_area", label: "서비스 지역이 아니에요" },
  { code: "capacity_mismatch", label: "하객 규모가 맞지 않아요" },
  { code: "category_mismatch", label: "요청하신 카테고리를 다루지 않아요" },
  { code: "other", label: "그 밖의 사정" },
] as const;

export type DeclineReasonCode = (typeof DECLINE_REASONS)[number]["code"];

export function declineReasonLabel(code: string): string {
  return DECLINE_REASONS.find((reason) => reason.code === code)?.label ?? "사유 없음";
}

// =============================================================================
// 응답 SLA (§2.2 F-V-07, §7.4 가변 파라미터)
// =============================================================================

/** 눈금. **값은 `app_settings.inquiry.sla_response_minutes` 가 갖는다**(0024). */
export type SlaThreshold = { minutes: number; warnPercent: number };

export type SlaLevel = "clear" | "waiting" | "due" | "overdue";

export type SlaState = {
  level: SlaLevel;
  elapsedMinutes: number | null;
  remainingMinutes: number | null;
};

export const SLA_UNSET_NOTE =
  "응답 기준 시간이 설정되지 않아 타이머를 표시하지 않아요. 운영 설정에서 정할 수 있어요.";

export const SLA_LEVEL_LABEL: Record<SlaLevel, string> = {
  clear: "응답 완료",
  waiting: "응답 대기",
  due: "응답 임박",
  overdue: "응답 지연",
};

/**
 * 지금 이 문의의 SLA 상태.
 *
 * 눈금이 없으면 `null` 이다 — 기본값을 지어내면 화면이 "지연" 이라고 단정하게 되고,
 * 그 단정은 업체에 대한 평가가 된다(§2.3 — 평가적 단정 금지).
 *
 * `status` 가 `pending` 이 아니면 시계는 멈춘 것이다. **거절도 응답이다.**
 *
 * @param sentAt 문의를 보낸 시각(`inquiry_targets.created_at`).
 * @param now    기준 시각. 호출자가 넘긴다 — 안에서 시계를 읽으면 테스트가 흔들린다.
 */
export function slaState(
  status: TargetStatus,
  sentAt: string | null,
  now: Date,
  threshold: SlaThreshold | null,
): SlaState | null {
  if (threshold === null || threshold.minutes <= 0) return null;

  if (!isAwaiting(status) || sentAt === null) {
    return { level: "clear", elapsedMinutes: null, remainingMinutes: null };
  }

  const started = new Date(sentAt).getTime();
  if (Number.isNaN(started)) return null;

  // 시계가 뒤로 간 경우(서버·클라이언트 시각차)는 0으로 클램프한다.
  const elapsedMinutes = Math.max(0, Math.floor((now.getTime() - started) / 60_000));
  const remainingMinutes = threshold.minutes - elapsedMinutes;
  const warnAt = Math.floor((threshold.minutes * threshold.warnPercent) / 100);

  const level: SlaLevel =
    elapsedMinutes >= threshold.minutes ? "overdue" : elapsedMinutes >= warnAt ? "due" : "waiting";

  return { level, elapsedMinutes, remainingMinutes };
}

/** 응답 기한. 문의를 만들 때 `inquiry_targets.sla_deadline` 에 박는다. */
export function slaDeadline(sentAt: string, threshold: SlaThreshold | null): string | null {
  if (threshold === null || threshold.minutes <= 0) return null;

  const base = new Date(sentAt).getTime();
  if (Number.isNaN(base)) return null;

  return new Date(base + threshold.minutes * 60_000).toISOString();
}

/** 경과·잔여 시간 표기. 분 아래는 버린다. */
export function formatDuration(minutes: number): string {
  const abs = Math.abs(minutes);
  const days = Math.floor(abs / (60 * 24));
  const hours = Math.floor((abs % (60 * 24)) / 60);
  const mins = abs % 60;

  if (days > 0) return hours > 0 ? `${days}일 ${hours}시간` : `${days}일`;
  if (hours > 0) return mins > 0 ? `${hours}시간 ${mins}분` : `${hours}시간`;

  return `${mins}분`;
}

/** 업체 인박스 정렬 — 지연이 위, 그다음 오래 기다린 순(F-V-07). */
export function inboxOrder<T extends { sla: SlaState | null; createdAt: string }>(
  targets: readonly T[],
): T[] {
  const rank: Record<SlaLevel, number> = { overdue: 0, due: 1, waiting: 2, clear: 3 };

  return [...targets].sort((a, b) => {
    const aRank = a.sla ? rank[a.sla.level] : 3;
    const bRank = b.sla ? rank[b.sla.level] : 3;
    if (aRank !== bRank) return aRank - bRank;

    const aWait = a.sla?.elapsedMinutes ?? -1;
    const bWait = b.sla?.elapsedMinutes ?? -1;
    if (aWait !== bWait) return bWait - aWait;

    return b.createdAt.localeCompare(a.createdAt);
  });
}

// =============================================================================
// 견적
// =============================================================================

export const QUOTE_STATUSES = [
  "draft",
  "sent",
  "accepted",
  "declined",
  "expired",
  "withdrawn",
] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const QUOTE_STATUS_LABEL: Record<QuoteStatus, string> = {
  draft: "작성 중",
  sent: "받은 견적",
  accepted: "수락함",
  declined: "거절함",
  expired: "기간 지남",
  withdrawn: "업체가 거둠",
};

/**
 * 견적이 지금 유효한가.
 *
 * **만료된 견적을 지우지 않는다.** 받은 적 있는 제안이 흔적 없이 사라지면 "그런 값을
 * 제시한 적 없다" 가 되고, 그건 분쟁에서 재구성해야 할 사실이다(D-23). 대신 화면이
 * 만료를 분명히 적고 수락 버튼을 닫는다.
 */
export function isExpired(
  quote: { status: QuoteStatus; validUntil: string | null },
  now: Date,
): boolean {
  if (quote.status === "expired") return true;
  if (quote.validUntil === null) return false;

  const until = new Date(quote.validUntil).getTime();
  if (Number.isNaN(until)) return false;

  return until <= now.getTime();
}

/** 고객이 지금 이 견적을 수락할 수 있는가. 만료·철회된 것은 못 받는다. */
export function canAccept(
  quote: { status: QuoteStatus; validUntil: string | null },
  now: Date,
): boolean {
  return quote.status === "sent" && !isExpired(quote, now);
}

export const QUOTE_EXPIRED_NOTE =
  "유효기간이 지난 견적이에요. 같은 조건이 필요하면 업체에 다시 요청해 주세요.";

// =============================================================================
// 상한 검증 — 자유 양식·할증 금지의 계산 부분 (F-V-07)
// =============================================================================

/**
 * 견적 한 줄.
 *
 * `capAmount` 는 **업체가 정하는 값이 아니다.** 옵션은 `product_options.price` 를 DB
 * 트리거가 강제하고, 본체는 `price_rules` 평가 결과를 서버가 넣는다(0024 주석 4번).
 */
export type QuoteLine = {
  itemType: "base" | "option";
  productId: string;
  productOptionId: string | null;
  /** 업체가 제시한 금액. */
  amount: number;
  /** 상한. 서버가 계산해 넣는다. */
  capAmount: number;
};

export type CapViolation = {
  code: string;
  message: string;
  productOptionId?: string | null;
};

/**
 * 상한을 넘겼는가.
 *
 * DB CHECK 가 최종 경계이고(`quote_items_cap_chk`), 이 함수는 **사용자에게 이유를
 * 말해 주기 위한 것**이다. DB 오류문을 화면에 그대로 내보낼 수는 없다.
 *
 * 금액은 전부 원 단위 정수다 — 부동소수점이 끼어들 자리가 없다.
 */
export function capViolations(lines: readonly QuoteLine[]): CapViolation[] {
  const violations: CapViolation[] = [];

  for (const line of lines) {
    if (!Number.isInteger(line.amount) || line.amount < 0) {
      violations.push({
        code: "QUOTE_AMOUNT_INVALID",
        message: "금액은 0 이상 정수여야 해요.",
        productOptionId: line.productOptionId,
      });

      continue;
    }

    if (line.amount > line.capAmount) {
      violations.push({
        code: "QUOTE_OVER_CAP",
        message:
          "등록된 가격과 프라이싱 룰로 계산한 상한을 넘을 수 없어요. 할증이 필요하면 프라이싱 룰로 먼저 등록해 주세요.",
        productOptionId: line.productOptionId,
      });
    }
  }

  return violations;
}

/** 총액은 줄의 합이다. 업체가 따로 적는 값이 아니다. */
export function sumLines(lines: readonly QuoteLine[]): { total: number; capTotal: number } {
  return lines.reduce(
    (acc, line) => ({ total: acc.total + line.amount, capTotal: acc.capTotal + line.capAmount }),
    { total: 0, capTotal: 0 },
  );
}

/** 상한 대비 할인율(bp). 상한이 0이면 비교 대상이 없으므로 0이다. */
export function discountRateBp(capTotal: number, total: number): number {
  if (capTotal <= 0) return 0;

  return Math.round(((capTotal - total) / capTotal) * 10_000);
}

export const OVER_CAP_NOTE =
  "고객이 탐색·장바구니에서 본 가격이 상한이에요. 그보다 비싼 견적은 보낼 수 없어요 — 성수기·주말 할증이 필요하면 프라이싱 룰로 등록하면 상한 자체가 올라갑니다.";

// =============================================================================
// 1:N 대상 (§2.1 — 최대 5개 업체 동시)
// =============================================================================

/**
 * 상한을 **코드에 박지 않는다**. `app_settings.inquiry.max_targets` 가 갖는다.
 * 이 함수는 그 값을 받아 판정만 한다.
 */
export function targetCountProblem(count: number, max: number | null): string | null {
  if (count === 0) return "문의할 업체를 한 곳 이상 골라 주세요.";
  if (max !== null && count > max) {
    return `한 번에 ${max}곳까지 문의할 수 있어요.`;
  }

  return null;
}

export const MAX_TARGETS_UNSET_NOTE =
  "동시 문의 상한이 설정되지 않아 한 곳씩만 보낼 수 있어요.";

/** 상한 설정이 없으면 1곳으로 좁힌다 — 값을 지어내는 대신 가장 보수적으로 군다. */
export function effectiveMaxTargets(configured: number | null): number {
  return configured === null || configured <= 0 ? 1 : configured;
}

// =============================================================================
// 요청 폼 (§2.1 — 날짜·하객수·필수 옵션)
// =============================================================================

export const INQUIRY_NOTE_MAX = 1000;

export function requestProblem(input: {
  eventDate: string | null;
  guestCount: number | null;
  categories: readonly string[];
  note: string | null;
}): string | null {
  if (input.eventDate === null) return "예식일을 정해 주세요. 날짜에 따라 가격이 달라져요.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.eventDate)) return "예식일 형식이 올바르지 않아요.";
  if (input.guestCount !== null && input.guestCount < 0) return "하객 수는 0 이상이어야 해요.";
  if (input.categories.length === 0) return "어떤 항목의 견적이 필요한지 골라 주세요.";
  if ((input.note ?? "").length > INQUIRY_NOTE_MAX) {
    return `추가 요청은 ${INQUIRY_NOTE_MAX}자까지 적을 수 있어요.`;
  }

  return null;
}

/**
 * 예식일이 지났는가. 지난 날짜로는 견적을 받을 수 없다.
 * `today` 는 호출자가 넘긴다(YYYY-MM-DD).
 */
export function isPastDate(eventDate: string, today: string): boolean {
  return eventDate < today;
}

// =============================================================================
// 화면 문구
// =============================================================================

export const INQUIRIES_EMPTY_TITLE = "아직 보낸 문의가 없어요";
export const INQUIRIES_EMPTY_DESCRIPTION =
  "같은 조건을 여러 업체에 한 번에 보내면 같은 양식의 견적을 받아 나란히 비교할 수 있어요.";
export const VENDOR_INQUIRIES_EMPTY_TITLE = "아직 들어온 문의가 없어요";
export const VENDOR_INQUIRIES_EMPTY_DESCRIPTION =
  "고객이 문의를 보내면 여기에 쌓이고, 응답 기한 타이머가 함께 표시돼요.";

/** 견적 폼이 왜 이렇게 생겼는지 업체에게 설명하는 문장. 화면에 상시 노출한다. */
export const STANDARD_QUOTE_NOTE =
  "견적 항목은 등록하신 상품과 추가금에서만 고를 수 있어요. 항목 이름과 금액 상한은 등록된 값에서 자동으로 채워지고, 상한보다 낮은 금액만 제시할 수 있어요.";

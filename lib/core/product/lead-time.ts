// 상품 리드타임과 주문 기한 (C-4b · 명세서 §2.2 F-V-03 확장 · §3.3 · §7.4)
//
// 프레임워크를 모르는 순수 모듈이다(CLAUDE.md §3.1).
//
// ── 왜 절대 날짜가 아닌가 ───────────────────────────────────────────────────
// 사용자 요구는 *"업체가 상품 등록 시 최종 데드라인 입력"* 이었다. 그대로 **날짜**로
// 받으면 **첫 커플에게만 맞는다** — 상품 하나를 여러 커플이 사고 예식일이 제각각이다.
// **상대 일수**로 받으면 `SCHEDULE_TEMPLATES.offsetDays` 와 **같은 단위**라 C-4a 가
// 손본 역산 장치가 그대로 붙는다(B-1 권고).
//
//   주문 기한 = 예식일 − lead_time_days
//
// ── 네 가지 상태를 하나로 뭉치지 않는다 ────────────────────────────────────
// 화면이 서로 다른 말을 해야 하기 때문이다. 특히 **"업체가 아직 안 정했다" 와
// "따로 기한이 없다" 는 다르고**, 둘 다 **0 이 아니다**(측정하지 않은 것을 0으로
// 표시하지 않는다 · D-99 계열).
//
//   · `deadline`      — 예식일도 리드타임도 있다. 날짜를 말할 수 있다.
//   · `no_wedding_date` — 커플이 예식일을 안 정했다. **우리 쪽 사정이 아니다.**
//   · `not_declared`  — 업체가 리드타임을 안 적었다. **업체 쪽 사정이다.**
//   · `no_deadline`   — 업체가 **0 이라고 적었다.** 값이 없는 것이 아니라 "따로 기한이
//                       없다" 는 **진술**이며, 근거 문구가 함께 온다.
//
// ── 값은 업체의 사실 진술이다 (D-224) ──────────────────────────────────────
// 그래서 **근거(`lead_time_note`)를 함께 받고** 화면이 그것을 같이 보인다. 근거 없이
// 숫자만 늘리면 알림이 일찍 가는 쪽으로 값이 부풀 수 있는데, **부풀린 이유를 고객이
// 읽는다**는 것이 그 유인을 누르는 장치다. 상한은 운영 파라미터
// (`products.max_lead_time_days`)이며 **값이 없으면 저장을 막는다** — 없는 상한을
// '무제한' 으로 읽지 않는다(D-49 가 AI 상한에서 세운 규칙과 같다).

export const LEAD_TIME_MAX_SETTING_KEY = "products.max_lead_time_days";

/** DB CHECK 이 막는 **상식 범위**. 운영 상한은 이보다 좁고 `app_settings` 가 갖는다. */
export const LEAD_TIME_SANITY_MAX_DAYS = 3650;

export const LEAD_TIME_NOTE_MAX = 200;

export type LeadTime = {
  /** 예식일로부터 며칠 전까지 주문해야 하는가. **0 은 "따로 기한 없음" 이라는 진술이다.** */
  days: number;
  /** 왜 그만큼 걸리는가. **값과 함께 온다** — 근거 없는 숫자는 확인할 방법이 없다. */
  note: string;
};

export type OrderDeadline =
  | { kind: "deadline"; date: string; leadTimeDays: number; note: string }
  | { kind: "no_deadline"; note: string }
  | { kind: "not_declared" }
  | { kind: "no_wedding_date"; leadTimeDays: number; note: string };

/**
 * 주문 기한을 역산한다.
 *
 * **예식일이 없으면 날짜를 지어내지 않는다.** 그때도 리드타임 자체는 말할 수 있다 —
 * "주문 후 제작에 30일" 은 예식일과 무관한 업체의 사실이고, 그것까지 감추면 고객은
 * 비교할 재료를 잃는다.
 */
export function orderDeadline(input: {
  weddingDate: string | null;
  leadTime: LeadTime | null;
}): OrderDeadline {
  const { weddingDate, leadTime } = input;

  if (leadTime === null) return { kind: "not_declared" };
  if (leadTime.days === 0) return { kind: "no_deadline", note: leadTime.note };

  if (weddingDate === null) {
    return { kind: "no_wedding_date", leadTimeDays: leadTime.days, note: leadTime.note };
  }

  const parsed = Date.parse(`${weddingDate}T00:00:00Z`);
  if (Number.isNaN(parsed)) {
    // 날짜를 못 읽으면 **틀린 날짜를 만들지 않는다.** 리드타임만 말한다.
    return { kind: "no_wedding_date", leadTimeDays: leadTime.days, note: leadTime.note };
  }

  return {
    kind: "deadline",
    date: new Date(parsed - leadTime.days * 86_400_000).toISOString().slice(0, 10),
    leadTimeDays: leadTime.days,
    note: leadTime.note,
  };
}

/** DB 행 두 칸을 도메인 값 하나로. **한쪽만 있으면 `null`** 이다(CHECK 이 막지만 조회도 안 믿는다). */
export function leadTimeOf(input: {
  days: number | null;
  note: string | null;
}): LeadTime | null {
  if (input.days === null || input.note === null) return null;

  return { days: input.days, note: input.note };
}

// =============================================================================
// 입력 검증 — API 와 화면이 **같은 함수**를 쓴다
// =============================================================================

export type LeadTimeProblem = { code: string; message: string };

export const LEAD_TIME_CAP_UNSET_MESSAGE =
  "주문 기한 상한이 아직 정해지지 않아 리드타임을 저장할 수 없습니다. 운영자에게 문의해 주세요.";

/**
 * 값과 근거가 함께 오는가, 상한 안인가.
 *
 * **`maxDays` 가 `null` 이면 저장을 막는다.** 운영 파라미터가 비어 있는데 통과시키면
 * 코드가 "상한 없음" 을 대신 답한 셈이 된다(§7.4 · CLAUDE.md §7.6). 리드타임을
 * **지우는 것**(둘 다 `null`)은 상한과 무관하므로 그때는 막지 않는다.
 */
export function leadTimeProblems(input: {
  days: number | null;
  note: string | null;
  maxDays: number | null;
}): LeadTimeProblem[] {
  const problems: LeadTimeProblem[] = [];
  const { days, note, maxDays } = input;
  const trimmedNote = note === null ? null : note.trim();

  // 지우는 요청은 통과한다 — 값이 사라지는 것은 상한과 상관없다.
  if (days === null && (trimmedNote === null || trimmedNote === "")) return problems;

  if (days === null) {
    problems.push({
      code: "LEAD_TIME_DAYS_REQUIRED",
      message: "주문 기한 근거만 적을 수는 없습니다. 며칠 전까지인지 함께 적어 주세요.",
    });
  }

  if (trimmedNote === null || trimmedNote === "") {
    problems.push({
      code: "LEAD_TIME_NOTE_REQUIRED",
      // 근거를 필수로 받는 것이 값이 부푸는 것을 누르는 장치다(D-224).
      message: "왜 그만큼 걸리는지 근거를 적어 주세요. 고객이 그 문장을 함께 봅니다.",
    });
  } else if (trimmedNote.length > LEAD_TIME_NOTE_MAX) {
    problems.push({
      code: "LEAD_TIME_NOTE_TOO_LONG",
      message: `주문 기한 근거는 ${LEAD_TIME_NOTE_MAX}자까지 쓸 수 있습니다.`,
    });
  }

  if (days !== null) {
    if (!Number.isInteger(days) || days < 0) {
      problems.push({
        code: "LEAD_TIME_DAYS_INVALID",
        message: "주문 기한은 0 이상의 일수로 적어 주세요.",
      });
    } else if (maxDays === null) {
      problems.push({ code: "LEAD_TIME_CAP_UNSET", message: LEAD_TIME_CAP_UNSET_MESSAGE });
    } else if (days > maxDays) {
      problems.push({
        code: "LEAD_TIME_TOO_LONG",
        message: `주문 기한은 ${maxDays}일까지 적을 수 있습니다.`,
      });
    }
  }

  return problems;
}

// =============================================================================
// 화면 문구 — **코드가 갖고 화면이 다시 쓰지 않는다**
// =============================================================================

/** 업체가 적은 정보임을 밝힌다. 플랫폼이 보증하는 것처럼 읽히면 안 된다(D-24 · §7.7). */
export const LEAD_TIME_SOURCE_NOTE = "업체가 등록한 정보예요. 실제 일정은 업체와 확인해 주세요.";

export const LEAD_TIME_NOT_DECLARED_NOTE =
  "이 상품은 업체가 주문 기한을 아직 등록하지 않았어요. 필요하면 문의로 물어봐 주세요.";

export const LEAD_TIME_NO_WEDDING_DATE_NOTE =
  "예식일을 정하면 언제까지 주문해야 하는지 날짜로 알려드려요.";

/** 화면 한 줄. **건수·날짜를 문장 안에서 만들고 화면이 조립하지 않는다.** */
export function orderDeadlineCaption(deadline: OrderDeadline): string {
  switch (deadline.kind) {
    case "deadline":
      return `예식일 ${deadline.leadTimeDays}일 전인 ${deadline.date}까지 주문하셔야 해요.`;
    case "no_deadline":
      return "따로 주문 기한이 없는 상품이에요.";
    case "no_wedding_date":
      return `주문 후 준비에 ${deadline.leadTimeDays}일이 걸려요.`;
    case "not_declared":
      return LEAD_TIME_NOT_DECLARED_NOTE;
  }
}

import { notYet, type MetricValue } from "../stats/metric";

/**
 * 소비자 홈 (S3-11 · 명세서 §2.1 F-C-04·F-C-05·F-C-25, §6.2 `/home`)
 *
 * 여러 기능의 **요약 화면**이라 자기 데이터가 없다. 하는 일은 두 가지다 —
 * 지금 아는 사실로 **다음 행동을 고르는 것**과, 아직 셀 수 없는 것을 **셀 수 없다고
 * 말하는 것**(S2-08 에서 세운 원칙: "0건" 과 "아직 측정하지 않음" 은 다르다).
 *
 * 프레임워크를 모르는 순수 모듈이다.
 */

// =============================================================================
// D-day
// =============================================================================

/**
 * 남은 날짜. **오늘을 인자로 받는다.**
 *
 * 서버가 '오늘' 을 마음대로 정하면 같은 요청이 시각에 따라 다른 답을 낸다
 * (S2-06·S3-03 에서 세운 규칙과 같다).
 */
export function dDay(today: string, weddingDate: string): number {
  const from = Date.parse(`${today}T00:00:00Z`);
  const to = Date.parse(`${weddingDate}T00:00:00Z`);

  if (Number.isNaN(from) || Number.isNaN(to)) {
    throw new RangeError("날짜는 YYYY-MM-DD 형식이어야 합니다.");
  }

  return Math.round((to - from) / 86_400_000);
}

export type DDayState =
  | { kind: "upcoming"; days: number }
  | { kind: "today" }
  | { kind: "passed"; days: number }
  /** 예식일을 아직 정하지 않았다. **0일이 아니다.** */
  | { kind: "undecided" };

export function dDayState(today: string, weddingDate: string | null): DDayState {
  if (weddingDate === null) return { kind: "undecided" };

  const days = dDay(today, weddingDate);

  if (days === 0) return { kind: "today" };

  return days > 0 ? { kind: "upcoming", days } : { kind: "passed", days: -days };
}

// =============================================================================
// 지금 할 일
// =============================================================================

/**
 * 홈이 제안하는 다음 행동.
 *
 * **확인 가능한 사실에서만 만든다.** "업체를 더 둘러보세요" 같은 항상 참인 권유는
 * 넣지 않는다 — 언제나 떠 있는 할 일은 할 일이 아니라 배경이 된다.
 */
export type HomeTaskCode =
  | "finish_onboarding"
  | "decide_wedding_date"
  | "invite_partner"
  | "add_to_cart"
  | "compare_cart";

export type HomeTask = {
  code: HomeTaskCode;
  title: string;
  description: string;
  href: string;
  /** 작을수록 먼저. 같은 값이 나오지 않도록 코드마다 다르게 둔다. */
  priority: number;
};

/**
 * 우선순위는 **막힌 것부터**다.
 *
 * 온보딩을 마치지 않으면 다른 어떤 제안도 성립하지 않는다(커플도 장바구니도 커플
 * 레코드 위에 선다). 그다음이 예식일 — 날짜가 없으면 리드타임 할인도 예약 가능일도
 * 볼 수 없어 탐색의 절반이 잠긴다. 배우자 연동은 되돌릴 수 없는 결정을 함께
 * 내리기 위한 것이라 담기 전에 오는 편이 낫다.
 */
const TASK_CATALOG: Record<HomeTaskCode, Omit<HomeTask, "code">> = {
  finish_onboarding: {
    title: "온보딩을 마쳐 주세요",
    description: "6가지만 답하면 예산·일정을 함께 볼 수 있어요.",
    href: "/onboarding",
    priority: 10,
  },
  decide_wedding_date: {
    title: "예식일을 정해 보세요",
    description: "날짜가 있으면 그날 기준 가격과 남은 자리를 볼 수 있어요.",
    href: "/onboarding",
    priority: 20,
  },
  invite_partner: {
    title: "배우자를 초대해 보세요",
    description: "같은 장바구니와 찜을 함께 보고 누가 담았는지도 남아요.",
    href: "/onboarding",
    priority: 30,
  },
  add_to_cart: {
    title: "마음에 드는 곳을 담아 보세요",
    description: "담아 두면 총액을 한눈에 견줄 수 있어요.",
    href: "/explore",
    priority: 40,
  },
  compare_cart: {
    title: "담은 것을 나란히 견줘 보세요",
    description: "실총액 기준으로 정렬해 보여드려요.",
    href: "/explore/compare",
    priority: 50,
  },
};

export type HomeFacts = {
  onboardingComplete: boolean;
  weddingDateDecided: boolean;
  partnerLinked: boolean;
  cartItemCount: number;
  /** 비교는 담은 것이 둘 이상일 때만 의미가 있다. */
  comparableCount: number;
};

/** §6.2 는 "다음 할 일 **3건**" 이다. 더 보여 주면 목록이 되고 우선순위가 사라진다. */
export const HOME_TASK_LIMIT = 3;

export function homeTasks(facts: HomeFacts): HomeTask[] {
  const codes: HomeTaskCode[] = [];

  if (!facts.onboardingComplete) codes.push("finish_onboarding");
  // 온보딩을 마쳤는데도 날짜가 없다면 '미정' 을 고른 것이다 — 다시 정해 볼 수 있게 권한다.
  if (facts.onboardingComplete && !facts.weddingDateDecided) codes.push("decide_wedding_date");
  if (!facts.partnerLinked) codes.push("invite_partner");
  if (facts.cartItemCount === 0) codes.push("add_to_cart");
  if (facts.comparableCount >= 2) codes.push("compare_cart");

  return codes
    .map((code) => ({ code, ...TASK_CATALOG[code] }))
    .sort((a, b) => a.priority - b.priority)
    .slice(0, HOME_TASK_LIMIT);
}

export const HOME_ALL_DONE_NOTE = "지금 급한 일은 없어요. 천천히 둘러보셔도 됩니다.";

// =============================================================================
// 아직 채울 수 없는 자리 (§6.2 의 나머지 요소)
// =============================================================================

/**
 * §6.2 `/home` 이 요구하지만 **아직 만들 수 없는 것**들.
 *
 * 자리를 지우지 않고 남기되 숫자를 지어내지 않는다. 0으로 적으면 "할 일이 0건"·
 * "예산 0원" 으로 읽히는데, 실제로는 **셀 수단이 없는 것**이고 그 둘은 사용자가
 * 내릴 판단이 다르다(S2-08 과 같은 원칙).
 *
 * `filledBy` 는 커버리지 표의 태스크 ID 다. 화면이 그대로 노출한다.
 */
export const HOME_PENDING_SECTIONS = [
  {
    key: "budget",
    label: "예산 게이지",
    reason: "예산 배분·추적을 아직 만들지 않았습니다.",
    filledBy: "S7-07",
  },
  // '최근 대화' 는 S4-04 가, **'AI 플래너 클리어' 는 S7-06 이**, **'최근 검토 리포트' 는
  // S7-03 이**, **'다음 할 일' 은 S7-08 이** 채웠다. 자리를 지우지 않고 목록에서 뺐다 —
  // 남겨 두면 화면이 "아직 못 만들었다" 고 거짓을 말한다.
] as const satisfies readonly { key: string; label: string; reason: string; filledBy: string }[];

export type HomePendingKey = (typeof HOME_PENDING_SECTIONS)[number]["key"];

/** 아직 못 세는 지표를 `MetricValue` 로 만든다. 화면은 `MetricTile` 로 그대로 그린다. */
export function pendingMetric(key: HomePendingKey): MetricValue<number> {
  const section = HOME_PENDING_SECTIONS.find((item) => item.key === key);

  if (section === undefined) throw new RangeError(`알 수 없는 항목입니다: ${key}`);

  return notYet(section.reason, section.filledBy);
}

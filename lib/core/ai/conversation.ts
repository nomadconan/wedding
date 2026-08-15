import { EMPTY_GUIDANCE, type ToolResult } from "./empty";
import { IRREVERSIBLE_ACTIONS, suggestScreen, toolSpec } from "./tools";

/**
 * 대화 도메인 (S7-06 · 명세서 §5.6 · §6.2 `/planner`)
 *
 * **화면에 뜨는 문장을 모델이 쓰지 않는 자리**를 여기 모았다. 툴 결과 카드의 제목·
 * 라벨·빈 결과 안내는 전부 코드가 갖는다 — 모델이 카드까지 쓰면 "툴이 돌려준 값" 과
 * "모델이 그 값에 대해 한 말" 이 같은 상자 안에서 구분되지 않는다. 카드는 **조회
 * 결과 그 자체**여야 하고, 모델의 말은 카드 밖 본문에만 있어야 한다.
 *
 * 프레임워크를 모르는 순수 모듈이다.
 */

// =============================================================================
// 메시지
// =============================================================================

export const PLANNER_ROLES = ["user", "assistant"] as const;
export type PlannerRole = (typeof PLANNER_ROLES)[number];

export const PLANNER_MESSAGE_MAX_LENGTH = 1_000;

/** 화면이 그대로 그리는 한 줄. */
export type PlannerMessageView = {
  id: string;
  role: PlannerRole;
  text: string;
  createdAt: string;
  cards: ToolCard[];
};

export function messageProblem(text: string): string | null {
  const trimmed = text.trim();

  if (trimmed === "") return "하고 싶은 말을 적어 주세요.";
  if (trimmed.length > PLANNER_MESSAGE_MAX_LENGTH) {
    return `${PLANNER_MESSAGE_MAX_LENGTH}자까지 보낼 수 있어요.`;
  }

  return null;
}

/**
 * 대화 제목.
 *
 * 첫 사용자 메시지의 앞부분을 쓴다. **요약하지 않는다** — 요약하려면 모델을 한 번 더
 * 불러야 하고, 그 비용은 목록 한 줄을 위해 치를 것이 아니다. 자를 때 말줄임을 붙여
 * 잘렸다는 사실을 숨기지 않는다.
 */
export const CONVERSATION_TITLE_MAX_LENGTH = 30;

export function conversationTitle(firstMessage: string): string {
  const flat = firstMessage.replace(/\s+/g, " ").trim();

  if (flat === "") return "새 대화";
  if (flat.length <= CONVERSATION_TITLE_MAX_LENGTH) return flat;

  return `${flat.slice(0, CONVERSATION_TITLE_MAX_LENGTH)}…`;
}

// =============================================================================
// 툴 결과 카드 (§6.2 "툴 결과 카드")
// =============================================================================

export type ToolCard = {
  tool: string;
  title: string;
  status: ToolResult["status"];
  /** 라벨·값 쌍. **값은 툴 결과에서 그대로 온다.** */
  rows: { label: string; value: string }[];
  /**
   * 순서를 정한 기준. 있으면 화면이 배지로 그린다(D-25 · §2.2).
   *
   * 코드와 라벨을 **함께** 싣는다. 업체 랭킹(`condition_fit`)과 플래너 마켓 정렬
   * (`contracts`·`career`)은 서로 다른 어휘라 한 사전에 넣을 수 없고, 화면이 코드로
   * 라벨을 찾으면 그 사전을 한 벌 더 만들게 된다(`/planners` 도 라벨을 그대로 그린다).
   */
  rankingCode: string | null;
  rankingLabel: string | null;
  /** 빈 결과·쓸 수 없음일 때 화면이 적는 문장. */
  notice: string | null;
  /** 다음에 할 수 있는 일. 빈 결과를 사과로 끝내지 않는다(§5.6). */
  nextAction: string | null;
};

const CARD_TITLE: Record<string, string> = {
  get_couple_context: "우리 준비 상황",
  search_price_index: "참가격 분포",
  search_vendors: "조건에 맞는 업체",
  get_vendor_availability: "그날 자리와 가격",
  get_cart_summary: "장바구니 요약",
  compare_carts: "장바구니 비교",
  simulate_penalty: "위약금 비교",
  preview_payment_schedule: "분할 회차 미리보기",
  explain_planner_fee: "플래너 이용 시 금액",
  search_planners: "플래너 목록",
  list_coupons: "보유 쿠폰",
};

function krw(value: unknown): string {
  return typeof value === "number" ? `${value.toLocaleString("ko-KR")}원` : "확인되지 않음";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

/**
 * 툴 결과를 카드로 바꾼다.
 *
 * **툴마다 줄을 손으로 고른다.** 결과 JSON 을 통째로 펼치면 내부 식별자·미가공 코드가
 * 화면에 나가고, 그건 사용자가 읽을 것이 아니다. 여기 없는 필드는 카드에 안 뜬다 —
 * 모델은 그 값을 본문에서 말할 수 있고(후처리가 허용한다) 카드에는 안 나온다.
 */
export function toolCard(
  name: string,
  result: ToolResult,
  rankingBasis: readonly { code: string; label: string }[] = [],
): ToolCard {
  const title = CARD_TITLE[name] ?? toolSpec(name)?.summary ?? name;
  const rankingCode = rankingBasis[0]?.code ?? null;
  const rankingLabel = rankingBasis[0]?.label ?? null;

  if (result.status === "unavailable") {
    return {
      tool: name,
      title,
      status: result.status,
      rows: [],
      rankingCode: null,
      rankingLabel: null,
      notice: result.say,
      nextAction: null,
    };
  }

  if (result.status === "empty") {
    return {
      tool: name,
      title,
      status: result.status,
      rows: [],
      rankingCode,
      rankingLabel,
      notice: EMPTY_GUIDANCE[result.reason].say,
      nextAction: EMPTY_GUIDANCE[result.reason].nextAction,
    };
  }

  return {
    tool: name,
    title,
    status: "ok",
    rows: rowsOf(name, asRecord(result.data)),
    rankingCode,
    rankingLabel,
    notice: null,
    nextAction: null,
  };
}

function rowsOf(name: string, data: Record<string, unknown>): { label: string; value: string }[] {
  if (name === "get_couple_context") {
    const dDay = asRecord(data.dDay);

    return [
      {
        label: "예식일",
        // **미정은 0일이 아니다.** 상태를 그대로 읽어 문장으로 만든다.
        value:
          dDay.kind === "undecided"
            ? "아직 정하지 않았어요"
            : dDay.kind === "today"
              ? "오늘이에요"
              : dDay.kind === "passed"
                ? `${String(dDay.days)}일 지났어요`
                : `${String(dDay.days)}일 남았어요`,
      },
      { label: "지역", value: (data.regionCode as string) ?? "미정" },
      {
        label: "예산",
        value: data.budgetDecided === true ? krw(data.totalBudget) : "아직 정하지 않았어요",
      },
      { label: "배우자 연동", value: data.partnerLinked === true ? "연동됨" : "아직" },
    ];
  }

  if (name === "search_price_index") {
    return [
      { label: "표본", value: `${String(data.sampleSize)}건` },
      { label: "하위 25%", value: krw(data.p25) },
      { label: "중앙값", value: krw(data.p50) },
      { label: "상위 25%", value: krw(data.p75) },
      { label: "출처", value: (data.source as string) ?? "출처를 모릅니다" },
    ];
  }

  if (name === "search_vendors") {
    return asArray(data.rows).map((row) => ({
      label: `${String(row.vendorName)} · ${String(row.productName)}`,
      value: krw(row.basePrice),
    }));
  }

  if (name === "get_vendor_availability") {
    return asArray(data.products).map((product) => ({
      label: String(product.productName),
      value: `${krw(product.finalPrice ?? product.basePrice)} · ${availabilityLabel(product.availability)}`,
    }));
  }

  if (name === "get_cart_summary") {
    return asArray(data.carts).map((cart) => ({
      label: String(cart.label),
      value: cart.total === null ? "총액을 확인할 수 없어요" : krw(cart.total),
    }));
  }

  if (name === "compare_carts") {
    return asArray(data.columns).map((column) => ({
      label: String(column.label),
      value: krw(asRecord(column.total).value ?? column.total),
    }));
  }

  if (name === "simulate_penalty") {
    const standard = asRecord(data.standard);
    const contract = asRecord(data.contract);

    return [
      { label: "적용 구간", value: String(asRecord(data.band).label ?? "") },
      { label: "기준 위약금", value: krw(standard.penalty) },
      { label: "계약서 기준", value: krw(contract.penalty) },
      { label: "차이", value: krw(data.excessPenalty) },
    ];
  }

  if (name === "preview_payment_schedule") {
    return asArray(data.installments).map((installment) => ({
      label: `${String(installment.seq)}회차`,
      value: krw(installment.amount),
    }));
  }

  if (name === "explain_planner_fee") {
    return [
      { label: "요율", value: `${String(data.feeRateBp)}bp` },
      { label: "붙는 금액", value: krw(data.feeAmount) },
      { label: "안 쓰면", value: krw(data.notSelectedFeeAmount) },
    ];
  }

  if (name === "search_planners") {
    return asArray(data.planners).map((planner) => ({
      label: String(planner.headline),
      value: `경력 ${String(planner.careerYears)}년`,
    }));
  }

  if (name === "list_coupons") {
    return asArray(data.coupons).map((coupon) => ({
      label: String(coupon.name),
      value:
        coupon.usable === true
          ? krw(coupon.discountAmount)
          : // **못 쓰는 사유를 감추지 않는다**(F-C-36).
            String(coupon.blockDetail ?? "지금은 쓸 수 없어요"),
    }));
  }

  return [];
}

function availabilityLabel(kind: unknown): string {
  if (kind === "available") return "자리 있음";
  if (kind === "full") return "찼음";
  if (kind === "blocked") return "받지 않음";

  return "확인되지 않음";
}

// =============================================================================
// 되돌릴 수 없는 행위를 물었을 때 (§5.6)
// =============================================================================

/**
 * 사용자가 결제·서명 같은 것을 대화로 시키려 하는가.
 *
 * **모델에게만 맡기지 않는다.** 프롬프트가 금지해도 지켜지지 않을 수 있고, 그때의
 * 증상은 되돌릴 수 없는 행위다. 입력에서 먼저 알아채고 **툴 없이 안내로 답한다.**
 * 이 판정은 좁게 잡는다 — 넓게 잡으면 "결제 방법이 궁금해요" 같은 질문까지 막힌다.
 */
const ACTION_INTENT: { code: string; pattern: RegExp }[] = [
  { code: "payment", pattern: /(결제|입금|송금)\s*(해\s*줘|해줘|해\s*주세요|진행해|해\s*달라)/ },
  { code: "contract_sign", pattern: /(서명|사인|계약서에\s*서명)\s*(해\s*줘|해줘|해\s*주세요|대신)/ },
  { code: "booking_confirm", pattern: /(예약|예약금)\s*(확정해|확정\s*해\s*줘|잡아\s*줘|걸어\s*줘)/ },
  { code: "contract_cancel", pattern: /(계약|예약)\s*(취소해|해지해|취소\s*해\s*줘|해지\s*해\s*줘)/ },
  { code: "coupon_redeem", pattern: /쿠폰\s*(써\s*줘|사용해|적용해\s*줘|써줘)/ },
  { code: "escrow_release", pattern: /(에스크로|보관금|잔금)\s*(풀어|지급해|내보내)/ },
  { code: "settlement_payout", pattern: /정산\s*(해\s*줘|지급해|실행해)/ },
];

export type IrreversibleRequest = {
  code: string;
  label: string;
  /** 화면이 그대로 보여 줄 안내. 링크가 없으면 담당 태스크를 말한다(S7-20 · D-47). */
  notice: string;
  route: string | null;
};

export function detectIrreversibleRequest(text: string): IrreversibleRequest | null {
  for (const intent of ACTION_INTENT) {
    if (!intent.pattern.test(text)) continue;

    const action = IRREVERSIBLE_ACTIONS.find((item) => item.code === intent.code);
    const suggestion = suggestScreen(intent.code);

    if (action === undefined || suggestion === null) continue;

    return {
      code: action.code,
      label: action.label,
      notice: suggestion.notice,
      route: suggestion.kind === "link" ? suggestion.route : null,
    };
  }

  return null;
}

// =============================================================================
// 모델 없이 답하는 길 (D-28 계열)
// =============================================================================

/**
 * `ANTHROPIC_API_KEY` 가 없을 때 무엇을 할 것인가.
 *
 * **대화를 닫지 않는다.** S7-02 가 "키가 없으면 룰만으로 선다" 를 세웠고, 조건 검색의
 * 룰 파서는 모델 없이도 문장에서 지역·날짜·하객·예산을 읽는다. 그러니 키가 없어도
 * **조건이 읽히면 조회는 된다** — 답을 모델이 쓰지 않을 뿐이다.
 *
 * 이 모드에서 나가는 문장은 **전부 코드가 가진 고정 문구**다. 그래서 후처리를 돌릴
 * 대상이 없다 — 지어낸 수치가 생길 자리가 아예 없다.
 */
export type FallbackPlan =
  /** 조건이 읽혔다. `search_vendors` 를 그대로 부른다. */
  | { kind: "search"; query: string; fields: string[] }
  /** 조건을 못 읽었다. 할 수 있는 일을 안내한다. */
  | { kind: "guide" };

export const FALLBACK_MODE_NOTICE =
  "지금은 조건을 읽어 업체를 찾아드리는 것까지만 할 수 있어요. 대화형 답변은 준비 중이에요.";

export const FALLBACK_SEARCH_REPLY =
  "말씀하신 조건으로 찾아봤어요. 아래 결과는 조회한 값 그대로예요.";

export const FALLBACK_GUIDE_REPLY =
  "조건을 아직 못 읽었어요. \"3월 14일 강남 300인\"처럼 지역·날짜·하객 수를 적어 주시면 찾아볼게요.";

export function planWithoutModel(input: {
  text: string;
  /** 룰 파서가 읽어 낸 조건 필드. `lib/core/search/parse.ts` 결과를 넘긴다. */
  fields: readonly string[];
}): FallbackPlan {
  if (input.fields.length === 0) return { kind: "guide" };

  return { kind: "search", query: input.text, fields: [...input.fields] };
}

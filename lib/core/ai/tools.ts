/**
 * AI 플래너 툴 레지스트리 — 목록과 등록 규칙 (S7-20 · 명세서 §5.6 · IDEA-03)
 *
 * **이 파일이 §5.6 표의 단일 대응물이다.** 명세는 "툴 목록은 실제 구현과 대조해
 * 유지한다" 고 적었고, 대조할 상대가 문서 두 벌이면 언젠가 어긋난다 — 그래서 상태·
 * 담당 태스크·근거 구현을 **코드가 갖는다.** 표가 늘면 여기가 먼저 늘고, 테스트가
 * 그 사실을 붙잡는다.
 *
 * **없는 툴을 등록하지 않는다.** 등록된 툴은 모델이 부르고, 핸들러가 없으면 그 실패가
 * 대화에 노출된다. 그래서 등록 조건을 코드가 강제한다 — `status: "available"` 이고
 * **입력 스키마와 핸들러가 둘 다 있는** 툴만 모델에게 보인다(`registrableTools`).
 * 대기 툴은 목록에 남아 있되 노출되지 않으며, 담당 태스크가 끝나는 날 상태 한 글자와
 * 핸들러 하나를 더하면 열린다.
 *
 * **툴은 새 계산을 만들지 않는다.** 전부 이미 있는 순수 함수·조회를 부른다(`backing`).
 * 툴이 자기 계산을 갖는 순간 화면이 보여 준 값과 대화가 말하는 값이 갈리고, 그 차이는
 * 사용자가 재현할 수 없다.
 */

// =============================================================================
// 툴 목록 (§5.6 표)
// =============================================================================

export const TOOL_MODES = ["read", "write"] as const;
export type ToolMode = (typeof TOOL_MODES)[number];

export const TOOL_STATUSES = ["available", "pending"] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];

export type ToolSpec = {
  /** 모델에게 노출되는 이름. §5.6 표의 첫 칸 그대로다. */
  name: string;
  /** 모델이 읽는 한 줄 설명. 무엇을 돌려주는지만 적는다 — 언제 부르라고 적지 않는다. */
  summary: string;
  mode: ToolMode;
  status: ToolStatus;
  /** 대기 툴을 채울 태스크. 가용이면 null 이다. */
  filledBy: string | null;
  /** 이 툴이 부르는 것. **새로 만들지 않는다**는 사실을 코드에 적어 둔다. */
  backing: string;
  /**
   * 실행 전에 사용자 확인을 받아야 하는가.
   *
   * **쓰기 툴은 예외 없이 true 다.** 목록이 늘 때마다 같은 질문을 다시 한다 —
   * "되돌릴 수 있는가". 되돌릴 수 없으면 아래 `IRREVERSIBLE_ACTIONS` 로 간다.
   */
  requiresConfirmation: boolean;
};

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: "get_couple_context",
    summary: "지금 대화 중인 커플의 예식일·지역·하객수·예산·진행 상태를 돌려준다.",
    mode: "read",
    status: "available",
    filledBy: null,
    backing: "lib/core/schemas/home.ts · lib/core/schemas/onboarding.ts (S3-01·S3-11)",
    requiresConfirmation: false,
  },
  {
    name: "search_price_index",
    summary:
      "지역·카테고리의 참가격 분포(p25·p50·p75)와 표본 수를 돌려준다. 표본이 기준에 못 미치면 분포를 내지 않는다.",
    mode: "read",
    status: "available",
    filledBy: null,
    backing: "lib/core/pricing/price-index.ts · lib/pricing/price-index-query.ts (S3-08)",
    requiresConfirmation: false,
  },
  {
    name: "search_vendors",
    summary:
      "조건에 맞는 업체·상품을 돌려준다. 적용된 정렬·랭킹 기준 코드를 항상 함께 돌려준다.",
    mode: "read",
    status: "available",
    filledBy: null,
    backing: "lib/core/search · lib/search/query.ts (S3-03·S7-02)",
    requiresConfirmation: false,
  },
  {
    name: "get_vendor_availability",
    summary: "한 업체의 특정 날짜 잔여 자리와 그 조건의 최종가·할인 사유를 돌려준다.",
    mode: "read",
    status: "available",
    filledBy: null,
    backing: "lib/core/pricing/dynamic.ts · lib/explore/customer-price.ts (S3-06·S3-07)",
    requiresConfirmation: false,
  },
  {
    name: "get_cart_summary",
    summary: "활성 장바구니별 총액·예산 대비·카테고리 채움을 돌려준다.",
    mode: "read",
    status: "available",
    filledBy: null,
    backing: "lib/core/cart/multi-cart.ts · lib/cart/loader.ts (S3-05·S3-12)",
    requiresConfirmation: false,
  },
  {
    name: "compare_carts",
    summary:
      "장바구니끼리 총액을 견준다. 카테고리 구성이 다르면 최저 총액을 정하지 않고 그 사유를 돌려준다.",
    mode: "read",
    status: "available",
    filledBy: null,
    backing: "lib/core/cart/multi-cart.ts · lib/cart/loader.ts (S3-12)",
    requiresConfirmation: false,
  },
  {
    name: "simulate_penalty",
    summary:
      "취소 시점 기준 위약금을 결정적으로 계산한다. 기준 대비 비교값만 돌려주며 법적 결론을 돌려주지 않는다.",
    mode: "read",
    status: "available",
    filledBy: null,
    backing: "lib/core/pricing/penalty.ts · lib/pricing/penalty-rule-set.ts (T-04·S5-08)",
    requiresConfirmation: false,
  },
  {
    name: "preview_payment_schedule",
    summary: "계약 총액의 분할 회차·비율·회차별 금액을 미리 계산해 돌려준다.",
    mode: "read",
    status: "available",
    filledBy: null,
    backing: "lib/core/payment/payment.ts (S5-01·S5-06)",
    requiresConfirmation: false,
  },
  {
    name: "explain_planner_fee",
    summary: "카테고리별로 플래너를 쓸 때 붙는 요율과 금액 영향을 돌려준다.",
    mode: "read",
    status: "available",
    filledBy: null,
    backing: "lib/core/pricing/rates.ts · lib/core/planner/scope.ts (S5-01·S6-01)",
    requiresConfirmation: false,
  },
  {
    name: "search_planners",
    summary: "공개된 플래너를 돌려준다. 정렬 기준 코드를 함께 돌려주며 실적은 개수만 있다.",
    mode: "read",
    status: "available",
    filledBy: null,
    backing: "lib/planners/loader.ts · lib/core/planner/profile.ts (S6-02)",
    requiresConfirmation: false,
  },
  {
    name: "list_coupons",
    summary: "보유 쿠폰과 적용 조건·못 쓰는 사유를 함께 돌려준다.",
    mode: "read",
    status: "available",
    filledBy: null,
    backing: "lib/core/coupon/coupon.ts (S5-11)",
    requiresConfirmation: false,
  },
  // ── 대기 — 담당 태스크가 끝나면 상태와 핸들러를 함께 연다 ────────────────────
  {
    name: "get_checklist",
    summary: "잔여 태스크와 기한이 임박한 항목을 돌려준다.",
    mode: "read",
    status: "pending",
    filledBy: "S7-08",
    backing: "—",
    requiresConfirmation: false,
  },
  {
    name: "get_task_graph",
    summary:
      "준비 순서를 돌려준다 — 지금 할 수 있는 일과 먼저 끝내야 하는 일. '무엇부터 해야 하나요' 에 답하는 근거다.",
    mode: "read",
    // **S7-19 가 열었다** — 화면·API 가 서면서 상태·스키마·핸들러 셋이 다 찼다(D-46).
    // `filledBy` 는 **아직 안 열린 툴의 담당 태스크**를 적는 칸이라 열리는 순간 비운다.
    status: "available",
    filledBy: null,
    backing: "GET /api/tasks/graph (loadChecklist)",
    requiresConfirmation: false,
  },
  {
    name: "create_tasks",
    summary: "태스크를 만든다. 사용자 확인을 받은 뒤에만 실행한다.",
    mode: "write",
    status: "pending",
    filledBy: "S7-08",
    backing: "—",
    requiresConfirmation: true,
  },
  {
    name: "update_budget_allocation",
    summary: "예산 배분 초안을 갱신한다. 사용자 확인을 받은 뒤에만 실행한다.",
    mode: "write",
    status: "pending",
    filledBy: "S7-07",
    backing: "—",
    requiresConfirmation: true,
  },
  {
    name: "summarize_report",
    summary: "이미 만들어진 계약서 검토 리포트의 요약을 돌려준다.",
    mode: "read",
    status: "pending",
    filledBy: "S7-03",
    backing: "—",
    requiresConfirmation: false,
  },
] as const;

export type ToolName = (typeof TOOL_SPECS)[number]["name"];

export function toolSpec(name: string): ToolSpec | null {
  return TOOL_SPECS.find((spec) => spec.name === name) ?? null;
}

/**
 * 모델에게 보일 수 있는 툴.
 *
 * **세 조각이 모두 있어야 한다** — 명세가 '가용' 이라 적었고(`status`), 입력 모양이
 * 정의돼 있고(`hasSchema`), 실제로 부를 핸들러가 있어야(`hasHandler`) 등록된다.
 * 셋 중 하나라도 빠진 채 등록하면 모델은 그 툴을 부르고 대화에는 실패가 남는다.
 */
export function registrableTools(input: {
  hasSchema: (name: string) => boolean;
  hasHandler: (name: string) => boolean;
}): ToolSpec[] {
  return TOOL_SPECS.filter(
    (spec) =>
      spec.status === "available" && input.hasSchema(spec.name) && input.hasHandler(spec.name),
  );
}

/** 등록에서 빠진 툴과 그 이유. 운영자·개발자가 "왜 안 보이나" 를 물을 때의 답이다. */
export type ToolGap = {
  name: string;
  reason: "pending" | "schema_missing" | "handler_missing";
  filledBy: string | null;
};

export function toolGaps(input: {
  hasSchema: (name: string) => boolean;
  hasHandler: (name: string) => boolean;
}): ToolGap[] {
  const gaps: ToolGap[] = [];

  for (const spec of TOOL_SPECS) {
    if (spec.status === "pending") {
      gaps.push({ name: spec.name, reason: "pending", filledBy: spec.filledBy });
      continue;
    }

    if (!input.hasSchema(spec.name)) {
      gaps.push({ name: spec.name, reason: "schema_missing", filledBy: spec.filledBy });
      continue;
    }

    if (!input.hasHandler(spec.name)) {
      gaps.push({ name: spec.name, reason: "handler_missing", filledBy: spec.filledBy });
    }
  }

  return gaps;
}

// =============================================================================
// 툴로 실행하지 않는 것 — 되돌릴 수 없는 행위 (§5.6)
// =============================================================================

/**
 * **결제 · 전자서명 · 예약 확정 · 계약 해지 · 쿠폰 사용 확정 · 에스크로 릴리즈 ·
 * 정산 실행.** 이 일곱은 툴을 만들지 않는다. 되돌릴 수 없는 일에 대화라는 애매한
 * 입력을 두면 "그렇게 하라고 한 적 없다" 를 검증할 방법이 없다 — 그 판단의 증거가
 * 자연어뿐이기 때문이다.
 *
 * 대신 **화면 이동만 제안한다.** 그런데 화면이 아직 없는 것이 절반이다(S5-05·S5-06 ·
 * S5-12). 그래서 경로와 함께 **열려 있는가**를 적는다 — S3-11 이 세운 규칙 그대로,
 * **없는 화면으로 보내지 않는다.** 닫혀 있으면 링크 대신 담당 태스크를 말한다.
 */
export type IrreversibleAction = {
  code: string;
  label: string;
  route: string;
  /**
   * 그 화면이 지금 열려 있는가. **지금은 일곱 개가 전부 `pending` 이다** — 거래
   * 화면(S5-05·S5-06·S5-07·S5-12)이 아직 서지 않았다. 값이 하나뿐이라고 타입을
   * 좁히지 않는 이유는, 화면이 열리는 날 고쳐야 할 곳이 이 표 한 줄이어야 하기
   * 때문이다.
   */
  routeStatus: "open" | "pending";
  filledBy: string;
};

export const IRREVERSIBLE_ACTIONS: readonly IrreversibleAction[] = [
  {
    code: "payment",
    label: "결제",
    route: "/checkout/[bookingId]",
    routeStatus: "pending",
    filledBy: "S5-06",
  },
  {
    code: "contract_sign",
    label: "전자서명",
    route: "/contracts/[id]",
    routeStatus: "pending",
    filledBy: "S5-05",
  },
  {
    code: "booking_confirm",
    label: "예약 확정",
    route: "/bookings/[id]",
    routeStatus: "pending",
    filledBy: "S5-06",
  },
  {
    code: "contract_cancel",
    label: "계약 해지",
    route: "/bookings/[id]",
    routeStatus: "pending",
    filledBy: "S5-06",
  },
  {
    code: "coupon_redeem",
    label: "쿠폰 사용 확정",
    route: "/coupons",
    routeStatus: "pending",
    filledBy: "S5-12",
  },
  {
    code: "escrow_release",
    label: "에스크로 릴리즈",
    route: "/bookings/[id]",
    routeStatus: "pending",
    filledBy: "S5-06",
  },
  {
    code: "settlement_payout",
    label: "정산 실행",
    route: "/vendor/settlements",
    routeStatus: "pending",
    filledBy: "S5-07",
  },
];

/** 되돌릴 수 없는 행위를 툴로 만들지 않았는가. 목록과 레지스트리를 맞대는 검사다. */
export function irreversibleActionCodes(): string[] {
  return IRREVERSIBLE_ACTIONS.map((action) => action.code);
}

export type ScreenSuggestion =
  | { kind: "link"; label: string; route: string; notice: string }
  /** 화면이 아직 없다. **링크를 만들지 않는다.** */
  | { kind: "not_ready"; label: string; filledBy: string; notice: string };

/**
 * 되돌릴 수 없는 행위를 요청받았을 때 무엇을 말할지.
 *
 * 문구를 코드가 갖는 이유는 후처리(`postcheck`)가 이 문장들을 **툴 결과와 같은 자격**
 * 으로 취급하기 때문이다 — 모델이 스스로 지어낸 안내와 우리가 정한 안내를 구분할 수
 * 있어야 한다.
 */
export function suggestScreen(code: string): ScreenSuggestion | null {
  const action = IRREVERSIBLE_ACTIONS.find((item) => item.code === code);
  if (action === undefined) return null;

  if (action.routeStatus === "open") {
    return {
      kind: "link",
      label: action.label,
      route: action.route,
      notice: `${action.label}은(는) 대화로 진행하지 않아요. 화면에서 직접 확인하고 눌러 주세요.`,
    };
  }

  return {
    kind: "not_ready",
    label: action.label,
    filledBy: action.filledBy,
    notice: `${action.label} 화면은 아직 준비 중이에요(${action.filledBy}). 대화로는 진행하지 않습니다.`,
  };
}

/**
 * 견적 템플릿 — 폼과 저장본 사이 (C-3 · F-V-07 · §2.2)
 *
 * ── 표는 있었고 쓰는 길이 없었다 ───────────────────────────────────────────
 * `vendor_templates`(0026)는 `quick_reply` 와 `quote` 를 담고, `/vendor/settings`
 * 에서 **만들고 지울 수 있다.** 그런데 **꺼내 쓰는 자리가 없었다** — 견적 폼은
 * 템플릿을 모르고, 설정 화면은 "빠른 답변과 견적 구성을 저장해 두고 **꺼내 써요**"
 * 라고 적으면서 "견적 템플릿은 문의·견적 화면에서 **저장할 수 있어요**" 라고까지
 * 적어 두었다. **두 문장 다 거짓이었다**(FIX-65 와 같은 결함: 할 수 있다고 적고
 * 수단을 안 준다).
 *
 * ── 이 파일이 조심하는 것: 템플릿에는 FK 가 없다 ───────────────────────────
 * 0026 이 일부러 그렇게 두었다 — "템플릿은 초안이고 무결성 경계는 실제 견적 쪽이다.
 * FK 를 걸면 상품을 지울 때 초안이 막아서고, 그건 초안이 할 일이 아니다."
 *
 * 옳은 결정이지만 **값을 되살릴 때 그 대가를 치러야 한다.** 저장해 둔 템플릿이
 * 가리키는 상품이 그 사이 내려갔거나(`archived`) 추가금이 지워졌을 수 있다.
 * 그대로 폼에 부으면 **없는 상품·없는 추가금을 담은 견적**이 만들어지고, 서버가
 * 거절하거나(0024 참조 강제) 더 나쁘게는 고객이 받은 견적에 유령 항목이 선다.
 *
 * 그래서 `applyQuoteTemplate` 은 **지금 고를 수 있는 것만 남기고, 무엇이 빠졌는지
 * 함께 돌려준다.** 조용히 버리지 않는다 — 업체가 "저장할 때와 다르다" 를 알아야
 * 금액을 다시 본다.
 */

export type QuoteTemplateLine = {
  itemType: "base" | "option";
  productOptionId: string | null;
  amount: number | null;
};

export type QuoteTemplatePayload = {
  productId: string;
  lines: QuoteTemplateLine[];
  vendorMemo: string | null;
};

/** 견적 폼이 들고 있는 값. 문자열인 것은 `<input>` 이 문자열을 주기 때문이다. */
export type QuoteFormState = {
  productId: string;
  baseAmount: string;
  optionIds: string[];
  optionAmounts: Record<string, string>;
  memo: string;
};

/** 폼이 고를 수 있는 것. `loadQuotableProducts` 가 주는 모양의 최소 부분집합이다. */
export type QuotableShape = {
  id: string;
  options: { id: string }[];
};

/**
 * 폼 → 저장본.
 *
 * **유효기간을 담지 않는다.** 템플릿은 다시 쓰려고 두는 것인데 날짜를 박아 두면
 * 다음 달에 꺼냈을 때 **이미 지난 견적**이 만들어진다. 유효기간은 보낼 때 정한다.
 *
 * **금액 상한도 담지 않는다**(0026 머리말) — 상한은 보낼 때 `price_rules` 로 다시
 * 계산한다. 템플릿에 박으면 룰이 바뀐 뒤에도 옛 상한이 따라다닌다.
 */
export function quoteTemplatePayloadOf(form: QuoteFormState): QuoteTemplatePayload {
  const numberOrNull = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (trimmed === "") return null;

    const value = Number(trimmed);

    // **NaN 을 0 으로 접지 않는다.** 0 은 "공짜" 라는 뜻이고 빈 값은 "상한 그대로"다.
    return Number.isInteger(value) && value >= 0 ? value : null;
  };

  return {
    productId: form.productId,
    lines: [
      { itemType: "base", productOptionId: null, amount: numberOrNull(form.baseAmount) },
      ...form.optionIds.map((id) => ({
        itemType: "option" as const,
        productOptionId: id,
        amount: numberOrNull(form.optionAmounts[id] ?? ""),
      })),
    ],
    vendorMemo: form.memo.trim() === "" ? null : form.memo.trim(),
  };
}

export type ApplyResult = {
  /** 지금 고를 수 있는 것만 담은 폼 값. */
  form: QuoteFormState;
  /** 저장할 때와 달라진 점. **비어 있으면 그대로 복원된 것이다.** */
  dropped: string[];
};

/**
 * 저장본 → 폼. **지금 존재하는 것만 남긴다.**
 *
 * 상품이 통째로 사라졌으면 폼을 바꾸지 않고 그 사실만 돌려준다 — 엉뚱한 상품에
 * 저장해 둔 금액을 붓는 것이 가장 나쁘다.
 */
export function applyQuoteTemplate(
  payload: QuoteTemplatePayload,
  products: readonly QuotableShape[],
  current: QuoteFormState,
): ApplyResult {
  const product = products.find((item) => item.id === payload.productId) ?? null;

  if (product === null) {
    return {
      form: current,
      dropped: ["저장할 때의 상품이 지금 목록에 없어요. 상품을 고르고 금액을 확인해 주세요."],
    };
  }

  const dropped: string[] = [];
  const base = payload.lines.find((line) => line.itemType === "base") ?? null;

  const optionIds: string[] = [];
  const optionAmounts: Record<string, string> = {};
  let missingOptions = 0;

  for (const line of payload.lines) {
    if (line.itemType !== "option" || line.productOptionId === null) continue;

    if (!product.options.some((option) => option.id === line.productOptionId)) {
      missingOptions += 1;
      continue;
    }

    optionIds.push(line.productOptionId);
    if (line.amount !== null) optionAmounts[line.productOptionId] = String(line.amount);
  }

  if (missingOptions > 0) {
    dropped.push(`저장할 때 담겨 있던 추가금 ${missingOptions}개가 지금은 없어요.`);
  }

  return {
    form: {
      productId: payload.productId,
      baseAmount: base?.amount === null || base?.amount === undefined ? "" : String(base.amount),
      optionIds,
      optionAmounts,
      memo: payload.vendorMemo ?? "",
    },
    dropped,
  };
}

/**
 * 저장본이 우리가 아는 모양인가.
 *
 * `payload_json` 은 DB 에서 **객체인지까지만** 검사된다(0026). 화면이 그대로 믿고
 * `.lines.map` 을 부르면 낡은 행 하나에 화면이 통째로 죽는다.
 */
export function isQuoteTemplatePayload(value: unknown): value is QuoteTemplatePayload {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.productId !== "string" || candidate.productId === "") return false;
  if (!Array.isArray(candidate.lines) || candidate.lines.length === 0) return false;

  return candidate.lines.every((line) => {
    if (typeof line !== "object" || line === null) return false;

    const row = line as Record<string, unknown>;

    return row.itemType === "base" || row.itemType === "option";
  });
}

/** 저장 이름 기본값. 업체가 바꿀 수 있고, 비워 두면 저장하지 않는다. */
export function defaultTemplateTitle(productName: string, optionCount: number): string {
  const suffix = optionCount === 0 ? "" : ` +추가금 ${optionCount}`;

  return `${productName}${suffix}`.slice(0, 60);
}

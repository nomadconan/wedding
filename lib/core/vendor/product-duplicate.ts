/**
 * 상품 복제 (C-3 · F-V-03 · §2.2)
 *
 * ── B-1 이 지목한 것 ───────────────────────────────────────────────────────
 * "상품 등록에 단계·입력이 많고 복사 기능이 없다." 실제로 세어 보면 한 상품을
 * **게시**까지 올리는 데 화면 둘(`/vendor/products/new` → `/vendor/products/[id]`)을
 * 오가며 **필수 입력 다섯**(상품명 · 카테고리 · 총액 · 포함 항목 이름 · 추가금 이름과
 * 금액)과 **확정·게시 클릭 둘**이 든다. 웨딩홀이 점심·저녁·주말 패키지를 올리면
 * **거의 같은 값을 세 번 친다.**
 *
 * ── 그런데 편의가 정찰제를 깎으면 안 된다 ──────────────────────────────────
 * 이 파일이 조심하는 것은 **무엇을 복사하지 않을지**다.
 *
 * **`add_ons_declared_at` 은 따라오지 않는다**(D-06). 추가금 확정은 값이 아니라
 * **고객에게 하는 말**이다 — "이 목록이 전부이고 여기 없는 것은 계약 뒤에 청구하지
 * 않는다". 사본은 이름도 총액도 달라질 물건이라 그 말을 **원본 대신 해 줄 수 없다.**
 * 그래서 추가금 **항목은 복사하고**(다시 타자 치지 않게) **확정만 비운다**(다시 보게).
 * 편의는 타자에서 나오지 손도장에서 나오지 않는다.
 *
 * DB 도 같은 것을 요구한다 — `products_publish_requirements_chk` 가 `add_ons_declared_at
 * is not null` 없이는 `published` 로 못 가게 막는다. **화면이 봐주더라도 DB 가 막는다.**
 *
 * **`status` 는 언제나 `draft` 다.** 게시 중인 상품을 복제했다고 사본이 곧바로
 * 고객에게 보이면, 업체는 값을 고치기 전에 이미 노출된 상품을 갖게 된다.
 *
 * **`published_at` 도 비운다** — 사본은 게시된 적이 없다. 남기면 목록이 "언제부터
 * 노출 중" 을 거짓으로 말한다.
 */

/** 복제본 이름 꼬리. 목록에서 원본과 구분되는 것이 목적이다. */
export const COPY_SUFFIX = " (사본)";

/** `products.name` 의 상한(zod `ProductInputFieldsSchema` 와 같은 값). */
export const PRODUCT_NAME_MAX = 100;

export type DuplicateSource = {
  name: string;
  category: string;
  basePriceTotal: number;
  includedItems: unknown[];
  capacityMin: number | null;
  capacityMax: number | null;
  priceIncludesVat: boolean;
};

export type DuplicateDraft = {
  name: string;
  category: string;
  basePriceTotal: number;
  includedItems: unknown[];
  capacityMin: number | null;
  capacityMax: number | null;
  priceIncludesVat: boolean;
  /** 언제나 작성 중이다. */
  status: "draft";
  /** 사본은 게시된 적이 없다. */
  publishedAt: null;
  /** 추가금 확정은 따라오지 않는다(D-06). */
  addOnsDeclaredAt: null;
};

/**
 * 이름에 꼬리를 붙인다. **상한을 넘으면 앞을 자른다.**
 *
 * 꼬리를 자르면 사본인지 알 수 없게 되므로 **꼬리를 지키고 이름을 줄인다.**
 * 이름이 이미 상한에 닿아 있는 상품이 실제로 있고(100자), 그때 꼬리를 버리면
 * 목록에 같은 이름이 둘 서서 어느 쪽이 사본인지 화면으로 구분할 수 없다.
 */
export function copyNameOf(name: string, max: number = PRODUCT_NAME_MAX): string {
  const trimmed = name.trim();
  const room = max - COPY_SUFFIX.length;

  if (room <= 0) return COPY_SUFFIX.trim().slice(0, max);

  return `${trimmed.slice(0, room).trimEnd()}${COPY_SUFFIX}`;
}

/**
 * 원본에서 초안 사본을 만든다. **순수 함수다** — DB 도 시각도 모른다.
 *
 * 값을 그대로 옮기는 칸과 **일부러 비우는 칸**을 한자리에서 보게 하는 것이 목적이다.
 * 나중에 칸이 늘면 여기서 "이것도 복사할 것인가" 를 한 번 묻게 된다.
 */
export function draftCopyOf(source: DuplicateSource): DuplicateDraft {
  return {
    name: copyNameOf(source.name),
    category: source.category,
    basePriceTotal: source.basePriceTotal,
    // 배열을 그대로 물리지 않는다 — 원본과 사본이 같은 참조를 들면 한쪽 수정이
    // 다른 쪽에 샌다. 이 함수는 순수하지만 호출부는 그렇지 않을 수 있다.
    includedItems: [...source.includedItems],
    capacityMin: source.capacityMin,
    capacityMax: source.capacityMax,
    priceIncludesVat: source.priceIncludesVat,
    status: "draft",
    publishedAt: null,
    addOnsDeclaredAt: null,
  };
}

/**
 * 사본이 게시되기까지 **아직 남은 일**.
 *
 * 복제 직후 화면이 "이제 뭘 해야 하나" 를 말할 수 있어야 한다. 아무 말도 없으면
 * 업체는 사본이 이미 고객에게 보이는 줄 안다 — **가장 나쁜 오해**다.
 *
 * `productPublishBlockers`(이름·총액·포함 항목)와 **겹치지 않는 것만** 돌려준다.
 * 그 셋은 원본에서 그대로 따라오므로 사본에서 새로 막히는 것은 **추가금 확정**뿐이다.
 */
export function copyRemainingSteps(input: { copiedOptionCount: number }): string[] {
  const steps: string[] = [];

  steps.push(
    input.copiedOptionCount === 0
      ? "추가금을 등록하고 확정해 주세요. 없다면 '추가금 없음'으로 확정합니다."
      : `추가금 ${input.copiedOptionCount}개를 그대로 옮겼어요. 목록을 확인하고 확정해 주세요.`,
  );
  steps.push("확정한 뒤 게시하면 고객에게 보입니다. 지금은 작성 중입니다.");

  return steps;
}

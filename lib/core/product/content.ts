// 상품 본문·한 줄 소개 (C-2b · 명세서 §3.3 · §2.2 F-V-03 · D-97)
//
// 프레임워크를 모르는 순수 모듈이다. React·Next 를 import 하지 않는다(CLAUDE.md §3.1).
//
// ── 이 파일이 지키는 것 ──────────────────────────────────────────────────────
//  1. **본문이 정찰제를 무너뜨리지 못하게 한다.** 총액을 숫자로 받아도 본문에
//     "자세한 건 별도 문의" 라고 적으면 F-V-03 의 총액 표기 강제가 그대로 무력화된다.
//     상품명·포함 항목에 쓰는 `findPriceEvasionPhrase` 를 **본문에도 같이** 적용한다.
//  2. **직거래를 우회하는 연락처를 막는다.** 전화·이메일·계좌가 본문에 적히면
//     플랫폼 밖에서 거래가 성사되고, 그러면 계약서도 에스크로도 증적도 없다.
//     판정은 `lib/core/masking` 의 **이미 있는 패턴**을 쓴다 — 연락처 정규식을
//     두 벌 두면 한쪽만 고쳐지는 날이 온다.
//  3. **본문을 HTML 로 만들지 않는다**(D-97). 저장하는 것은 마크다운 **원문**이고
//     화면은 `parseMarkdown` 이 돌려준 블록을 React 로 그린다. 그래서 본문에
//     `<script>` 가 들어 있어도 글자로 보일 뿐이다 — 살균기가 필요 없다.
//  4. **블록을 저장하지 않는다.** 블록은 원문에서 계산된다. 둘 다 저장하면
//     갈리는 날이 오고 그때 어느 쪽이 맞는지 답할 수 없다.

import { z } from "zod";

import { parseMarkdown, type ContentBlock } from "../content/markdown";
import { detectResidualPii } from "../masking";
import { findPriceEvasionPhrase } from "../schemas/product";

// **의존 방향은 한쪽이다** — 이 파일이 `schemas/product` 를 읽고, 그 반대는 없다.
// 반대 방향이 생기면 순환이 되므로 상품 입력 스키마에 본문 칸을 얹지 않고
// 아래 `ProductContentInputSchema` 를 따로 두었다. 라우트가 둘을 합친다.

// =============================================================================
// 한계값 — DB CHECK(0076)과 **같은 수**여야 한다
// =============================================================================

export const PRODUCT_SUMMARY_MAX = 300;
export const PRODUCT_DESCRIPTION_MAX = 8000;

/** 본문 봉투의 현재 판본. 모양이 바뀌면 올린다. */
export const PRODUCT_DESCRIPTION_VERSION = 1;

// =============================================================================
// 본문 봉투
// =============================================================================

/**
 * `products.description_json` 에 들어가는 모양.
 *
 * **왜 원문만 담는가.** 이름이 `_json` 이라 블록 배열을 넣고 싶어지지만, 블록은
 * 원문에서 **계산되는 값**이다(CLAUDE.md 공통 규칙). 게다가 블록만 저장하면
 * 업체가 다시 편집할 때 원문을 복원할 수 없어 **자기가 쓴 문장이 정규화되어 돌아온다**.
 * 봉투에 판본을 둔 이유는 나중에 모양이 바뀌어도 **옛 행을 읽을 수 있게** 하기 위해서다.
 */
export type ProductDescription = {
  v: number;
  source: string;
};

/** DB 에서 읽은 값이 본문 봉투인가. 모르는 모양은 **본문 없음**으로 다룬다. */
export function isProductDescription(value: unknown): value is ProductDescription {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Record<string, unknown>;

  return typeof candidate.v === "number" && typeof candidate.source === "string";
}

/** 본문 원문을 꺼낸다. 없으면 null. */
export function descriptionSource(value: unknown): string | null {
  if (!isProductDescription(value)) return null;

  const trimmed = value.source.trim();

  return trimmed.length > 0 ? trimmed : null;
}

/** 저장할 봉투를 만든다. 빈 본문은 **봉투를 만들지 않고 null** 이다. */
export function toProductDescription(source: string | null): ProductDescription | null {
  if (source === null) return null;

  const trimmed = source.trim();
  if (trimmed.length === 0) return null;

  return { v: PRODUCT_DESCRIPTION_VERSION, source: trimmed };
}

/**
 * 본문을 화면이 그릴 블록으로 바꾼다.
 *
 * **가이드 본문과 같은 파서를 쓴다**(D-97). 외부 링크는 파서가 이미 글자로 남기므로
 * 본문에서 밖으로 나가는 링크가 생기지 않는다 — 여기서 따로 막을 필요가 없다.
 */
export function descriptionBlocks(value: unknown): ContentBlock[] {
  const source = descriptionSource(value);

  return source === null ? [] : parseMarkdown(source);
}

// =============================================================================
// 입력 스키마 — 모양과 길이
// =============================================================================

/**
 * 본문 두 칸의 입력.
 *
 * 여기서는 **모양과 길이만** 본다. 가격 회피·연락처는 `productContentProblems` 가
 * 보고 라우트가 같은 422 에 실어 보낸다 — zod 의 `superRefine` 에 넣지 않은 이유는
 * 그 판정이 **저장 직전 한 번 더** 필요하고(부분 수정에서 기존 값과 합친 뒤),
 * 두 곳에서 다른 방식으로 부르면 결과가 갈리기 때문이다.
 *
 * `null` 은 **지운다**는 뜻이고 `undefined` 는 **건드리지 않는다**는 뜻이다.
 */
export const ProductContentInputSchema = z.object({
  summary: z.string().trim().max(PRODUCT_SUMMARY_MAX).nullable().optional(),
  description: z.string().trim().max(PRODUCT_DESCRIPTION_MAX).nullable().optional(),
});

export type ProductContentInput = z.infer<typeof ProductContentInputSchema>;

// =============================================================================
// 입력 판정 — 무엇을 거절하는가
// =============================================================================

export type ProductContentProblem = {
  field: "summary" | "description";
  code: "TOO_LONG" | "PRICE_EVASION" | "CONTACT_INFO";
  message: string;
};

const FIELD_LABEL: Record<ProductContentProblem["field"], string> = {
  summary: "한 줄 소개",
  description: "상품 소개",
};

const MAX_OF: Record<ProductContentProblem["field"], number> = {
  summary: PRODUCT_SUMMARY_MAX,
  description: PRODUCT_DESCRIPTION_MAX,
};

/**
 * 연락처 종류별 안내.
 *
 * **무엇이 걸렸는지는 말하되 걸린 값은 되돌려 주지 않는다** —
 * `detectResidualPii` 가 위치와 종류만 주는 것과 같은 이유다.
 */
const CONTACT_LABEL: Record<string, string> = {
  phone: "전화번호",
  email: "이메일 주소",
  account: "계좌번호",
  rrn: "주민등록번호",
  biz_no: "사업자등록번호",
};

/**
 * 한 필드를 검사한다.
 *
 * 순서가 있다: 길이 → 가격 회피 → 연락처. 길이가 넘치면 나머지는 보지 않는다 —
 * 잘린 글에서 찾은 위치는 글쓴이에게 아무 뜻이 없다.
 */
function problemsOf(
  field: ProductContentProblem["field"],
  value: string,
): ProductContentProblem[] {
  const problems: ProductContentProblem[] = [];
  const label = FIELD_LABEL[field];
  const max = MAX_OF[field];

  if (value.length > max) {
    problems.push({
      field,
      code: "TOO_LONG",
      message: `${label}는 ${max}자까지 쓸 수 있어요.`,
    });

    return problems;
  }

  const evasion = findPriceEvasionPhrase(value);
  if (evasion !== null) {
    problems.push({
      field,
      code: "PRICE_EVASION",
      message:
        `${label}에 '${evasion}' 같은 가격 문의 표현을 쓸 수 없어요. ` +
        `총액은 판매가 칸에 숫자로 등록해 주세요.`,
    });
  }

  // 연락처는 **종류만** 모아 한 줄로 말한다. 같은 종류가 여러 번 나와도 한 번만 적는다.
  const kinds = [...new Set(detectResidualPii(value).map((risk) => risk.kind))];
  if (kinds.length > 0) {
    const named = kinds.map((kind) => CONTACT_LABEL[kind] ?? kind).join(" · ");

    problems.push({
      field,
      code: "CONTACT_INFO",
      message:
        `${label}에 ${named}로 보이는 내용이 있어요. ` +
        `연락은 문의·채팅으로 받습니다 — 밖에서 주고받으면 계약서도 결제 보호도 남지 않아요.`,
    });
  }

  return problems;
}

/**
 * 상품 본문 입력 전체를 검사한다.
 *
 * **비어 있는 것은 문제가 아니다.** 본문·소개는 게시 조건이 아니라 완성도 권유다
 * (0076 주석 참조) — 여기서 "비었다" 를 문제로 세면 그 경계가 무너진다.
 */
export function productContentProblems(input: {
  summary?: string | null;
  descriptionSource?: string | null;
}): ProductContentProblem[] {
  const problems: ProductContentProblem[] = [];

  const summary = input.summary?.trim() ?? "";
  if (summary.length > 0) problems.push(...problemsOf("summary", summary));

  const description = input.descriptionSource?.trim() ?? "";
  if (description.length > 0) problems.push(...problemsOf("description", description));

  return problems;
}

// =============================================================================
// 완성도 권유 — **게시를 막지 않는다**
// =============================================================================

export type ProductContentSuggestion = {
  code: "SUMMARY_MISSING" | "DESCRIPTION_MISSING" | "PHOTO_MISSING" | "ALT_TEXT_MISSING";
  message: string;
};

/**
 * 상품에 아직 없는 것.
 *
 * ── 이것이 `publishBlockersOf` 가 **아닌** 이유 ──────────────────────────────
 * C-2b 의 완료 조건이 **"기존 게시 상품이 내려가지 않는다"** 이다. 사진·본문을
 * 게시 조건에 넣으면 이미 팔고 있는 상품이 그 순간 전부 내려간다 — 업체가 아무것도
 * 하지 않았는데 매출이 멈춘다. 그래서 **권유는 권유의 자리에** 둔다.
 *
 * 화면은 이 목록을 **게시 체크리스트와 다른 모양으로** 그려야 한다. 같은 모양이면
 * 업체는 이것도 못 게시하는 이유로 읽는다.
 */
export function productContentSuggestions(product: {
  summary?: string | null;
  description?: unknown;
  photoCount?: number;
  photosMissingAltText?: number;
}): ProductContentSuggestion[] {
  const suggestions: ProductContentSuggestion[] = [];

  if (!product.summary || product.summary.trim().length === 0) {
    suggestions.push({
      code: "SUMMARY_MISSING",
      message: "한 줄 소개를 적으면 목록에서 고객이 먼저 보는 문장이 됩니다.",
    });
  }

  if (descriptionSource(product.description) === null) {
    suggestions.push({
      code: "DESCRIPTION_MISSING",
      message: "상품 소개를 적으면 고객이 무엇을 사는지 알고 문의합니다.",
    });
  }

  if (!product.photoCount || product.photoCount === 0) {
    suggestions.push({
      code: "PHOTO_MISSING",
      message: "사진이 없으면 고객이 비교할 근거가 가격뿐입니다.",
    });
  } else if (product.photosMissingAltText && product.photosMissingAltText > 0) {
    suggestions.push({
      code: "ALT_TEXT_MISSING",
      message: `사진 ${product.photosMissingAltText}장에 설명이 없어요. 화면 낭독기를 쓰는 고객에게는 그 자리가 비어 있습니다.`,
    });
  }

  return suggestions;
}

/**
 * 권유가 게시 조건과 **섞이지 않았는지** 코드로 고정한다.
 *
 * `db:rls` 가 이 목록과 게시 차단 코드 목록이 겹치지 않는 것을 확인한다 —
 * 누군가 나중에 `PHOTO_MISSING` 을 `publishBlockersOf` 로 옮기면 그 검사가 먼저 깨진다.
 */
export const CONTENT_SUGGESTION_CODES = [
  "SUMMARY_MISSING",
  "DESCRIPTION_MISSING",
  "PHOTO_MISSING",
  "ALT_TEXT_MISSING",
] as const;

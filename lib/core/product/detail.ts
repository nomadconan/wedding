// 상품 상세의 표현 규칙 (C-2c · 명세서 §2.1 F-C-38 · §6.2)
//
// 프레임워크를 모르는 순수 모듈이다(CLAUDE.md §3.1).
//
// ── 이 파일이 있는 이유 ──────────────────────────────────────────────────────
// 상품 상세는 **아직 안 만든 것이 여럿 붙을 자리**다. 명세(F-C-38)가 한 화면에
// 모으라고 적은 것 중 컨셉 태그(C-2d) · 상품 후기(C-2e) · 리드타임(C-4b)은
// **다른 태스크의 몫**이고 지금은 없다.
//
// **없는 것을 빈 칸으로 두지 않는다.** 빈 칸은 두 가지로 읽힌다 — *이 상품에는
// 해당이 없다* 와 *아직 우리가 안 만들었다*. 그 둘이 섞이면 화면이 거짓말을 한다
// (C-2a 의 `prepLinkView` 가 같은 이유로 세 상태를 갈랐다 · D-206).
//
// 그래서 여기서 **셋을 가른다**: 있다 / 이 상품에는 없다 / 아직 열지 않았다.

import { descriptionSource } from "./content";

// =============================================================================
// 아직 열지 않은 자리
// =============================================================================

/** 상품 상세가 나중에 채울 자리. 값은 **담당 태스크**이며 화면이 그것을 말하지 않는다. */
// **채운 자리는 목록에서 뺀다** — 남겨 두면 화면이 "아직 준비 중" 이라고
// 적으면서 바로 위에 그 값을 보여 준다.
//   · `styleTags` — C-2d 가 채웠다
//   · `reviews`  — C-2e 가 채웠다
export const PENDING_SECTIONS = ["leadTime"] as const;

export type PendingSection = (typeof PENDING_SECTIONS)[number];

/**
 * 아직 열지 않은 자리의 안내 문구.
 *
 * **"준비 중" 이라고만 적지 않는다.** 무엇이 없는지와 **왜 없는지**를 적어야
 * 고객이 "이 상품은 후기가 나쁜가?" 로 읽지 않는다. 담당 태스크 번호는 내부
 * 어휘라 화면에 쓰지 않는다.
 */
export const PENDING_SECTION_NOTE: Record<PendingSection, string> = {
  leadTime: "언제까지 주문해야 하는지는 업체에 문의해 주세요. 상품별 주문 기한은 준비 중이에요.",
};

// =============================================================================
// 화면이 그릴 조각들
// =============================================================================

export type PhotoView = { id: string; url: string; altText: string | null };

/**
 * 사진 자리.
 *
 * **없는 것과 못 가져온 것을 가르지 않는다** — 둘 다 고객에게는 "사진이 없다" 이고,
 * 우리 쪽 사정을 고객 화면에 적을 이유가 없다. 다만 **가짜 이미지를 그리지 않는다**.
 */
export type PhotoSectionView =
  | { kind: "photos"; photos: PhotoView[] }
  | { kind: "none"; note: string };

export const NO_PRODUCT_PHOTO_NOTE = "아직 등록된 사진이 없어요.";

export function photoSection(photos: PhotoView[]): PhotoSectionView {
  return photos.length > 0
    ? { kind: "photos", photos }
    : { kind: "none", note: NO_PRODUCT_PHOTO_NOTE };
}

/**
 * 본문 자리.
 *
 * 본문은 **원문에서 계산된 블록**으로 그린다(C-2b · D-97). 여기서는 "본문이
 * 있는가" 만 판정하고 블록 변환은 화면이 `descriptionBlocks` 로 한다 —
 * 블록 타입을 이 모듈이 들고 다니면 파서가 바뀔 때 두 곳을 고쳐야 한다.
 */
export const NO_PRODUCT_BODY_NOTE = "업체가 아직 상세 소개를 적지 않았어요.";

export function hasDescription(description: unknown): boolean {
  return descriptionSource(description) !== null;
}

// =============================================================================
// 참가격 비교
// =============================================================================

/**
 * 참가격 대비 편차 표현.
 *
 * **기준이 없으면 0이 아니라 '기준 없음' 이다.** 0을 주면 "딱 중앙값" 이라는
 * **없는 사실**을 말하게 된다 — 탐색 목록(`VendorCard`)이 같은 규칙을 쓴다.
 * 표본이 모자란 것은 업체가 한 일이 아니라 우리 쪽 사정이다.
 */
export type PriceBaselineView =
  | { kind: "measured"; gapBp: number; p50: number; sampleSize: number; sourceNote: string }
  | { kind: "no-baseline"; note: string };

export function priceBaselineView(input: {
  gapBp: number | null;
  p50: number | null;
  sampleSize: number | null;
  sourceNote: string | null;
  noBaselineNote: string;
}): PriceBaselineView {
  if (
    input.gapBp === null ||
    input.p50 === null ||
    input.sampleSize === null ||
    input.sourceNote === null
  ) {
    return { kind: "no-baseline", note: input.noBaselineNote };
  }

  return {
    kind: "measured",
    gapBp: input.gapBp,
    p50: input.p50,
    sampleSize: input.sampleSize,
    sourceNote: input.sourceNote,
  };
}

// =============================================================================
// 이 상품을 볼 수 있는가
// =============================================================================

/**
 * 경로의 업체와 상품의 업체가 같은가.
 *
 * **다르면 404 다.** `/explore/<A>/<B의 상품>` 이 열리면 같은 상품이 두 주소를
 * 갖게 되고(SEO 에서 중복이 되며), 더 나쁘게는 **A 의 맥락에서 B 의 가격**을
 * 보여 주게 된다. RLS 는 "그 상품이 공개인가" 만 보고 이 짝은 보지 않는다.
 */
export function belongsToVendor(
  product: { vendorId: string } | null,
  vendorId: string,
): boolean {
  return product !== null && product.vendorId === vendorId;
}

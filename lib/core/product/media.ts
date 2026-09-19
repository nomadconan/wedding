// 상품 사진 (C-2b · 명세서 §3.3 `vendor_media.product_id` · §4.3 · §3.10)
//
// 프레임워크를 모르는 순수 모듈이다. `node:crypto` 도 쓰지 않는다 — 경로의 무작위
// 조각은 호출부가 만들어 넘긴다(CLAUDE.md §3.1 · Expo 전환 대비).
//
// ── 형식 허용목록이 왜 코드에 있는가 ────────────────────────────────────────
// 개수 상한은 `app_settings` 에 있고(운영이 배포 없이 바꾼다) **형식은 여기 있다.**
// 둘의 성격이 다르기 때문이다 — 개수는 운영 손잡이지만 **형식은 보안 경계**다.
// `vendor-media` 는 **공개 버킷**이라 `image/svg+xml` 하나만 들어와도 같은 출처에서
// 스크립트가 실행된다. 그런 값을 DB 행 하나로 켤 수 있게 두지 않는다.
//
// 진짜 차단은 Storage 가 한다(0076 이 버킷에 `allowed_mime_types`·`file_size_limit`
// 을 걸었다). 이 파일은 **같은 목록을 화면·API 가 미리 말할 수 있게** 두는 자리다 —
// 업로드가 끝난 뒤 Storage 가 거절하면 업체는 이유를 모른 채 실패만 본다.

/** 상품에 붙는 미디어는 **사진뿐이다.** 영상은 업체 단위로 남는다(용량·재생 판단이 다르다). */
export const PRODUCT_MEDIA_TYPE = "photo" as const;

/**
 * 허용 MIME. **0076 의 버킷 목록 중 이미지 부분과 같아야 한다.**
 * `db:rls` 가 둘이 같은지 대조한다 — 한쪽만 고치면 화면은 받고 Storage 가 거절한다.
 */
export const PRODUCT_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
] as const;

export type ProductImageMime = (typeof PRODUCT_IMAGE_MIME_TYPES)[number];

/** 확장자 ↔ MIME. 경로를 만들 때 쓰고, 확장자만 보고 통과시키지 않는다. */
export const PRODUCT_IMAGE_EXTENSION: Record<ProductImageMime, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
};

/** 버킷 상한과 **같은 수**여야 한다(0076 · 20MB). */
export const PRODUCT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export const PRODUCT_MEDIA_ALT_TEXT_MAX = 200;

export function isProductImageMime(value: string): value is ProductImageMime {
  return (PRODUCT_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

export type ProductMediaProblem = {
  code: "MIME_NOT_ALLOWED" | "TOO_LARGE" | "ALT_TEXT_TOO_LONG" | "LIMIT_REACHED" | "LIMIT_UNKNOWN";
  message: string;
};

/**
 * 한 장을 받을 수 있는가.
 *
 * `limit` 이 **null 이면 거절한다.** 운영이 정한 적 없는 상한을 코드가 지어내면
 * 그 값이 기준처럼 굳는다(`app_settings` 행이 없을 때의 규칙 — 0076 주석).
 */
export function productMediaProblem(input: {
  mimeType: string;
  byteSize?: number | null;
  altText?: string | null;
  currentCount: number;
  limit: number | null;
}): ProductMediaProblem | null {
  if (input.limit === null) {
    return {
      code: "LIMIT_UNKNOWN",
      message:
        "상품 사진 개수 상한이 설정되지 않아 업로드를 받지 않습니다. 운영자에게 알려 주세요.",
    };
  }

  if (input.currentCount >= input.limit) {
    return {
      code: "LIMIT_REACHED",
      message: `사진은 상품당 ${input.limit}장까지 올릴 수 있어요.`,
    };
  }

  if (!isProductImageMime(input.mimeType)) {
    return {
      code: "MIME_NOT_ALLOWED",
      message: `${PRODUCT_IMAGE_MIME_TYPES.join(" · ")} 형식만 올릴 수 있어요.`,
    };
  }

  if (typeof input.byteSize === "number" && input.byteSize > PRODUCT_IMAGE_MAX_BYTES) {
    return {
      code: "TOO_LARGE",
      message: `사진 한 장은 ${Math.floor(PRODUCT_IMAGE_MAX_BYTES / 1024 / 1024)}MB까지 올릴 수 있어요.`,
    };
  }

  if ((input.altText?.length ?? 0) > PRODUCT_MEDIA_ALT_TEXT_MAX) {
    return {
      code: "ALT_TEXT_TOO_LONG",
      message: `사진 설명은 ${PRODUCT_MEDIA_ALT_TEXT_MAX}자까지 쓸 수 있어요.`,
    };
  }

  return null;
}

/**
 * Storage 경로.
 *
 * **업체가 보낸 파일명을 경로에 쓰지 않는다.** 파일명에는 `../` 도 한글도 들어오고,
 * 공개 버킷의 경로는 그대로 URL 이 된다. 무작위 조각 + 형식에서 끌어낸 확장자만 쓴다.
 *
 * 상품 아래로 묶는 이유는 **지울 때** 드러난다 — 상품 하나의 사진을 경로 접두어로
 * 한 번에 찾을 수 있다.
 */
export function productMediaPath(input: {
  vendorId: string;
  productId: string;
  mimeType: ProductImageMime;
  /** 호출부가 만든 무작위 조각. 소문자 영숫자만. */
  slug: string;
}): string {
  const safeSlug = input.slug.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || "file";

  return `${input.vendorId}/products/${input.productId}/${safeSlug}.${PRODUCT_IMAGE_EXTENSION[input.mimeType]}`;
}

/** 그 경로가 이 상품의 것인가. 지우기 전에 확인한다(남의 경로를 넘겨받지 않게). */
export function isPathOfProduct(
  path: string,
  input: { vendorId: string; productId: string },
): boolean {
  return path.startsWith(`${input.vendorId}/products/${input.productId}/`);
}

import { describe, expect, it } from "vitest";

import {
  PRODUCT_IMAGE_MAX_BYTES,
  PRODUCT_IMAGE_MIME_TYPES,
  PRODUCT_MEDIA_ALT_TEXT_MAX,
  isPathOfProduct,
  isProductImageMime,
  productMediaPath,
  productMediaProblem,
} from "./media";

const base = { mimeType: "image/jpeg", currentCount: 0, limit: 12 };

describe("형식 허용목록", () => {
  it("이미지 다섯만 받는다", () => {
    expect([...PRODUCT_IMAGE_MIME_TYPES]).toEqual([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/avif",
      "image/gif",
    ]);
  });

  it("SVG 를 받지 않는다 — 공개 버킷에서 스크립트가 된다", () => {
    expect(isProductImageMime("image/svg+xml")).toBe(false);
    expect(productMediaProblem({ ...base, mimeType: "image/svg+xml" })).toMatchObject({
      code: "MIME_NOT_ALLOWED",
    });
  });

  it("영상도 상품 사진으로는 받지 않는다", () => {
    expect(productMediaProblem({ ...base, mimeType: "video/mp4" })).toMatchObject({
      code: "MIME_NOT_ALLOWED",
    });
  });

  it("허용 형식은 통과한다 — 늘 거절하는 검사가 아니다", () => {
    for (const mime of PRODUCT_IMAGE_MIME_TYPES) {
      expect(productMediaProblem({ ...base, mimeType: mime })).toBeNull();
    }
  });
});

describe("개수 상한", () => {
  it("상한을 모르면 거절한다 — 코드가 기본값을 지어내지 않는다", () => {
    expect(productMediaProblem({ ...base, limit: null })).toMatchObject({ code: "LIMIT_UNKNOWN" });
  });

  it("상한에 닿으면 거절한다", () => {
    expect(productMediaProblem({ ...base, currentCount: 12, limit: 12 })).toMatchObject({
      code: "LIMIT_REACHED",
    });
  });

  it("상한 직전은 통과한다 (경계)", () => {
    expect(productMediaProblem({ ...base, currentCount: 11, limit: 12 })).toBeNull();
  });

  it("상한이 0 이면 한 장도 못 올린다", () => {
    expect(productMediaProblem({ ...base, currentCount: 0, limit: 0 })).toMatchObject({
      code: "LIMIT_REACHED",
    });
  });
});

describe("용량·설명", () => {
  it("상한을 넘기면 거절한다", () => {
    expect(
      productMediaProblem({ ...base, byteSize: PRODUCT_IMAGE_MAX_BYTES + 1 }),
    ).toMatchObject({ code: "TOO_LARGE" });
  });

  it("상한 경계는 통과한다", () => {
    expect(productMediaProblem({ ...base, byteSize: PRODUCT_IMAGE_MAX_BYTES })).toBeNull();
  });

  it("크기를 모르면 크기로 막지 않는다 — Storage 가 최종 경계다", () => {
    expect(productMediaProblem({ ...base, byteSize: null })).toBeNull();
  });

  it("사진 설명 상한을 넘기면 거절한다", () => {
    expect(
      productMediaProblem({ ...base, altText: "가".repeat(PRODUCT_MEDIA_ALT_TEXT_MAX + 1) }),
    ).toMatchObject({ code: "ALT_TEXT_TOO_LONG" });
    expect(
      productMediaProblem({ ...base, altText: "가".repeat(PRODUCT_MEDIA_ALT_TEXT_MAX) }),
    ).toBeNull();
  });
});

describe("경로", () => {
  const ids = { vendorId: "v1", productId: "p1" } as const;

  it("상품 아래로 묶고 형식에서 확장자를 끌어온다", () => {
    expect(productMediaPath({ ...ids, mimeType: "image/webp", slug: "abc123" })).toBe(
      "v1/products/p1/abc123.webp",
    );
  });

  it("업체가 보낸 이름을 경로에 쓰지 않는다 — 경로 탈출을 막는다", () => {
    const path = productMediaPath({ ...ids, mimeType: "image/png", slug: "../../etc/passwd" });

    expect(path).toBe("v1/products/p1/etcpasswd.png");
    expect(path).not.toContain("..");
    expect(path).not.toContain("/etc/");
  });

  it("빈 조각이어도 경로가 성립한다", () => {
    expect(productMediaPath({ ...ids, mimeType: "image/jpeg", slug: "한글만" })).toBe(
      "v1/products/p1/file.jpg",
    );
  });

  it("남의 경로를 이 상품 것으로 보지 않는다", () => {
    expect(isPathOfProduct("v1/products/p1/a.jpg", ids)).toBe(true);
    expect(isPathOfProduct("v1/products/p2/a.jpg", ids)).toBe(false);
    expect(isPathOfProduct("v2/products/p1/a.jpg", ids)).toBe(false);
    // 업체 사진 경로(프로필 업로드)는 상품 것이 아니다.
    expect(isPathOfProduct("v1/photo/a.jpg", ids)).toBe(false);
  });
});

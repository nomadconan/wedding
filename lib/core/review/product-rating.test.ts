import { describe, expect, it } from "vitest";

import {
  RATING_COMPOSITION,
  productRatingCaption,
  rateVendor,
  type RatingSample,
} from "./rating";

/** 세 축에 같은 점수를 남긴 후기 한 건. 축 가중이 아니라 **분모**를 보는 시험이다. */
const review = (score: number): RatingSample => ({
  scorePrice: score,
  scoreResponse: score,
  scoreFulfillment: score,
});

describe("업체 평점은 상품 평점의 평균이 아니다 (C-2e)", () => {
  // 상품 A: 후기 1건(5.0) · 상품 B: 후기 3건(3.0)
  const productA = [review(5)];
  const productB = [review(3), review(3), review(3)];

  it("상품 평점은 그 상품의 후기만 센다", () => {
    expect(rateVendor(productA).overall).toBe(5);
    expect(rateVendor(productA).reviewCount).toBe(1);
    expect(rateVendor(productB).overall).toBe(3);
    expect(rateVendor(productB).reviewCount).toBe(3);
  });

  it("**업체 평점은 후기 전체의 평균이다 — 3.5 이지 4.0 이 아니다**", () => {
    const vendor = rateVendor([...productA, ...productB]);

    // (5 + 3 + 3 + 3) / 4 = 3.5
    expect(vendor.overall).toBe(3.5);
    expect(vendor.reviewCount).toBe(4);

    // 상품 평균의 평균이라면 (5 + 3) / 2 = 4.0 이 된다. 그것이 아님을 못박는다.
    const meanOfProductMeans =
      (rateVendor(productA).overall! + rateVendor(productB).overall!) / 2;
    expect(meanOfProductMeans).toBe(4);
    expect(vendor.overall).not.toBe(meanOfProductMeans);
  });

  it("상품을 잘게 쪼개도 업체 평점이 오르지 않는다 — 상품 수는 무게가 아니다", () => {
    const together = rateVendor([review(5), review(3), review(3), review(3)]);
    // 같은 후기 넷을 상품 넷으로 쪼갠 셈 — 업체 평점은 그대로여야 한다.
    const split = rateVendor([...productA, ...productB]);

    expect(together.overall).toBe(split.overall);
    expect(together.reviewCount).toBe(split.reviewCount);
  });

  it("후기가 없는 상품은 0 이 아니라 null 이다", () => {
    const none = rateVendor([]);

    expect(none.overall).toBeNull();
    expect(none.reviewCount).toBe(0);
  });
});

describe("상품 평점은 분모를 밝힌다", () => {
  it("건수 없이 나가지 않는다", () => {
    const caption = productRatingCaption(rateVendor([review(4), review(5)]));

    expect(caption).toContain("2건");
    expect(caption).toContain("이 상품");
  });

  it("업체 문구와 구분된다 — 같은 숫자가 두 가지를 뜻하지 않게", () => {
    expect(productRatingCaption(rateVendor([review(4)]))).toContain("이 상품");
  });

  it("없으면 없다고 말한다 — 0.0 을 만들지 않는다", () => {
    const caption = productRatingCaption(rateVendor([]));

    expect(caption).toContain("아직");
    expect(caption).not.toContain("0");
  });
});

describe("합산 규칙이 값으로 적혀 있다", () => {
  it("코드와 규칙 문장을 갖는다 — 화면·API 가 함께 내보낸다", () => {
    expect(RATING_COMPOSITION.code).toBe("reviews_flat_v1");
    expect(RATING_COMPOSITION.rules.length).toBeGreaterThan(0);
    expect(RATING_COMPOSITION.rules.join(" ")).toContain("다시 평균 내지 않습니다");
  });
});

import { describe, expect, it } from "vitest";

import { toProductDescription } from "./content";
import {
  NO_PRODUCT_BODY_NOTE,
  NO_PRODUCT_PHOTO_NOTE,
  PENDING_SECTIONS,
  PENDING_SECTION_NOTE,
  belongsToVendor,
  hasDescription,
  photoSection,
  priceBaselineView,
} from "./detail";

describe("사진 자리", () => {
  it("사진이 있으면 그대로 준다", () => {
    const photos = [{ id: "a", url: "http://x/a.jpg", altText: null }];

    expect(photoSection(photos)).toEqual({ kind: "photos", photos });
  });

  it("없으면 없다고 적는다 — 가짜 이미지를 만들지 않는다", () => {
    expect(photoSection([])).toEqual({ kind: "none", note: NO_PRODUCT_PHOTO_NOTE });
  });
});

describe("본문 자리", () => {
  it("본문이 있으면 있다고 한다", () => {
    expect(hasDescription(toProductDescription("## 구성"))).toBe(true);
  });

  it("없거나 모르는 모양이면 없다고 한다", () => {
    expect(hasDescription(null)).toBe(false);
    expect(hasDescription({})).toBe(false);
    expect(hasDescription({ v: 1, source: "   " })).toBe(false);
    expect(NO_PRODUCT_BODY_NOTE.length).toBeGreaterThan(0);
  });
});

describe("참가격 비교", () => {
  const note = "이 지역·카테고리는 아직 비교 기준이 없어요.";

  it("기준이 있으면 편차를 준다", () => {
    expect(
      priceBaselineView({
        gapBp: -1200,
        p50: 10_000_000,
        sampleSize: 7,
        sourceNote: "업체가 등록한 판매가를 모은 값입니다.",
        noBaselineNote: note,
      }),
    ).toMatchObject({ kind: "measured", gapBp: -1200, p50: 10_000_000, sampleSize: 7 });
  });

  it("**기준이 없으면 0이 아니라 '기준 없음' 이다**", () => {
    const view = priceBaselineView({
      gapBp: null,
      p50: null,
      sampleSize: null,
      sourceNote: null,
      noBaselineNote: note,
    });

    expect(view).toEqual({ kind: "no-baseline", note });
    // 0 으로 떨어지지 않는다 — "딱 중앙값" 이라는 없는 사실을 말하면 안 된다.
    expect(view).not.toHaveProperty("gapBp");
  });

  it("조각 하나만 없어도 기준 없음이다 — 반쪽짜리 비교를 그리지 않는다", () => {
    const partial = { gapBp: -100, p50: 1000, sampleSize: 9, sourceNote: "출처", noBaselineNote: note };

    expect(priceBaselineView({ ...partial, p50: null }).kind).toBe("no-baseline");
    expect(priceBaselineView({ ...partial, sampleSize: null }).kind).toBe("no-baseline");
    expect(priceBaselineView({ ...partial, sourceNote: null }).kind).toBe("no-baseline");
    expect(priceBaselineView({ ...partial, gapBp: null }).kind).toBe("no-baseline");
  });

  it("편차 0 은 기준 없음과 다르다 — 같은 값이라는 사실이다", () => {
    const view = priceBaselineView({
      gapBp: 0,
      p50: 1000,
      sampleSize: 5,
      sourceNote: "출처",
      noBaselineNote: note,
    });

    expect(view.kind).toBe("measured");
  });
});

describe("경로의 업체와 상품의 업체", () => {
  it("같으면 통과한다", () => {
    expect(belongsToVendor({ vendorId: "v1" }, "v1")).toBe(true);
  });

  it("다르면 막는다 — 같은 상품이 두 주소를 갖지 않는다", () => {
    expect(belongsToVendor({ vendorId: "v1" }, "v2")).toBe(false);
  });

  it("상품이 없으면 막는다", () => {
    expect(belongsToVendor(null, "v1")).toBe(false);
  });
});

describe("아직 열지 않은 자리", () => {
  it("셋을 말한다 — 빈 목록이 아니다", () => {
    expect([...PENDING_SECTIONS]).toEqual(["styleTags", "reviews", "leadTime"]);
  });

  it("모든 자리에 문구가 있다 — 조용히 빠지는 자리가 없다", () => {
    for (const section of PENDING_SECTIONS) {
      expect(PENDING_SECTION_NOTE[section]?.length ?? 0).toBeGreaterThan(10);
    }
  });

  it("문구가 내부 어휘(태스크 번호)를 화면으로 내보내지 않는다", () => {
    for (const note of Object.values(PENDING_SECTION_NOTE)) {
      expect(note).not.toMatch(/C-2[a-f]|C-4[a-e]|F-C-\d+/);
    }
  });
});

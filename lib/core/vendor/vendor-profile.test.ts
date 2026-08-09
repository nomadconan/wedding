import { describe, expect, it } from "vitest";

import {
  VENDOR_FACILITIES,
  VENDOR_FACILITY_LABEL,
  VENDOR_MEDIA_MAX,
  VendorMediaMutationSchema,
  VendorProfileInputSchema,
  VendorProfileUpdateSchema,
  diffProfileFields,
} from "../schemas/vendor-profile";

const base = {
  regionCode: "서울 강남",
  address: "서울시 강남구 테헤란로 1",
  addressDetail: "3층",
  capacityMin: 100,
  capacityMax: 300,
  facilities: ["parking", "photo_zone"],
  intro: "직접 운영하는 단독 홀입니다.",
};

describe("VendorProfileInputSchema (F-V-02)", () => {
  it("정상 입력을 통과시킨다", () => {
    const parsed = VendorProfileInputSchema.parse(base);

    expect(parsed.capacityMin).toBe(100);
    expect(parsed.facilities).toEqual(["parking", "photo_zone"]);
  });

  it("선택 항목은 비워 둘 수 있다 — 심사 중에도 부분 입력이 가능해야 한다", () => {
    const parsed = VendorProfileInputSchema.parse({ regionCode: "서울 강남" });

    expect(parsed.address).toBeNull();
    expect(parsed.capacityMin).toBeNull();
    expect(parsed.facilities).toEqual([]);
    expect(parsed.intro).toBeNull();
  });

  it("수용 인원 하한이 상한보다 크면 거부한다", () => {
    expect(() =>
      VendorProfileInputSchema.parse({ ...base, capacityMin: 400, capacityMax: 300 }),
    ).toThrow();
  });

  it("하한·상한이 같은 값은 허용한다 (경계)", () => {
    expect(() =>
      VendorProfileInputSchema.parse({ ...base, capacityMin: 200, capacityMax: 200 }),
    ).not.toThrow();
  });

  it("한쪽만 입력해도 통과한다", () => {
    expect(() => VendorProfileInputSchema.parse({ ...base, capacityMax: null })).not.toThrow();
    expect(() => VendorProfileInputSchema.parse({ ...base, capacityMin: null })).not.toThrow();
  });

  it("음수·소수 수용 인원을 거부한다", () => {
    expect(() => VendorProfileInputSchema.parse({ ...base, capacityMin: -1 })).toThrow();
    expect(() => VendorProfileInputSchema.parse({ ...base, capacityMax: 150.5 })).toThrow();
  });

  it("지역이 비면 거부한다", () => {
    expect(() => VendorProfileInputSchema.parse({ ...base, regionCode: "" })).toThrow();
  });

  it("소개문 2000자 상한을 넘기면 거부한다", () => {
    expect(() => VendorProfileInputSchema.parse({ ...base, intro: "가".repeat(2001) })).toThrow();
    expect(() => VendorProfileInputSchema.parse({ ...base, intro: "가".repeat(2000) })).not.toThrow();
  });

  it("정의되지 않은 시설 코드를 거부한다 — 자유 입력이면 탐색 필터가 성립하지 않는다", () => {
    expect(() => VendorProfileInputSchema.parse({ ...base, facilities: ["hot_spring"] })).toThrow();
  });

  it("업체명·카테고리는 프로필에서 바꿀 수 없다 (심사 대상 정보)", () => {
    const parsed = VendorProfileInputSchema.parse({
      ...base,
      name: "다른 이름",
      category: "studio",
      status: "active",
    } as Record<string, unknown>);

    expect(parsed).not.toHaveProperty("name");
    expect(parsed).not.toHaveProperty("category");
    expect(parsed).not.toHaveProperty("status");
  });

  it("시설 코드에 광고성·등급성 값이 없다 (CLAUDE.md §2.2)", () => {
    for (const banned of ["premium", "recommended", "sponsored", "best", "vip"]) {
      expect(VENDOR_FACILITIES).not.toContain(banned);
    }
  });

  it("모든 시설 코드에 라벨이 있다", () => {
    for (const code of VENDOR_FACILITIES) {
      expect(VENDOR_FACILITY_LABEL[code]).toBeTruthy();
    }
  });
});

describe("VendorMediaMutationSchema", () => {
  it("빈 묶음이 기본값이다", () => {
    const parsed = VendorMediaMutationSchema.parse({});

    expect(parsed).toEqual({ add: [], remove: [], order: [], updateAlt: [] });
  });

  it("한 번에 10개까지만 추가한다", () => {
    const add = Array.from({ length: 11 }, (_, i) => ({ type: "photo" as const, fileName: `${i}.jpg` }));

    expect(() => VendorMediaMutationSchema.parse({ add })).toThrow();
  });

  it("정의되지 않은 미디어 종류를 거부한다", () => {
    expect(() =>
      VendorMediaMutationSchema.parse({ add: [{ type: "pdf", fileName: "a.pdf" }] }),
    ).toThrow();
  });

  it("삭제·정렬 대상은 uuid 여야 한다", () => {
    expect(() => VendorMediaMutationSchema.parse({ remove: ["not-a-uuid"] })).toThrow();
    expect(() => VendorMediaMutationSchema.parse({ order: ["not-a-uuid"] })).toThrow();
  });

  it("상한이 화면·API 양쪽에서 같은 값이다", () => {
    expect(VENDOR_MEDIA_MAX).toBe(30);
  });
});

describe("VendorProfileUpdateSchema", () => {
  it("media 를 생략하면 빈 묶음으로 채운다", () => {
    const parsed = VendorProfileUpdateSchema.parse({ profile: base });

    expect(parsed.media.add).toEqual([]);
  });
});

describe("diffProfileFields (변경 이력)", () => {
  it("바뀐 필드만 골라낸다", () => {
    const changed = diffProfileFields(
      { intro: "before", capacity_min: 100 },
      { intro: "after", capacity_min: 100 },
    );

    expect(changed).toEqual(["intro"]);
  });

  it("null 과 undefined 를 같은 값으로 본다 — 미입력이 변경으로 잡히면 이력이 잡음이 된다", () => {
    expect(diffProfileFields({ address: null }, {})).toEqual([]);
  });

  it("배열은 순서가 다르면 변경으로 본다 — 미디어 정렬도 이력이다", () => {
    expect(diffProfileFields({ media: ["a", "b"] }, { media: ["b", "a"] })).toEqual(["media"]);
    expect(diffProfileFields({ media: ["a", "b"] }, { media: ["a", "b"] })).toEqual([]);
  });

  it("추가된 필드도 잡는다", () => {
    expect(diffProfileFields({}, { intro: "new" })).toEqual(["intro"]);
  });
});

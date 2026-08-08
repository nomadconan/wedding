import { describe, expect, it } from "vitest";

import {
  VendorApplicationInputSchema,
  VendorReviewInputSchema,
} from "../schemas/vendor";
import {
  isValidBusinessNumber,
  maskBusinessNumber,
  maskPhone,
  normalizeBusinessNumber,
  normalizeMailOrderNumber,
} from "./business-number";

/** 체크섬을 만족하는 테스트용 번호. 실재 사업자와 무관하다. */
const VALID_BIZ_NO = "1208147521";

describe("사업자등록번호 (F-V-01)", () => {
  it("하이픈·공백을 걷어낸다", () => {
    expect(normalizeBusinessNumber("120-81-47521")).toBe(VALID_BIZ_NO);
    expect(normalizeBusinessNumber(" 120 81 47521 ")).toBe(VALID_BIZ_NO);
  });

  it("체크섬이 맞는 번호를 통과시킨다", () => {
    expect(isValidBusinessNumber(VALID_BIZ_NO)).toBe(true);
    expect(isValidBusinessNumber("120-81-47521")).toBe(true);
  });

  it("체크섬이 틀린 번호를 거른다 — 오타가 심사 큐로 넘어가지 않게", () => {
    expect(isValidBusinessNumber("1208147522")).toBe(false);
    expect(isValidBusinessNumber("1234567890")).toBe(false);
  });

  it("자릿수가 다르면 거른다", () => {
    expect(isValidBusinessNumber("12081475")).toBe(false);
    expect(isValidBusinessNumber("120814752100")).toBe(false);
    expect(isValidBusinessNumber("")).toBe(false);
  });

  it("마스킹은 뒤 5자리를 가린다", () => {
    expect(maskBusinessNumber(VALID_BIZ_NO)).toBe("120-81-*****");
    expect(maskBusinessNumber("120-81-47521")).toBe("120-81-*****");
  });

  it("마스킹 결과에 원본 뒷자리가 남지 않는다", () => {
    const masked = maskBusinessNumber(VALID_BIZ_NO);

    expect(masked).not.toContain("47521");
    expect(masked).not.toContain("4752");
  });

  it("길이가 안 맞는 입력도 원문을 흘리지 않는다", () => {
    expect(maskBusinessNumber("12345")).toBe("*****");
    expect(maskBusinessNumber("")).toBe("*");
  });
});

describe("통신판매업 신고번호", () => {
  it("공백만 정리하고 형식을 강제하지 않는다 — 지자체마다 표기가 다르다", () => {
    expect(normalizeMailOrderNumber("  2026-서울강남-01234 ")).toBe("2026-서울강남-01234");
    expect(normalizeMailOrderNumber("제 2026-서울강남-01234 호")).toBe("제 2026-서울강남-01234 호");
  });
});

describe("연락처 마스킹 (§7.3)", () => {
  it("가운데를 가리고 앞 3자리·뒤 4자리만 남긴다", () => {
    expect(maskPhone("01012345678")).toBe("010-****-5678");
    expect(maskPhone("010-1234-5678")).toBe("010-****-5678");
  });

  it("너무 짧은 값은 통째로 가린다", () => {
    expect(maskPhone("1234")).toBe("****");
    expect(maskPhone("")).toBe("*");
  });
});

describe("VendorApplicationInputSchema (§4.3)", () => {
  const base = {
    name: "더미 웨딩홀",
    category: "hall" as const,
    regionCode: "seoul-gangnam",
    businessNumber: "120-81-47521",
    representativeName: "홍길동",
    contactPhone: "010-1234-5678",
  };

  it("정상 입력을 통과시키고 사업자번호를 숫자만으로 정규화한다", () => {
    const parsed = VendorApplicationInputSchema.parse(base);

    expect(parsed.businessNumber).toBe(VALID_BIZ_NO);
    expect(parsed.documents).toEqual([]);
  });

  it("체크섬이 틀린 사업자번호를 거부한다", () => {
    expect(() => VendorApplicationInputSchema.parse({ ...base, businessNumber: "1234567890" })).toThrow();
  });

  it("업체명·대표자명·연락처가 비면 거부한다", () => {
    expect(() => VendorApplicationInputSchema.parse({ ...base, name: "A" })).toThrow();
    expect(() => VendorApplicationInputSchema.parse({ ...base, representativeName: "" })).toThrow();
    expect(() => VendorApplicationInputSchema.parse({ ...base, contactPhone: "123" })).toThrow();
  });

  it("정의되지 않은 카테고리를 거부한다", () => {
    expect(() => VendorApplicationInputSchema.parse({ ...base, category: "flower" })).toThrow();
  });

  it("통신판매업 신고번호는 없어도 된다 — 미신고 업체가 있다", () => {
    expect(() => VendorApplicationInputSchema.parse({ ...base, mailOrderNumber: "" })).not.toThrow();
  });

  it("서류는 10개를 넘길 수 없다", () => {
    const documents = Array.from({ length: 11 }, (_, i) => ({
      docType: "etc" as const,
      fileName: `f${i}.pdf`,
    }));

    expect(() => VendorApplicationInputSchema.parse({ ...base, documents })).toThrow();
  });
});

describe("VendorReviewInputSchema (§4.4 · F-A-01)", () => {
  it("승인은 사유 없이 가능하다", () => {
    expect(() => VendorReviewInputSchema.parse({ action: "approve" })).not.toThrow();
  });

  it("반려는 사유가 없으면 거부한다", () => {
    expect(() => VendorReviewInputSchema.parse({ action: "reject" })).toThrow();
    expect(() => VendorReviewInputSchema.parse({ action: "reject", note: "   " })).toThrow();
  });

  it("보완 요청도 사유가 필수다", () => {
    expect(() => VendorReviewInputSchema.parse({ action: "request_revision" })).toThrow();
    expect(() =>
      VendorReviewInputSchema.parse({ action: "request_revision", note: "사업자등록증이 흐립니다." }),
    ).not.toThrow();
  });

  it("정의되지 않은 액션을 거부한다", () => {
    expect(() => VendorReviewInputSchema.parse({ action: "suspend", note: "x" })).toThrow();
  });
});

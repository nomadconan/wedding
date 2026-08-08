import { describe, expect, it } from "vitest";

import {
  BLOCKING_MASK_PATTERNS,
  BLOCKING_PII_KINDS,
  MASK_PATTERNS,
  MaskingIncompleteError,
  PII_KINDS,
  assertMaskingComplete,
  detectResidualPii,
  isMaskingComplete,
  maskText,
  unmaskText,
} from "./index";

describe("maskText — 패턴별 치환", () => {
  const cases: Array<{ kind: string; input: string; token: string; original: string }> = [
    {
      kind: "주민등록번호",
      input: "신부 주민등록번호는 900101-2345678 입니다.",
      token: "[RRN_1]",
      original: "900101-2345678",
    },
    {
      kind: "사업자등록번호",
      input: "사업자등록번호 123-45-67890 으로 발행합니다.",
      token: "[BIZ_1]",
      original: "123-45-67890",
    },
    {
      kind: "휴대전화",
      input: "연락처 010-1234-5678 로 회신 바랍니다.",
      token: "[PHONE_1]",
      original: "010-1234-5678",
    },
    {
      kind: "유선전화",
      input: "대표번호 02-555-1234 로 문의하세요.",
      token: "[PHONE_1]",
      original: "02-555-1234",
    },
    {
      kind: "이메일",
      input: "계약서는 hong.gildong@example.com 으로 보냅니다.",
      token: "[EMAIL_1]",
      original: "hong.gildong@example.com",
    },
    {
      kind: "계좌번호",
      input: "입금 계좌는 국민은행 123456-01-789012 입니다.",
      token: "[ACCOUNT_1]",
      original: "국민은행 123456-01-789012",
    },
    {
      kind: "주소",
      input: "예식장은 서울특별시 강남구 테헤란로 123 입니다.",
      token: "[ADDR_1]",
      original: "서울특별시 강남구 테헤란로 123",
    },
    {
      kind: "이름",
      input: "신랑 홍길동 님과 계약합니다.",
      token: "[NAME_1]",
      original: "홍길동",
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.kind}를 토큰으로 치환한다`, () => {
      const result = maskText(testCase.input);

      expect(result.masked).toContain(testCase.token);
      expect(result.masked).not.toContain(testCase.original);
      expect(result.map[testCase.token]).toBe(testCase.original);
    });
  }

  it("여러 종류가 섞인 문서를 한 번에 처리한다", () => {
    const text = [
      "신랑 홍길동 님 (010-1234-5678, hong@example.com)",
      "주민등록번호 900101-1234567",
      "사업자등록번호 123-45-67890",
      "입금 계좌: 신한은행 110-123-456789",
      "주소: 경기도 성남시 분당로 45",
    ].join("\n");

    const result = maskText(text);

    expect(result.complete).toBe(true);
    expect(result.counts.phone).toBeGreaterThanOrEqual(1);
    expect(result.counts.email).toBe(1);
    expect(result.counts.rrn).toBe(1);
    expect(result.counts.biz_no).toBe(1);
    expect(result.counts.account).toBeGreaterThanOrEqual(1);
    expect(result.counts.name).toBeGreaterThanOrEqual(1);
    expect(result.counts.address).toBeGreaterThanOrEqual(1);
  });

  it("같은 값은 같은 토큰으로 치환한다 (결정적)", () => {
    const result = maskText("홍길동 님과 홍길동 님의 배우자");

    const tokens = result.masked.match(/\[NAME_\d+\]/g) ?? [];
    expect(tokens.length).toBe(2);
    expect(new Set(tokens).size).toBe(1);
  });

  it("같은 입력이면 항상 같은 출력이 나온다", () => {
    const text = "신랑 홍길동 님 010-1234-5678";

    expect(maskText(text).masked).toBe(maskText(text).masked);
  });

  it("마스킹할 것이 없으면 원문을 그대로 둔다", () => {
    const text = "계약 해지 시 계약금은 총액의 10%로 한다.";
    const result = maskText(text);

    expect(result.masked).toBe(text);
    expect(Object.keys(result.map)).toHaveLength(0);
    expect(result.complete).toBe(true);
  });

  it("날짜 표기를 계좌번호로 오인하지 않는다", () => {
    const result = maskText("예식일은 2026-10-01 입니다.");

    expect(result.masked).toContain("2026-10-01");
    expect(result.counts.account).toBe(0);
  });

  it("금액·비율 숫자를 건드리지 않는다", () => {
    const text = "총 금액 15,000,000원, 위약금은 총액의 20%로 한다.";

    expect(maskText(text).masked).toBe(text);
  });

  it("이름 자리의 일반 명사를 이름으로 오인하지 않는다", () => {
    const result = maskText("고객님께 안내드립니다. 담당자 확인 후 회신합니다.");

    expect(result.masked).toContain("고객님");
    expect(result.masked).toContain("담당자 확인");
    expect(result.counts.name).toBe(0);
  });
});

describe("마스킹 맵", () => {
  it("맵은 반환값으로만 전달된다 (토큰 → 원문)", () => {
    const result = maskText("연락처 010-1234-5678");

    expect(Object.entries(result.map)).toEqual([["[PHONE_1]", "010-1234-5678"]]);
  });

  it("unmaskText 로 원문을 복원할 수 있다", () => {
    const text = "신랑 홍길동 님 010-1234-5678 hong@example.com";
    const result = maskText(text);

    expect(unmaskText(result.masked, result.map)).toBe(text);
  });
});

describe("마스킹 실패 판정 (§5.2 3단계 — 미검출 위험 패턴 존재 시 중단)", () => {
  it("마스킹되지 않은 텍스트에서 잔존 위험을 찾아낸다", () => {
    const risks = detectResidualPii("연락처 010-1234-5678, 주민번호 900101-1234567");

    expect(risks.length).toBeGreaterThanOrEqual(2);
    expect(risks.map((r) => r.kind)).toContain("phone");
    expect(risks.map((r) => r.kind)).toContain("rrn");
  });

  it("잔존 위험 결과에 원문 값을 담지 않는다", () => {
    const risks = detectResidualPii("연락처 010-1234-5678");
    const serialized = JSON.stringify(risks);

    expect(serialized).not.toContain("010-1234-5678");
    expect(risks[0]).toHaveProperty("index");
    expect(risks[0]).toHaveProperty("length");
  });

  it("일부 종류만 마스킹하면 나머지가 잔존으로 잡힌다", () => {
    const text = "신랑 홍길동 010-1234-5678";
    const result = maskText(text, { kinds: ["name"] });

    expect(result.complete).toBe(false);
    expect(result.residual.map((r) => r.kind)).toContain("phone");
  });

  it("전 종류를 마스킹하면 잔존이 없다", () => {
    const result = maskText("신랑 홍길동 010-1234-5678 hong@example.com 123-45-67890");

    expect(result.residual).toEqual([]);
    expect(result.complete).toBe(true);
    expect(isMaskingComplete(result.masked)).toBe(true);
  });

  it("assertMaskingComplete 는 잔존이 있으면 던진다", () => {
    expect(() => assertMaskingComplete("연락처 010-1234-5678")).toThrow(MaskingIncompleteError);
  });

  it("assertMaskingComplete 오류 메시지에 원문이 실리지 않는다", () => {
    try {
      assertMaskingComplete("연락처 010-1234-5678");
      throw new Error("여기 도달하면 안 된다");
    } catch (error) {
      expect(error).toBeInstanceOf(MaskingIncompleteError);
      expect((error as Error).message).not.toContain("010-1234-5678");
      expect((error as Error).message).toContain("phone");
    }
  });

  it("assertMaskingComplete 는 깨끗한 텍스트에 대해 통과한다", () => {
    expect(() => assertMaskingComplete("계약금은 총액의 10%로 한다.")).not.toThrow();
  });

  it("이름·주소는 차단 판정 대상이 아니다", () => {
    // 정규식만으로 완전 검출을 보장할 수 없으므로 차단 사유로 쓰지 않는다.
    expect(isMaskingComplete("김철수 씨와 서울특별시 강남구 테헤란로 1")).toBe(true);
  });
});

describe("마스킹 패턴 목록 무결성", () => {
  it("모든 종류에 최소 한 개의 패턴이 있다", () => {
    for (const kind of PII_KINDS) {
      const patterns = MASK_PATTERNS.filter((p) => p.kind === kind);
      expect(patterns.length, `${kind} 패턴 없음`).toBeGreaterThan(0);
    }
  });

  it("정규식에 g 플래그가 없다 (lastIndex 상태 공유 방지)", () => {
    for (const pattern of MASK_PATTERNS) {
      expect(pattern.regex.global, `${pattern.id} 에 g 플래그가 있습니다.`).toBe(false);
    }
  });

  it("패턴 id 가 중복되지 않는다", () => {
    const ids = MASK_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("차단 대상 패턴은 결정적 검출이 가능한 종류만 포함한다", () => {
    expect([...BLOCKING_PII_KINDS]).toEqual(["rrn", "biz_no", "phone", "email", "account"]);
    expect(BLOCKING_PII_KINDS).not.toContain("name");
    expect(BLOCKING_PII_KINDS).not.toContain("address");
  });

  it("차단 패턴 목록이 종류 필터와 일치한다", () => {
    for (const pattern of BLOCKING_MASK_PATTERNS) {
      expect(BLOCKING_PII_KINDS).toContain(pattern.kind);
    }
    expect(BLOCKING_MASK_PATTERNS.length).toBeLessThan(MASK_PATTERNS.length);
  });

  it("사업자번호가 계좌번호 패턴보다 먼저 적용된다", () => {
    // 3-2-5 형태는 두 패턴에 모두 걸린다. 더 구체적인 쪽이 먼저 소비해야 한다.
    const bizIndex = MASK_PATTERNS.findIndex((p) => p.kind === "biz_no");
    const accountIndex = MASK_PATTERNS.findIndex((p) => p.kind === "account");

    expect(bizIndex).toBeLessThan(accountIndex);
    expect(maskText("사업자등록번호 123-45-67890").counts.biz_no).toBe(1);
    expect(maskText("사업자등록번호 123-45-67890").counts.account).toBe(0);
  });
});

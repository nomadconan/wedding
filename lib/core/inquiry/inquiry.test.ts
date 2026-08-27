import { describe, expect, it } from "vitest";

import {
  CONTACT_PATHS,
  DECLINE_REASONS,
  INQUIRY_NOTE_MAX,
  TARGET_STATUSES,
  canAccept,
  capViolations,
  declineReasonLabel,
  discountRateBp,
  effectiveMaxTargets,
  formatDuration,
  inboxOrder,
  isAwaiting,
  isExpired,
  isPastDate,
  requestProblem,
  slaDeadline,
  slaState,
  sumLines,
  targetCountProblem,
  type QuoteLine,
  type SlaState,
} from "./inquiry";
import {
  CreateInquirySchema,
  CreateQuoteSchema,
  InquiryActionSchema,
  VendorQuoteActionSchema,
} from "../schemas/inquiry";
import { QnaActionSchema, VendorQnaActionSchema } from "../schemas/qna";
import { EXPLORE_SORTS, EXPLORE_SORT_PENDING } from "../schemas/explore";

const UUID_A = "00000000-0000-0000-0000-0000000000a1";
const UUID_B = "00000000-0000-0000-0000-0000000000b1";

describe("세 경로 구분 (F-C-13 · F-C-27 · F-C-28)", () => {
  it("셋 다 언제 쓰는지와 무엇이 남는지를 갖는다", () => {
    expect(CONTACT_PATHS).toHaveLength(3);

    for (const path of CONTACT_PATHS) {
      expect(path.when.length).toBeGreaterThan(0);
      expect(path.result.length).toBeGreaterThan(0);
    }
  });

  it("결과물이 서로 다르다 — 겹치면 구분할 이유가 없다", () => {
    const results = CONTACT_PATHS.map((path) => path.result);

    expect(new Set(results).size).toBe(results.length);
  });
});

describe("미응답과 거절의 구분", () => {
  it("기다리는 중일 때만 SLA 시계가 돈다", () => {
    expect(isAwaiting("pending")).toBe(true);
    expect(isAwaiting("declined")).toBe(false);
    expect(isAwaiting("responded")).toBe(false);
  });

  // 거절은 업체가 **답한** 것이다. 지연으로 세면 답한 업체를 늦었다고 말하게 된다.
  it("거절은 응답이므로 시계가 멈춘다", () => {
    const threshold = { minutes: 60, warnPercent: 75 };
    const now = new Date("2026-08-11T12:00:00Z");

    expect(slaState("declined", "2026-08-01T00:00:00Z", now, threshold)?.level).toBe("clear");
    expect(slaState("pending", "2026-08-01T00:00:00Z", now, threshold)?.level).toBe("overdue");
  });

  it("상태 값 집합이 DB CHECK 와 같다", () => {
    expect([...TARGET_STATUSES]).toEqual([
      "pending",
      "responded",
      "declined",
      "expired",
      "withdrawn",
    ]);
  });

  it("거절 사유는 코드로 관리한다 — 자유 텍스트가 아니다", () => {
    expect(DECLINE_REASONS.length).toBeGreaterThan(0);
    expect(declineReasonLabel("no_availability")).not.toBe("사유 없음");
    expect(declineReasonLabel("업체가 마음대로 적은 사유")).toBe("사유 없음");
  });
});

describe("응답 SLA", () => {
  const threshold = { minutes: 60, warnPercent: 75 };
  const now = new Date("2026-08-11T12:00:00Z");

  it("눈금이 없으면 상태를 만들지 않는다 — 기본값을 지어내지 않는다", () => {
    expect(slaState("pending", "2026-08-11T00:00:00Z", now, null)).toBeNull();
    expect(
      slaState("pending", "2026-08-11T00:00:00Z", now, { minutes: 0, warnPercent: 75 }),
    ).toBeNull();
  });

  // ── 구간 경계 (CLAUDE.md §7.3) ──────────────────────────────────────────────
  it("경계 직전은 waiting 이다", () => {
    expect(slaState("pending", "2026-08-11T11:16:00Z", now, threshold)?.level).toBe("waiting");
  });

  it("warnPercent 당일(45분)은 due 다 — 경계값은 넘어간 쪽에 속한다", () => {
    const state = slaState("pending", "2026-08-11T11:15:00Z", now, threshold);

    expect(state?.level).toBe("due");
    expect(state?.elapsedMinutes).toBe(45);
    expect(state?.remainingMinutes).toBe(15);
  });

  it("눈금 당일(60분)은 overdue 다", () => {
    const state = slaState("pending", "2026-08-11T11:00:00Z", now, threshold);

    expect(state?.level).toBe("overdue");
    expect(state?.remainingMinutes).toBe(0);
  });

  it("미래 시각은 0분 경과로 클램프한다", () => {
    expect(slaState("pending", "2026-08-11T13:00:00Z", now, threshold)?.elapsedMinutes).toBe(0);
  });

  it("응답 기한은 보낸 시각 + 눈금이다", () => {
    expect(slaDeadline("2026-08-11T00:00:00.000Z", threshold)).toBe("2026-08-11T01:00:00.000Z");
    expect(slaDeadline("2026-08-11T00:00:00.000Z", null)).toBeNull();
  });

  it("경과 시간을 사람이 읽는 단위로 줄여 쓴다", () => {
    expect(formatDuration(45)).toBe("45분");
    expect(formatDuration(90)).toBe("1시간 30분");
    expect(formatDuration(2880)).toBe("2일");
  });
});

describe("업체 인박스 정렬 (F-V-07 미응답 우선)", () => {
  const row = (id: string, level: SlaState["level"], elapsed: number | null, createdAt: string) => ({
    id,
    sla: { level, elapsedMinutes: elapsed, remainingMinutes: null } as SlaState,
    createdAt,
  });

  it("지연이 위, 그다음 임박, 대기, 응답 완료 순이다", () => {
    const sorted = inboxOrder([
      row("clear", "clear", null, "2026-08-11T05:00:00Z"),
      row("waiting", "waiting", 10, "2026-08-11T04:00:00Z"),
      row("overdue", "overdue", 200, "2026-08-11T01:00:00Z"),
      row("due", "due", 50, "2026-08-11T03:00:00Z"),
    ]);

    expect(sorted.map((item) => item.id)).toEqual(["overdue", "due", "waiting", "clear"]);
  });

  it("같은 등급이면 오래 기다린 쪽이 위다", () => {
    const sorted = inboxOrder([
      row("short", "overdue", 100, "2026-08-11T05:00:00Z"),
      row("long", "overdue", 400, "2026-08-11T01:00:00Z"),
    ]);

    expect(sorted.map((item) => item.id)).toEqual(["long", "short"]);
  });
});

describe("상한 검증 — 할인만 허용, 할증 금지", () => {
  const base = (amount: number, cap: number): QuoteLine => ({
    itemType: "base",
    productId: UUID_A,
    productOptionId: null,
    amount,
    capAmount: cap,
  });

  it("상한과 같은 금액은 통과한다 — 할인 없음이 곧 위반은 아니다", () => {
    expect(capViolations([base(10_000_000, 10_000_000)])).toEqual([]);
  });

  it("상한보다 낮으면 통과한다 (할인)", () => {
    expect(capViolations([base(9_000_000, 10_000_000)])).toEqual([]);
  });

  // 고객이 탐색·장바구니에서 본 가격이 상한이다. 넘으면 그 화면들이 거짓이 된다.
  it("상한을 1원이라도 넘으면 거부한다 (경계)", () => {
    const violations = capViolations([base(10_000_001, 10_000_000)]);

    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe("QUOTE_OVER_CAP");
  });

  it("음수·소수 금액을 거부한다 — 금액은 원 단위 정수다", () => {
    expect(capViolations([base(-1, 10)])[0].code).toBe("QUOTE_AMOUNT_INVALID");
    expect(capViolations([base(1.5, 10)])[0].code).toBe("QUOTE_AMOUNT_INVALID");
  });

  it("위반한 줄만 골라낸다", () => {
    const violations = capViolations([
      base(9_000_000, 10_000_000),
      { ...base(600_000, 500_000), itemType: "option", productOptionId: UUID_B },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0].productOptionId).toBe(UUID_B);
  });

  it("총액과 상한 총액은 줄의 합이다 — 업체가 따로 적는 값이 아니다", () => {
    const sum = sumLines([base(9_000_000, 10_000_000), base(400_000, 500_000)]);

    expect(sum).toEqual({ total: 9_400_000, capTotal: 10_500_000 });
  });

  it("할인율은 상한 대비 basis point 정수다", () => {
    expect(discountRateBp(10_000_000, 9_000_000)).toBe(1000);
    expect(discountRateBp(10_000_000, 10_000_000)).toBe(0);
    // 상한이 0이면 비교 대상이 없다. 0으로 나누지 않는다.
    expect(discountRateBp(0, 0)).toBe(0);
  });
});

describe("1:N 대상 상한 (§2.1 — 최대 5곳)", () => {
  it("상한을 코드에 박지 않는다 — 값을 받아 판정만 한다", () => {
    expect(targetCountProblem(5, 5)).toBeNull();
    expect(targetCountProblem(6, 5)).not.toBeNull();
    expect(targetCountProblem(6, 10)).toBeNull();
  });

  it("한 곳도 안 고르면 막는다", () => {
    expect(targetCountProblem(0, 5)).not.toBeNull();
  });

  it("설정이 없으면 상한이 없는 것이 아니라 1곳이다 — 가장 보수적으로 군다", () => {
    expect(effectiveMaxTargets(null)).toBe(1);
    expect(effectiveMaxTargets(0)).toBe(1);
    expect(effectiveMaxTargets(5)).toBe(5);
  });
});

describe("요청 폼 검증", () => {
  const ok = {
    eventDate: "2027-05-15",
    guestCount: 150,
    categories: ["hall"],
    note: null,
  };

  it("올바른 요청은 통과한다", () => {
    expect(requestProblem(ok)).toBeNull();
  });

  // 예식일이 없으면 price_rules 의 season·weekday·leadtime 조건을 평가할 수 없다.
  it("예식일이 없으면 막는다 — 가격 계산의 입력이다", () => {
    expect(requestProblem({ ...ok, eventDate: null })).not.toBeNull();
    expect(requestProblem({ ...ok, eventDate: "2027/05/15" })).not.toBeNull();
  });

  it("카테고리를 안 고르면 막는다", () => {
    expect(requestProblem({ ...ok, categories: [] })).not.toBeNull();
  });

  it("메모 길이 상한 당일은 통과하고 넘으면 막는다", () => {
    expect(requestProblem({ ...ok, note: "가".repeat(INQUIRY_NOTE_MAX) })).toBeNull();
    expect(requestProblem({ ...ok, note: "가".repeat(INQUIRY_NOTE_MAX + 1) })).not.toBeNull();
  });

  it("지난 날짜를 가려낸다 — 당일은 지난 것이 아니다", () => {
    expect(isPastDate("2026-08-10", "2026-08-11")).toBe(true);
    expect(isPastDate("2026-08-11", "2026-08-11")).toBe(false);
    expect(isPastDate("2026-08-12", "2026-08-11")).toBe(false);
  });
});

describe("견적 유효기간", () => {
  const now = new Date("2026-08-11T12:00:00Z");

  it("기간이 없으면 만료되지 않는다", () => {
    expect(isExpired({ status: "sent", validUntil: null }, now)).toBe(false);
  });

  it("기한 당일(같은 시각)은 만료다 — 경계는 지난 쪽에 속한다", () => {
    expect(isExpired({ status: "sent", validUntil: "2026-08-11T12:00:00Z" }, now)).toBe(true);
    expect(isExpired({ status: "sent", validUntil: "2026-08-11T12:00:01Z" }, now)).toBe(false);
  });

  it("만료된 견적은 수락할 수 없다", () => {
    expect(canAccept({ status: "sent", validUntil: "2026-08-10T00:00:00Z" }, now)).toBe(false);
    expect(canAccept({ status: "sent", validUntil: "2026-12-31T00:00:00Z" }, now)).toBe(true);
  });

  it("보내지 않은·거둔 견적은 수락 대상이 아니다", () => {
    expect(canAccept({ status: "draft", validUntil: null }, now)).toBe(false);
    expect(canAccept({ status: "withdrawn", validUntil: null }, now)).toBe(false);
  });
});

describe("API 입력 스키마 — 없는 필드가 요점이다", () => {
  it("문의 생성은 커플 id 를 받지 않는다", () => {
    const parsed = CreateInquirySchema.parse({
      action: "create",
      vendorIds: [UUID_A],
      eventDate: "2027-05-15",
      categories: ["hall"],
    });

    expect("coupleId" in parsed).toBe(false);
    expect(parsed.action).toBe("create");
  });

  // 항목 이름·분류·상한은 클라이언트가 보낼 수 없다. 이름은 DB 트리거가 참조된
  // 상품·추가금에서 덮어쓰고, 상한은 서버가 price_rules 를 평가해 계산한다.
  it("견적 줄에 label·categoryCode·capAmount 필드가 없다", () => {
    const parsed = CreateQuoteSchema.parse({
      action: "send",
      inquiryTargetId: UUID_A,
      productId: UUID_B,
      lines: [{ itemType: "base" }],
    });

    expect(Object.keys(parsed.lines[0]).sort()).toEqual(["amount", "itemType", "productOptionId"]);
  });

  it("견적 줄에 임의 항목명을 실어 보내도 스키마가 걸러 낸다", () => {
    const parsed = CreateQuoteSchema.parse({
      action: "send",
      inquiryTargetId: UUID_A,
      productId: UUID_B,
      lines: [{ itemType: "base", label: "특별 관리비", capAmount: 99_999_999 }],
    });

    expect("label" in parsed.lines[0]).toBe(false);
    expect("capAmount" in parsed.lines[0]).toBe(false);
  });

  it("견적 수정 동작은 존재하지 않는다 — 회수만 있다", () => {
    expect(() =>
      VendorQuoteActionSchema.parse({ action: "update", quoteId: UUID_A, totalAmount: 1 }),
    ).toThrow();
    expect(VendorQuoteActionSchema.parse({ action: "withdraw", quoteId: UUID_A }).action).toBe(
      "withdraw",
    );
  });

  it("거절 사유는 정의된 코드만 받는다", () => {
    expect(
      VendorQuoteActionSchema.parse({
        action: "decline",
        inquiryTargetId: UUID_A,
        reasonCode: "no_availability",
      }).action,
    ).toBe("decline");

    expect(() =>
      VendorQuoteActionSchema.parse({
        action: "decline",
        inquiryTargetId: UUID_A,
        reasonCode: "그냥 싫어요",
      }),
    ).toThrow();
  });

  it("소비자 API 에는 견적 발송이 없다", () => {
    expect(() =>
      InquiryActionSchema.parse({ action: "send", inquiryTargetId: UUID_A, productId: UUID_B }),
    ).toThrow();
  });

  it("업체 API 에는 문의 생성이 없다", () => {
    expect(() =>
      VendorQuoteActionSchema.parse({
        action: "create",
        vendorIds: [UUID_A],
        eventDate: "2027-05-15",
        categories: ["hall"],
      }),
    ).toThrow();
  });

  it("유효기간은 PostgREST 오프셋 표기를 받는다 (S4-04 회귀)", () => {
    expect(
      CreateQuoteSchema.parse({
        action: "send",
        inquiryTargetId: UUID_A,
        productId: UUID_B,
        lines: [{ itemType: "base" }],
        validUntil: "2026-09-11T14:32:10.123456+00:00",
      }).validUntil,
    ).toBe("2026-09-11T14:32:10.123456+00:00");
  });
});

describe("문의게시판 스키마 (S4-05)", () => {
  it("작성은 공개가 기본이다 — 공개 질문이 다음 사람을 돕는다", () => {
    // 판별 유니온을 좁힌 뒤에 읽는다(FIX-19 · cart.test.ts 와 같은 이유).
    const parsed = QnaActionSchema.parse({
      action: "create",
      vendorId: UUID_A,
      title: "주차",
      body: "가능한가요",
    });

    expect(parsed.action).toBe("create");
    if (parsed.action !== "create") throw new Error("create 로 좁혀지지 않았다");
    expect(parsed.isPublic).toBe(true);
  });

  it("업체 API 에는 질문 작성·수정이 없다", () => {
    expect(() =>
      VendorQnaActionSchema.parse({ action: "create", vendorId: UUID_A, title: "가", body: "나" }),
    ).toThrow();
    expect(() =>
      VendorQnaActionSchema.parse({ action: "update", postId: UUID_A, body: "업체가 고친 질문" }),
    ).toThrow();
  });

  it("업체는 답변과 공개 설정만 만진다", () => {
    expect(VendorQnaActionSchema.parse({ action: "answer", postId: UUID_A, body: "가능합니다" }).action)
      .toBe("answer");
    expect(
      VendorQnaActionSchema.parse({ action: "set_visibility", postId: UUID_A, isPublic: false })
        .action,
    ).toBe("set_visibility");
  });

  it("소비자 API 에는 답변 작성이 없다", () => {
    expect(() => QnaActionSchema.parse({ action: "answer", postId: UUID_A, body: "내가 답함" }))
      .toThrow();
  });

  it("빈 제목·본문을 거부한다", () => {
    expect(() =>
      QnaActionSchema.parse({ action: "create", vendorId: UUID_A, title: " ", body: "본문" }),
    ).toThrow();
  });
});

describe("응답 속도 정렬 (S4-12 가 기록할 자리를 만들었다)", () => {
  // 스키마는 생겼지만 아직 열지 않는다 — 문의를 받아 본 적 없는 업체가 대부분인
  // 동안 이 정렬을 켜면 "응답이 빠른 순" 이 아니라 "문의를 받아 본 적이 있는지" 가
  // 순서를 정한다. `available_date` 와 같은 종류의 노출 비대칭이다.
  it("아직 열지 않는다", () => {
    expect(EXPLORE_SORTS).not.toContain("response_speed");
  });

  it("이유가 '스키마 없음' 이 아니라 '표본 없음' 으로 바뀌었다", () => {
    const entry = EXPLORE_SORT_PENDING.find((item) => item.code === "response_speed");

    expect(entry).toBeDefined();
    expect(entry?.reason).toContain("응답 기록이 쌓인 업체가 아직 일부");
    expect(entry?.reason).not.toContain("아직 없습니다");
  });

  it("닫아 둔 정렬은 전부 이유와 담당 태스크를 갖는다", () => {
    for (const entry of EXPLORE_SORT_PENDING) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.task.length).toBeGreaterThan(0);
    }
  });
});

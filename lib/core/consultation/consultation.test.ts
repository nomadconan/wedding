import { describe, expect, it } from "vitest";

import {
  CONFIRM_CHOICES,
  CONSULTATION_OUTCOMES,
  CONSULTATION_STATUSES,
  CONSULTATION_TYPES,
  DEPOSIT_NOTICE,
  cancelVerdict,
  confirmDueAt,
  freeCancelDeadline,
  holdsSlot,
  isBookableSlot,
  isFreeCancel,
  isLive,
  requiresDeposit,
  resolveVerdict,
  slotsForDate,
  type AvailabilityRule,
} from "./consultation";
import {
  AvailabilityActionSchema,
  ConfirmConsultationSchema,
  ConsultationActionSchema,
  CreateConsultationSchema,
  VendorConsultationActionSchema,
} from "../schemas/consultation";

const UUID_A = "00000000-0000-0000-0000-0000000000a1";

describe("보증금 대상 유형 (§3.4)", () => {
  it("방문·탐방만 보증금을 받는다", () => {
    expect(requiresDeposit("visit_consult")).toBe(true);
    expect(requiresDeposit("venue_tour")).toBe(true);
  });

  // 전화·화상은 업체가 자리를 비워 두고 기다리는 유형이 아니다.
  it("전화·화상은 보증금 대상이 아니다", () => {
    expect(requiresDeposit("phone")).toBe(false);
    expect(requiresDeposit("video")).toBe(false);
  });

  it("값 집합이 명세와 같다", () => {
    expect([...CONSULTATION_TYPES]).toEqual(["visit_consult", "venue_tour", "phone", "video"]);
  });
});

describe("상태", () => {
  it("값 집합이 DB ENUM 과 같다", () => {
    expect([...CONSULTATION_STATUSES]).toEqual([
      "requested",
      "approved",
      "rejected",
      "confirmed",
      "completed",
      "no_show",
      "cancelled",
      "disputed",
    ]);
  });

  // DB 의 EXCLUDE WHERE 절과 같은 집합이어야 한다. 어긋나면 화면이 "예약 가능" 이라
  // 말한 자리를 DB 가 거절한다.
  it("자리를 차지하는 상태는 승인·확정뿐이다", () => {
    expect(holdsSlot("approved")).toBe(true);
    expect(holdsSlot("confirmed")).toBe(true);
    expect(holdsSlot("requested")).toBe(false);
    expect(holdsSlot("cancelled")).toBe(false);
    expect(holdsSlot("rejected")).toBe(false);
  });

  it("살아 있는 예약은 신청·승인·확정이다", () => {
    expect(isLive("requested")).toBe(true);
    expect(isLive("confirmed")).toBe(true);
    expect(isLive("completed")).toBe(false);
    expect(isLive("disputed")).toBe(false);
  });
});

// =============================================================================
// §3.11 판정표 — 이 서비스의 노쇼 규칙 전부
// =============================================================================
describe("§3.11 이행 확인 판정", () => {
  it("양측 모두 이행 확인 → 전액 환불", () => {
    const verdict = resolveVerdict("fulfilled", "fulfilled");

    expect(verdict.outcome).toBe("fulfilled");
    expect(verdict.deposit).toBe("refund");
    expect(verdict.status).toBe("completed");
  });

  it("양측 모두 고객 노쇼 확인 → 몰취", () => {
    const verdict = resolveVerdict("no_show_couple", "no_show_couple");

    expect(verdict.outcome).toBe("no_show_couple");
    expect(verdict.deposit).toBe("forfeit");
    expect(verdict.status).toBe("no_show");
  });

  // 업체 귀책이면 고객은 불참한 적이 없다. 상태를 no_show 로 두면 고객 기록에
  // 불참이 남는다.
  it("양측 모두 업체 노쇼 확인 → 전액 환불, 고객 기록은 불참이 아니다", () => {
    const verdict = resolveVerdict("no_show_vendor", "no_show_vendor");

    expect(verdict.outcome).toBe("no_show_vendor");
    expect(verdict.deposit).toBe("refund");
    expect(verdict.status).not.toBe("no_show");
    expect(verdict.status).toBe("completed");
  });

  it("응답 불일치 → disputed, 자동 처리하지 않는다", () => {
    const verdict = resolveVerdict("fulfilled", "no_show_couple");

    expect(verdict.status).toBe("disputed");
    expect(verdict.deposit).toBe("dispute");
  });

  // §3.11 NOTE 의 핵심 설계. 기본값이 몰취면 업체는 아무것도 하지 않는 편이
  // 유리해지고 확인 절차가 형해화된다.
  it("양측 모두 무응답 → **환불**이 기본값이다", () => {
    const verdict = resolveVerdict(null, null);

    expect(verdict.deposit).toBe("refund");
    expect(verdict.status).toBe("completed");
    expect(verdict.reason).toContain("both_no_response_default_refund");
  });

  it("양측 무응답의 기본값은 절대 몰취가 아니다", () => {
    expect(resolveVerdict(null, null).deposit).not.toBe("forfeit");
  });

  // 답한 쪽 말만 듣고 처리하면, 업체만 답하고 고객이 못 봤을 때 몰취가 자동으로 된다.
  it("한쪽만 응답 → disputed. 답하지 않은 쪽을 대신 판단하지 않는다", () => {
    expect(resolveVerdict("fulfilled", null).status).toBe("disputed");
    expect(resolveVerdict(null, "no_show_couple").status).toBe("disputed");
    expect(resolveVerdict(null, "no_show_couple").deposit).toBe("dispute");
  });

  it("업체만 고객 노쇼를 주장해도 몰취되지 않는다", () => {
    expect(resolveVerdict(null, "no_show_couple").deposit).not.toBe("forfeit");
  });

  it("판정에는 항상 사유가 붙는다 (D-24 — 재량이 아니라 규칙의 결과다)", () => {
    const cases: [typeof CONSULTATION_OUTCOMES[number] | null, typeof CONSULTATION_OUTCOMES[number] | null][] = [
      ["fulfilled", "fulfilled"],
      ["no_show_couple", "no_show_couple"],
      ["no_show_vendor", "no_show_vendor"],
      ["fulfilled", "no_show_couple"],
      [null, null],
      ["fulfilled", null],
    ];

    for (const [couple, vendor] of cases) {
      expect(resolveVerdict(couple, vendor).reason.length).toBeGreaterThan(0);
    }
  });

  it("당사자가 고를 수 있는 답에 '확인 안 됨' 은 없다 — 그것은 결론이다", () => {
    expect(CONFIRM_CHOICES).not.toContain("undetermined");
    expect(CONFIRM_CHOICES).toHaveLength(3);
  });
});

// =============================================================================
// 취소 (§3.11 — N시간 전까지는 노쇼가 아니다)
// =============================================================================
describe("무료 취소 기한", () => {
  const scheduled = "2026-09-01T05:00:00.000Z";

  it("기한보다 일찍 취소하면 무료다", () => {
    // 25시간 전
    expect(isFreeCancel(scheduled, new Date("2026-08-31T04:00:00Z"), 24)).toBe(true);
  });

  // 경계값은 무료 쪽에 속한다 — "24시간 전까지" 는 24시간 전을 포함한다.
  it("정확히 N시간 전은 무료다 (경계)", () => {
    expect(isFreeCancel(scheduled, new Date("2026-08-31T05:00:00Z"), 24)).toBe(true);
  });

  it("1분이라도 늦으면 무료가 아니다", () => {
    expect(isFreeCancel(scheduled, new Date("2026-08-31T05:01:00Z"), 24)).toBe(false);
  });

  // 기준을 정하지 않은 채 고객에게 불리한 쪽으로 판정할 수 없다(D-24).
  it("기한이 설정되지 않았으면 언제든 무료다", () => {
    expect(isFreeCancel(scheduled, new Date("2026-09-01T04:59:00Z"), null)).toBe(true);
  });

  it("무료 취소는 환불, 늦은 취소는 몰취다", () => {
    expect(cancelVerdict(scheduled, new Date("2026-08-30T00:00:00Z"), 24).deposit).toBe("refund");
    expect(cancelVerdict(scheduled, new Date("2026-09-01T04:00:00Z"), 24).deposit).toBe("forfeit");
  });

  it("늦은 취소는 노쇼와 같이 본다", () => {
    expect(cancelVerdict(scheduled, new Date("2026-09-01T04:00:00Z"), 24).outcome).toBe(
      "no_show_couple",
    );
  });

  it("취소 판정에도 사유가 붙는다", () => {
    expect(cancelVerdict(scheduled, new Date("2026-08-30T00:00:00Z"), 24).reason).toContain(
      "free_cancel_window",
    );
  });

  it("무료 취소 마감 시각을 계산한다", () => {
    expect(freeCancelDeadline(scheduled, 24)).toBe("2026-08-31T05:00:00.000Z");
    expect(freeCancelDeadline(scheduled, null)).toBeNull();
  });

  it("확인 응답 기한은 예정 시각 이후다", () => {
    expect(confirmDueAt(scheduled, 72)).toBe("2026-09-04T05:00:00.000Z");
    expect(confirmDueAt(scheduled, null)).toBeNull();
  });
});

// =============================================================================
// 슬롯
// =============================================================================
describe("가능 시간대에서 슬롯 만들기", () => {
  // 토요일 14:00~17:00, 60분 슬롯. 2026-09-05 는 토요일이다.
  const rules: AvailabilityRule[] = [
    { weekday: 6, startTime: "14:00", endTime: "17:00", slotMinutes: 60 },
  ];
  const KST = 540;

  it("요일이 맞는 날에만 슬롯이 나온다", () => {
    expect(slotsForDate(rules, "2026-09-05", KST, [])).toHaveLength(3);
    // 2026-09-06 은 일요일
    expect(slotsForDate(rules, "2026-09-06", KST, [])).toHaveLength(0);
  });

  // 업체가 등록한 "14:00" 은 한국 시각이다. UTC 로 읽으면 9시간 어긋난다.
  it("오프셋을 적용해 그 지역 시각으로 만든다", () => {
    const slots = slotsForDate(rules, "2026-09-05", KST, []);

    expect(slots[0].startsAt).toBe("2026-09-05T05:00:00.000Z"); // KST 14:00
    expect(slots[2].startsAt).toBe("2026-09-05T07:00:00.000Z"); // KST 16:00
  });

  it("구간에 안 들어가는 마지막 조각은 만들지 않는다", () => {
    const odd: AvailabilityRule[] = [
      { weekday: 6, startTime: "14:00", endTime: "15:30", slotMinutes: 60 },
    ];

    expect(slotsForDate(odd, "2026-09-05", KST, [])).toHaveLength(1);
  });

  it("이미 잡힌 시각은 taken 으로 표시한다", () => {
    const slots = slotsForDate(rules, "2026-09-05", KST, ["2026-09-05T06:00:00.000Z"]);

    expect(slots.filter((slot) => slot.taken)).toHaveLength(1);
    expect(slots.find((slot) => slot.taken)?.startsAt).toBe("2026-09-05T06:00:00.000Z");
  });

  it("잡힌 슬롯과 지난 슬롯은 고를 수 없다", () => {
    const slots = slotsForDate(rules, "2026-09-05", KST, ["2026-09-05T05:00:00.000Z"]);
    const before = new Date("2026-09-01T00:00:00Z");
    const after = new Date("2026-09-30T00:00:00Z");

    expect(isBookableSlot(slots[0], before)).toBe(false); // taken
    expect(isBookableSlot(slots[1], before)).toBe(true);
    expect(isBookableSlot(slots[1], after)).toBe(false); // 지났다
  });

  it("여러 규칙을 시간순으로 합친다", () => {
    const two: AvailabilityRule[] = [
      { weekday: 6, startTime: "16:00", endTime: "17:00", slotMinutes: 60 },
      { weekday: 6, startTime: "10:00", endTime: "11:00", slotMinutes: 60 },
    ];
    const slots = slotsForDate(two, "2026-09-05", KST, []);

    expect(slots).toHaveLength(2);
    expect(slots[0].startsAt < slots[1].startsAt).toBe(true);
  });

  it("잘못된 날짜에는 슬롯을 만들지 않는다", () => {
    expect(slotsForDate(rules, "2026/09/05", KST, [])).toHaveLength(0);
  });
});

// =============================================================================
// 문구 (D-24 — 플랫폼은 판정자가 아니라 조율자다)
// =============================================================================
describe("보증금 문구", () => {
  it("플랫폼의 수수료·벌금이 아니라고 밝힌다", () => {
    expect(DEPOSIT_NOTICE).toContain("수수료가 아니라");
    expect(DEPOSIT_NOTICE).toContain("전액");
  });

  it("플랫폼이 재량으로 처리한다고 말하지 않는다", () => {
    expect(DEPOSIT_NOTICE).not.toMatch(/벌금|위약금|저희가 판단|자체 기준/);
  });
});

// =============================================================================
// API 입력 스키마 — 없는 필드가 요점이다
// =============================================================================
describe("API 입력 스키마", () => {
  it("신청은 커플 id 와 슬롯 길이를 받지 않는다", () => {
    const parsed = CreateConsultationSchema.parse({
      action: "create",
      vendorId: UUID_A,
      type: "visit_consult",
      scheduledAt: "2026-09-05T05:00:00.000Z",
    });

    expect("coupleId" in parsed).toBe(false);
    expect("durationMinutes" in parsed).toBe(false);
  });

  it("신청에 보증금 금액·상태를 실어 보낼 수 없다", () => {
    const parsed = CreateConsultationSchema.parse({
      action: "create",
      vendorId: UUID_A,
      type: "visit_consult",
      scheduledAt: "2026-09-05T05:00:00.000Z",
      depositAmount: 0,
      depositStatus: "held",
    });

    expect("depositAmount" in parsed).toBe(false);
    expect("depositStatus" in parsed).toBe(false);
  });

  it("PostgREST 오프셋 표기를 받는다 (S4-04 회귀)", () => {
    expect(
      CreateConsultationSchema.parse({
        action: "create",
        vendorId: UUID_A,
        type: "phone",
        scheduledAt: "2026-09-05T14:32:10.123456+09:00",
      }).scheduledAt,
    ).toBe("2026-09-05T14:32:10.123456+09:00");
  });

  // 어느 편인지는 세션이 정한다. 받으면 고객이 업체 칸에 답하는 요청을 만들 수 있다.
  it("이행 확인은 '어느 편인가' 를 받지 않는다", () => {
    const parsed = ConfirmConsultationSchema.parse({ outcome: "fulfilled", side: "vendor" });

    expect("side" in parsed).toBe(false);
  });

  it("이행 확인은 '확인 안 됨' 을 답으로 받지 않는다", () => {
    expect(() => ConfirmConsultationSchema.parse({ outcome: "undetermined" })).toThrow();
  });

  it("결제는 멱등 열쇠를 요구한다", () => {
    expect(() =>
      ConsultationActionSchema.parse({ action: "pay_deposit", consultationId: UUID_A }),
    ).toThrow();
  });

  it("소비자 API 에는 승인이 없다", () => {
    expect(() =>
      ConsultationActionSchema.parse({ action: "approve", consultationId: UUID_A }),
    ).toThrow();
  });

  it("업체 API 에는 신청이 없다", () => {
    expect(() =>
      VendorConsultationActionSchema.parse({
        action: "create",
        vendorId: UUID_A,
        type: "phone",
        scheduledAt: "2026-09-05T05:00:00.000Z",
      }),
    ).toThrow();
  });

  it("거절은 사유를 요구한다", () => {
    expect(() =>
      VendorConsultationActionSchema.parse({ action: "reject", consultationId: UUID_A }),
    ).toThrow();
    expect(
      VendorConsultationActionSchema.parse({
        action: "reject",
        consultationId: UUID_A,
        reason: "그날은 예약이 찼어요",
      }).action,
    ).toBe("reject");
  });

  // 노쇼 신고를 별도 동작으로 두면 업체의 일방 주장이 대조를 건너뛴다.
  it("노쇼 신고는 별도 동작이 아니라 이행 확인의 한쪽 답이다", () => {
    expect(
      VendorConsultationActionSchema.parse({
        action: "confirm",
        consultationId: UUID_A,
        outcome: "no_show_couple",
      }).action,
    ).toBe("confirm");

    expect(() =>
      VendorConsultationActionSchema.parse({ action: "report_no_show", consultationId: UUID_A }),
    ).toThrow();
  });

  it("가능 시간대는 요일 0~6 과 HH:MM 만 받는다", () => {
    expect(
      AvailabilityActionSchema.parse({
        action: "create",
        weekday: 6,
        startTime: "14:00",
        endTime: "17:00",
        slotMinutes: 60,
      }).action,
    ).toBe("create");

    expect(() =>
      AvailabilityActionSchema.parse({
        action: "create",
        weekday: 7,
        startTime: "14:00",
        endTime: "17:00",
        slotMinutes: 60,
      }),
    ).toThrow();

    expect(() =>
      AvailabilityActionSchema.parse({
        action: "create",
        weekday: 6,
        startTime: "2시",
        endTime: "17:00",
        slotMinutes: 60,
      }),
    ).toThrow();
  });
});

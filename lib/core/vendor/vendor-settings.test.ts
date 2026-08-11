import { describe, expect, it } from "vitest";

import {
  BUSINESS_HOURS_SLA_NOTE,
  RECIPIENT_MODES,
  TEMPLATE_KINDS,
  VENDOR_TOPICS,
  businessHoursProblem,
  formatBusinessHours,
  isVendorChannelAllowed,
  isWithinBusinessHours,
  nextBusinessStart,
  resolveRecipients,
  type BusinessHour,
} from "./vendor-settings";
import {
  ALREADY_MEMBER_ELSEWHERE_MESSAGE,
  canResend,
  emailMatches,
  inviteExpiresAt,
  inviteStatus,
  normalizeEmail,
  vendorInviteBlocker,
} from "./vendor-invite";
import {
  AcceptInviteSchema,
  VendorInviteActionSchema,
  VendorSettingsActionSchema,
  validateTemplatePayload,
} from "../schemas/vendor-settings";

const OWNER = "00000000-0000-0000-0000-0000000000a1";
const STAFF = "00000000-0000-0000-0000-0000000000a2";
const OUTSIDER = "00000000-0000-0000-0000-0000000000a3";
const PRODUCT = "00000000-0000-0000-0000-0000000000b1";

describe("수신 대상 (담당자 배정)", () => {
  const members = [OWNER, STAFF];

  it("all 은 멤버 전원이다", () => {
    expect(resolveRecipients({ mode: "all", memberIds: members, assignedTo: STAFF, defaultAssignee: OWNER }))
      .toEqual(members);
  });

  it("assignee_first 는 배정된 사람만 받는다", () => {
    expect(
      resolveRecipients({
        mode: "assignee_first",
        memberIds: members,
        assignedTo: STAFF,
        defaultAssignee: null,
      }),
    ).toEqual([STAFF]);
  });

  it("assignee_first 인데 배정이 없으면 기본 담당자로 떨어진다", () => {
    expect(
      resolveRecipients({
        mode: "assignee_first",
        memberIds: members,
        assignedTo: null,
        defaultAssignee: OWNER,
      }),
    ).toEqual([OWNER]);
  });

  it("assignee_first 인데 둘 다 없으면 전원이다", () => {
    expect(
      resolveRecipients({
        mode: "assignee_first",
        memberIds: members,
        assignedTo: null,
        defaultAssignee: null,
      }),
    ).toEqual(members);
  });

  it("specific 은 기본 담당자만 받는다", () => {
    expect(
      resolveRecipients({
        mode: "specific",
        memberIds: members,
        assignedTo: null,
        defaultAssignee: OWNER,
      }),
    ).toEqual([OWNER]);
  });

  // 아무도 못 받는 상태를 만들지 않는다 — 설정 실수의 대가치고 너무 크다.
  it("specific 인데 담당자가 없으면 전원으로 떨어진다", () => {
    expect(
      resolveRecipients({
        mode: "specific",
        memberIds: members,
        assignedTo: null,
        defaultAssignee: null,
      }),
    ).toEqual(members);
  });

  it("업체를 떠난 사람이 담당자로 남아 있으면 전원으로 떨어진다", () => {
    expect(
      resolveRecipients({
        mode: "specific",
        memberIds: members,
        assignedTo: null,
        defaultAssignee: OUTSIDER,
      }),
    ).toEqual(members);
  });

  it("라운드로빈 모드는 존재하지 않는다", () => {
    expect([...RECIPIENT_MODES]).toEqual(["all", "assignee_first", "specific"]);
    expect(RECIPIENT_MODES).not.toContain("round_robin");
  });
});

describe("채널 — 조직 층 + 개인 층", () => {
  it("둘 다 켜져 있어야 보낸다", () => {
    expect(
      isVendorChannelAllowed({
        channel: "email",
        vendorFlags: { email: true },
        personalFlags: { email: true },
      }),
    ).toBe(true);
  });

  it("조직이 끄면 개인이 켜도 안 간다", () => {
    expect(
      isVendorChannelAllowed({
        channel: "email",
        vendorFlags: { email: false },
        personalFlags: { email: true },
      }),
    ).toBe(false);
  });

  it("개인이 끄면 조직이 켜도 안 간다", () => {
    expect(
      isVendorChannelAllowed({
        channel: "email",
        vendorFlags: { email: true },
        personalFlags: { email: false },
      }),
    ).toBe(false);
  });

  // 설정 행이 없다는 것은 "아직 고르지 않았다" 이지 "거부했다" 가 아니다(0020 원칙).
  it("설정이 없으면 켜진 것으로 본다", () => {
    expect(
      isVendorChannelAllowed({ channel: "email", vendorFlags: null, personalFlags: null }),
    ).toBe(true);
  });

  // 앱 알림함을 끄면 증적을 남길 자리가 사라진다.
  it("in_app 은 어느 층에서도 끌 수 없다", () => {
    expect(
      isVendorChannelAllowed({
        channel: "in_app",
        vendorFlags: { in_app: false },
        personalFlags: { in_app: false },
      }),
    ).toBe(true);
  });

  it("업체 설정 화면에는 소비자 전용 토픽을 띄우지 않는다", () => {
    expect(VENDOR_TOPICS).not.toContain("dday");
    expect(VENDOR_TOPICS).not.toContain("care");
    expect(VENDOR_TOPICS).toContain("inquiry");
  });
});

describe("영업시간", () => {
  // 월 10~19시, 토 10~14시
  const hours: BusinessHour[] = [
    { weekday: 1, start: "10:00", end: "19:00" },
    { weekday: 6, start: "10:00", end: "14:00" },
  ];
  const KST = 540;

  // 2026-08-17 은 월요일.
  it("영업시간 안이면 참이다", () => {
    // KST 11:00 = UTC 02:00
    expect(isWithinBusinessHours(hours, new Date("2026-08-17T02:00:00Z"), KST)).toBe(true);
  });

  it("영업시간 밖이면 거짓이다", () => {
    // KST 20:00
    expect(isWithinBusinessHours(hours, new Date("2026-08-17T11:00:00Z"), KST)).toBe(false);
  });

  it("시작 시각은 포함, 종료 시각은 제외다 (반개구간)", () => {
    expect(isWithinBusinessHours(hours, new Date("2026-08-17T01:00:00Z"), KST)).toBe(true); // 10:00
    expect(isWithinBusinessHours(hours, new Date("2026-08-17T10:00:00Z"), KST)).toBe(false); // 19:00
  });

  it("등록하지 않았으면 언제나 영업 중으로 본다", () => {
    expect(isWithinBusinessHours([], new Date("2026-08-17T18:00:00Z"), KST)).toBe(true);
  });

  it("다음 영업 시작을 찾는다", () => {
    // 월 20:00(KST) → 다음은 토 10:00(KST) = 2026-08-22T01:00:00Z
    const next = nextBusinessStart(hours, new Date("2026-08-17T11:00:00Z"), KST);

    expect(next?.toISOString()).toBe("2026-08-22T01:00:00.000Z");
  });

  it("영업시간이 없으면 미룰 곳도 없다", () => {
    expect(nextBusinessStart([], new Date("2026-08-17T11:00:00Z"), KST)).toBeNull();
  });

  it("잘못된 시간대를 걸러 낸다", () => {
    expect(businessHoursProblem([{ weekday: 7, start: "10:00", end: "11:00" }])).not.toBeNull();
    expect(businessHoursProblem([{ weekday: 1, start: "11:00", end: "10:00" }])).not.toBeNull();
    expect(businessHoursProblem([{ weekday: 1, start: "1시", end: "11:00" }])).not.toBeNull();
    expect(businessHoursProblem(hours)).toBeNull();
  });

  it("요일 순으로 읽기 좋게 적는다", () => {
    expect(formatBusinessHours(hours)).toEqual(["월 10:00~19:00", "토 10:00~14:00"]);
  });

  // 이 판단이 이 태스크의 핵심이다 — 반영하면 업체가 자기 SLA 기준을 정하게 된다.
  it("영업시간이 SLA 판정에 쓰이지 않음을 문구가 밝힌다", () => {
    expect(BUSINESS_HOURS_SLA_NOTE).toContain("응답 기한 계산에는 쓰이지 않");
  });
});

describe("템플릿 (S4-04 · S4-12 이월)", () => {
  it("두 종류를 한 표에 둔다", () => {
    expect([...TEMPLATE_KINDS]).toEqual(["quick_reply", "quote"]);
  });

  it("빠른 답변은 문장을 요구한다", () => {
    expect(validateTemplatePayload("quick_reply", { body: "안녕하세요" }).ok).toBe(true);
    expect(validateTemplatePayload("quick_reply", { body: "" }).ok).toBe(false);
  });

  it("견적 템플릿은 상품과 항목을 요구한다", () => {
    expect(
      validateTemplatePayload("quote", {
        productId: PRODUCT,
        lines: [{ itemType: "base" }],
      }).ok,
    ).toBe(true);

    expect(validateTemplatePayload("quote", { productId: PRODUCT, lines: [] }).ok).toBe(false);
  });

  // 상한은 보낼 때 price_rules 로 다시 계산한다. 박아 두면 룰이 바뀐 뒤에도 옛 값이 따라다닌다.
  it("견적 템플릿에 상한을 담지 않는다", () => {
    const result = validateTemplatePayload("quote", {
      productId: PRODUCT,
      lines: [{ itemType: "base", capAmount: 99_999_999 }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(result.value)).not.toContain("capAmount");
    }
  });

  it("종류가 다르면 다른 검증을 쓴다", () => {
    expect(validateTemplatePayload("quote", { body: "문장" }).ok).toBe(false);
    expect(validateTemplatePayload("quick_reply", { productId: PRODUCT, lines: [] }).ok).toBe(false);
  });
});

describe("초대 (S2-09)", () => {
  const base = { expiresAt: "2026-09-01T00:00:00.000Z", acceptedAt: null, revokedAt: null };

  it("유효 기간 안이면 통과한다", () => {
    expect(vendorInviteBlocker(base, "2026-08-30T00:00:00.000Z")).toBeNull();
  });

  it("만료되면 막는다", () => {
    expect(vendorInviteBlocker(base, "2026-09-02T00:00:00.000Z")?.code).toBe("EXPIRED");
  });

  it("만료 당시각은 이미 만료다 (경계)", () => {
    expect(vendorInviteBlocker(base, "2026-09-01T00:00:00.000Z")?.code).toBe("EXPIRED");
  });

  it("이미 수락된 것은 다시 못 쓴다", () => {
    expect(
      vendorInviteBlocker({ ...base, acceptedAt: "2026-08-30T00:00:00Z" }, "2026-08-31T00:00:00Z")
        ?.code,
    ).toBe("ALREADY_USED");
  });

  // 만료도 되고 거둬지기도 한 초대에 "만료됐어요" 라고 하면 재발송을 기대하게 된다.
  it("거둔 초대는 만료보다 먼저 판정한다", () => {
    expect(
      vendorInviteBlocker({ ...base, revokedAt: "2026-08-20T00:00:00Z" }, "2026-09-02T00:00:00Z")
        ?.code,
    ).toBe("REVOKED");
  });

  it("상태를 사람이 읽는 말로 옮긴다", () => {
    expect(inviteStatus(base, "2026-08-30T00:00:00Z")).toBe("pending");
    expect(inviteStatus(base, "2026-09-02T00:00:00Z")).toBe("expired");
    expect(inviteStatus({ ...base, revokedAt: "2026-08-20T00:00:00Z" }, "2026-08-30T00:00:00Z"))
      .toBe("revoked");
  });

  it("수락된 초대는 재발송하지 않는다", () => {
    expect(canResend(base, "2026-08-30T00:00:00Z")).toBe(true);
    expect(canResend(base, "2026-09-02T00:00:00Z")).toBe(true); // 만료는 다시 보낼 수 있다
    expect(canResend({ ...base, acceptedAt: "2026-08-30T00:00:00Z" }, "2026-08-31T00:00:00Z"))
      .toBe(false);
  });

  it("만료 시각은 파라미터로 계산한다", () => {
    expect(inviteExpiresAt("2026-08-30T00:00:00.000Z", 72)).toBe("2026-09-02T00:00:00.000Z");
  });

  it("설정이 없으면 폴백 기한을 쓴다 — 초대를 아예 못 보내게 하지 않는다", () => {
    expect(inviteExpiresAt("2026-08-30T00:00:00.000Z", null)).toBe("2026-09-02T00:00:00.000Z");
  });

  it("이메일은 소문자로 비교한다", () => {
    expect(normalizeEmail("  A@B.com ")).toBe("a@b.com");
    expect(emailMatches("A@B.com", "a@b.com")).toBe(true);
  });

  // 토큰이 유출되면 아무나 업체 멤버가 되는데, 그건 가격·정산 접근이다.
  it("다른 이메일로는 수락할 수 없다", () => {
    expect(emailMatches("a@b.com", "c@d.com")).toBe(false);
    expect(emailMatches("a@b.com", null)).toBe(false);
  });

  it("다중 소속을 거절하는 이유가 문구에 있다", () => {
    expect(ALREADY_MEMBER_ELSEWHERE_MESSAGE).toContain("한 업체에만");
  });
});

describe("API 입력 스키마 — 없는 필드가 요점이다", () => {
  it("설정 변경은 vendor_id 를 받지 않는다", () => {
    const parsed = VendorSettingsActionSchema.parse({
      action: "update_settings",
      recipientMode: "assignee_first",
      vendorId: "00000000-0000-0000-0000-0000000000ff",
    });

    expect("vendorId" in parsed).toBe(false);
  });

  it("초대는 토큰을 클라이언트가 만들지 않는다", () => {
    const parsed = VendorInviteActionSchema.parse({
      action: "invite",
      email: "New@Example.com",
      role: "staff",
      token: "내가 만든 토큰",
    });

    expect("token" in parsed).toBe(false);
    expect(parsed.action === "invite" && parsed.email).toBe("new@example.com");
  });

  // 받으면 초대받은 사람이 owner 로 수락하는 요청을 만들 수 있다.
  it("수락은 토큰만 받는다 — 업체·권한을 받지 않는다", () => {
    const parsed = AcceptInviteSchema.parse({
      token: "a".repeat(40),
      role: "owner",
      vendorId: "00000000-0000-0000-0000-0000000000ff",
    });

    expect(Object.keys(parsed)).toEqual(["token"]);
  });

  it("짧은 토큰은 거부한다", () => {
    expect(() => AcceptInviteSchema.parse({ token: "short" })).toThrow();
  });

  it("업체 설정 API 에 수락이 없다", () => {
    expect(() => VendorSettingsActionSchema.parse({ action: "accept", token: "a".repeat(40) }))
      .toThrow();
  });

  it("초대 API 에 설정 변경이 없다", () => {
    expect(() =>
      VendorInviteActionSchema.parse({ action: "update_settings", recipientMode: "all" }),
    ).toThrow();
  });

  it("이메일 형식을 검증한다", () => {
    expect(() =>
      VendorInviteActionSchema.parse({ action: "invite", email: "not-an-email", role: "staff" }),
    ).toThrow();
  });
});

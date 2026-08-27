import { describe, expect, it } from "vitest";

import {
  ABUSE_SIGNALS,
  type AbuseSample,
  REVIEW_ABUSE_OPEN_ISSUE,
  burstUsable,
  detectBurst,
  detectDirectSignals,
} from "./abuse";
import {
  RATING_AXES,
  RATING_BASIS,
  type RatingSample,
  rateVendor,
  ratingCaption,
} from "./rating";
import {
  REVIEW_REPORT_REASONS,
  REVIEW_REPORT_STATUSES,
  ReviewReportResolveSchema,
  ReviewReportSchema,
  hidesReview,
  isVerifiableReason,
} from "./report";
import {
  REVIEWABLE_BOOKING_STATUSES,
  ReviewCreateSchema,
  ReviewModerationSchema,
  ReviewUpdateSchema,
  VendorReplySchema,
  bookingReviewable,
  isVisible,
} from "./write";

const UUID = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";

const sample = (over: Partial<RatingSample> = {}): RatingSample => ({
  scorePrice: 4,
  scoreResponse: 4,
  scoreFulfillment: 4,
  ...over,
});

// ══════════════════════════════════════════════════════════════════════════
// 평점 — **평균은 건수와 함께가 아니면 나가지 않는다**
// ══════════════════════════════════════════════════════════════════════════

describe("rateVendor", () => {
  it("표본이 없으면 평균이 null 이다 — 0 을 만들지 않는다", () => {
    const rating = rateVendor([]);

    expect(rating.overall).toBeNull();
    expect(rating.reviewCount).toBe(0);
    // 축도 마찬가지다. 0.0 은 화면에서 '최악' 으로 읽힌다.
    expect(rating.axes.every((axis) => axis.average === null && axis.sampleSize === 0)).toBe(true);
  });

  it("한 건이어도 평균을 내되 건수가 함께 나온다", () => {
    const rating = rateVendor([sample({ scorePrice: 5, scoreResponse: 5, scoreFulfillment: 5 })]);

    expect(rating.overall).toBe(5);
    expect(rating.reviewCount).toBe(1);
    expect(ratingCaption(rating)).toContain("1건");
  });

  it("점수를 남기지 않은 축은 그 축의 분모에서만 빠진다", () => {
    const rating = rateVendor([
      sample({ scorePrice: 5, scoreResponse: null, scoreFulfillment: null }),
      sample({ scorePrice: 3, scoreResponse: 1, scoreFulfillment: null }),
    ]);

    const byAxis = Object.fromEntries(rating.axes.map((axis) => [axis.axis, axis]));

    expect(byAxis.price.sampleSize).toBe(2);
    expect(byAxis.price.average).toBe(4);
    expect(byAxis.response.sampleSize).toBe(1);
    expect(byAxis.response.average).toBe(1);
    expect(byAxis.fulfillment.sampleSize).toBe(0);
    expect(byAxis.fulfillment.average).toBeNull();
  });

  it("종합은 후기 단위로 먼저 접는다 — 한 사람이 한 표다", () => {
    // 응대에만 1점을 준 사람 하나 + 세 축 모두 5점인 사람 하나.
    //
    // 축별 평균을 다시 평균 내면 (5 + (5+1)/2 + 5)/3 = 4.33 이 되어
    // **한 축에만 답한 사람이 종합의 1/3 을 가져간다.**
    // 후기 단위로 접으면 (1 + 5)/2 = 3 이다.
    const rating = rateVendor([
      sample({ scorePrice: null, scoreResponse: 1, scoreFulfillment: null }),
      sample({ scorePrice: 5, scoreResponse: 5, scoreFulfillment: 5 }),
    ]);

    expect(rating.overall).toBe(3);
    expect(rating.reviewCount).toBe(2);
  });

  it("점수를 하나도 남기지 않은 후기는 종합의 분모에서 빠진다", () => {
    const rating = rateVendor([
      sample({ scorePrice: null, scoreResponse: null, scoreFulfillment: null }),
      sample({ scorePrice: 4, scoreResponse: 4, scoreFulfillment: 4 }),
    ]);

    expect(rating.reviewCount).toBe(1);
    expect(rating.overall).toBe(4);
  });

  it("범위 밖·정수 아닌 점수는 세지 않는다 (DB CHECK 이 막지만 두 번 막는다)", () => {
    const rating = rateVendor([
      sample({ scorePrice: 0, scoreResponse: 6, scoreFulfillment: 3.5 }),
      sample({ scorePrice: 4, scoreResponse: null, scoreFulfillment: null }),
    ]);

    expect(rating.reviewCount).toBe(1);
    expect(rating.overall).toBe(4);
  });

  it("소수 첫째 자리까지만 낸다", () => {
    const rating = rateVendor([
      sample({ scorePrice: 4, scoreResponse: 4, scoreFulfillment: 5 }),
      sample({ scorePrice: 4, scoreResponse: 4, scoreFulfillment: 4 }),
    ]);

    // (13/3 + 4)/2 = 4.1666... → 4.2
    expect(rating.overall).toBe(4.2);
  });

  it("산정 기준을 값과 함께 돌려준다 (F-V-11)", () => {
    const rating = rateVendor([sample()]);

    expect(rating.basis.code).toBe("verified_equal_weight_v1");
    expect(RATING_BASIS.rules.length).toBeGreaterThan(0);
    expect(rating.axes.map((axis) => axis.axis)).toEqual([...RATING_AXES]);
  });

  it("후기가 없으면 캡션이 '평점 없음' 이 아니라 '후기 없음' 이라고 말한다", () => {
    expect(ratingCaption(rateVendor([]))).toBe("아직 검증 후기가 없습니다.");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 입력 규약
// ══════════════════════════════════════════════════════════════════════════

describe("ReviewCreateSchema", () => {
  const base = {
    bookingId: UUID,
    scorePrice: 4,
    scoreResponse: 4,
    scoreFulfillment: 4,
    body: "담백하게 잘 진행됐습니다.",
    disclosedAmount: 12_000_000,
  };

  it("점수도 본문도 없는 후기는 막는다", () => {
    const parsed = ReviewCreateSchema.safeParse({
      ...base,
      scorePrice: null,
      scoreResponse: null,
      scoreFulfillment: null,
      body: "",
    });

    expect(parsed.success).toBe(false);
  });

  it("본문만 있어도 통과한다 — 점수는 선택이다", () => {
    const parsed = ReviewCreateSchema.safeParse({
      ...base,
      scorePrice: null,
      scoreResponse: null,
      scoreFulfillment: null,
      disclosedAmount: null,
    });

    expect(parsed.success).toBe(true);
  });

  it("점수 하나만 있어도 통과한다", () => {
    const parsed = ReviewCreateSchema.safeParse({
      ...base,
      scoreResponse: null,
      scoreFulfillment: null,
      body: null,
    });

    expect(parsed.success).toBe(true);
  });

  it.each([
    ["하한 아래", 0],
    ["상한 위", 6],
    ["정수 아님", 3.5],
  ])("점수 %s 는 거절한다 (%s)", (_label, value) => {
    expect(ReviewCreateSchema.safeParse({ ...base, scorePrice: value }).success).toBe(false);
  });

  it.each([1, 5])("경계값 %i 점은 받는다", (value) => {
    expect(ReviewCreateSchema.safeParse({ ...base, scorePrice: value }).success).toBe(true);
  });

  it("공개 금액 0원을 만들지 않는다 — 적지 않았으면 null 이다", () => {
    expect(ReviewCreateSchema.safeParse({ ...base, disclosedAmount: 0 }).success).toBe(false);
    expect(ReviewCreateSchema.safeParse({ ...base, disclosedAmount: null }).success).toBe(true);
  });

  it("수정 스키마는 대상 예약을 받지 않는다 — 바꿀 수 없는 값이다", () => {
    const parsed = ReviewUpdateSchema.safeParse(base);

    expect(parsed.success).toBe(true);
    expect(parsed.success && "bookingId" in parsed.data).toBe(false);
  });
});

describe("bookingReviewable", () => {
  it.each([...REVIEWABLE_BOOKING_STATUSES])("%s 는 후기를 쓸 수 있다", (status) => {
    expect(bookingReviewable(status)).toBe(true);
  });

  it.each(["hold", "cancelled", "pending"])("%s 는 쓸 수 없다", (status) => {
    expect(bookingReviewable(status)).toBe(false);
  });
});

describe("isVisible", () => {
  it("공개이고 거두지 않은 후기만 보인다", () => {
    expect(isVisible({ status: "published", retracted_at: null })).toBe(true);
  });

  it("거둔 후기는 공개 상태여도 보이지 않는다", () => {
    expect(isVisible({ status: "published", retracted_at: "2026-08-27T00:00:00Z" })).toBe(false);
  });

  it("운영자가 내린 후기는 보이지 않는다", () => {
    expect(isVisible({ status: "hidden", retracted_at: null })).toBe(false);
  });
});

describe("업체 답변·운영자 조치", () => {
  it("빈 답변을 저장하지 않는다", () => {
    expect(VendorReplySchema.safeParse({ reviewId: UUID, reply: "   " }).success).toBe(false);
  });

  it("복구에도 사유를 요구한다", () => {
    expect(
      ReviewModerationSchema.safeParse({ reviewId: UUID, action: "restore", reason: "" }).success,
    ).toBe(false);
    expect(
      ReviewModerationSchema.safeParse({
        reviewId: UUID,
        action: "restore",
        reason: "신고가 사실이 아님을 확인했습니다.",
      }).success,
    ).toBe(true);
  });

  it("정의되지 않은 조치를 받지 않는다", () => {
    expect(
      ReviewModerationSchema.safeParse({ reviewId: UUID, action: "delete", reason: "x" }).success,
    ).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 신고 — **판정이 아니라 조율이다**(D-24)
// ══════════════════════════════════════════════════════════════════════════

describe("신고", () => {
  it("접수는 상태를 받지 않는다 — 신고자가 자기 신고를 닫을 수 없다", () => {
    const parsed = ReviewReportSchema.safeParse({
      reviewId: UUID,
      reason: "not_a_customer",
      status: "upheld",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && "status" in parsed.data).toBe(false);
  });

  it("정의되지 않은 사유는 거절한다", () => {
    expect(ReviewReportSchema.safeParse({ reviewId: UUID, reason: "spam" }).success).toBe(false);
  });

  it("우리가 확인할 수 있는 사유는 거래 이력 하나뿐이다", () => {
    expect(isVerifiableReason("not_a_customer")).toBe(true);

    for (const reason of REVIEW_REPORT_REASONS.filter((code) => code !== "not_a_customer")) {
      expect(isVerifiableReason(reason)).toBe(false);
    }
  });

  it("'내리지 않음' 도 사유를 요구한다", () => {
    expect(
      ReviewReportResolveSchema.safeParse({ reportId: UUID, status: "rejected", note: "  " })
        .success,
    ).toBe(false);
  });

  it("접수 상태로는 처리를 끝낼 수 없다", () => {
    expect(
      ReviewReportResolveSchema.safeParse({ reportId: UUID, status: "open", note: "보류" }).success,
    ).toBe(false);
  });

  it("인정은 후기를 내리는 일과 같은 사건이다", () => {
    expect(hidesReview("upheld")).toBe(true);
    expect(hidesReview("rejected")).toBe(false);
    expect(REVIEW_REPORT_STATUSES).toContain("open");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 어뷰징 큐 — **기준이 없는 신호는 세지 않는다**(D-123 과 같은 규칙)
// ══════════════════════════════════════════════════════════════════════════

const abuse = (over: Partial<AbuseSample> = {}): AbuseSample => ({
  reviewId: UUID,
  vendorId: UUID2,
  coupleId: "c1",
  createdAt: "2026-08-27T12:00:00.000Z",
  hasBody: true,
  scores: [4, 4, 4],
  openReportCount: 0,
  ...over,
});

describe("detectDirectSignals", () => {
  it("열린 신고가 하나라도 있으면 큐에 올린다", () => {
    const flags = detectDirectSignals([abuse({ openReportCount: 1 })]);

    expect(flags).toHaveLength(1);
    expect(flags[0].signal).toBe("reported");
    expect(flags[0].basis).toContain("1건");
  });

  it("본문 없이 모든 점수가 최저면 큐에 올린다", () => {
    const flags = detectDirectSignals([abuse({ hasBody: false, scores: [1, 1, 1] })]);

    expect(flags.map((flag) => flag.signal)).toEqual(["no_body_extreme"]);
  });

  it("본문 없이 모든 점수가 최고여도 큐에 올린다 — 방향을 가리지 않는다", () => {
    const flags = detectDirectSignals([abuse({ hasBody: false, scores: [5, 5] })]);

    expect(flags.map((flag) => flag.signal)).toEqual(["no_body_extreme"]);
  });

  it("본문이 있으면 극단 점수여도 올리지 않는다", () => {
    expect(detectDirectSignals([abuse({ hasBody: true, scores: [1, 1, 1] })])).toHaveLength(0);
  });

  it("끝값이 섞여 있으면 극단이 아니다", () => {
    expect(detectDirectSignals([abuse({ hasBody: false, scores: [1, 5, 1] })])).toHaveLength(0);
  });

  it("중간 점수는 극단이 아니다", () => {
    expect(detectDirectSignals([abuse({ hasBody: false, scores: [4, 4, 4] })])).toHaveLength(0);
  });

  it("점수를 하나도 남기지 않았으면 해당 없음이다", () => {
    expect(
      detectDirectSignals([abuse({ hasBody: false, scores: [null, null, null] })]),
    ).toHaveLength(0);
  });

  it("신호 둘이 겹치면 둘 다 올린다", () => {
    const flags = detectDirectSignals([
      abuse({ hasBody: false, scores: [1, 1, 1], openReportCount: 2 }),
    ]);

    expect(flags.map((flag) => flag.signal).sort()).toEqual(["no_body_extreme", "reported"]);
  });
});

describe("detectBurst", () => {
  const at = (hoursFromNoon: number) =>
    new Date(Date.UTC(2026, 7, 27, 12 + hoursFromNoon)).toISOString();

  it("임계값이 미결이면 세지 않고 그 사실을 말한다", () => {
    const scan = detectBurst([abuse()], { windowHours: null, minCount: null });

    expect(scan.status).toBe("blocked");
    expect(scan.status === "blocked" && scan.openIssue).toBe(REVIEW_ABUSE_OPEN_ISSUE);
  });

  it.each([
    ["창이 0시간", { windowHours: 0, minCount: 3 }],
    ["건수가 1건", { windowHours: 24, minCount: 1 }],
    ["창만 정해짐", { windowHours: 24, minCount: null }],
    ["건수만 정해짐", { windowHours: null, minCount: 3 }],
  ])("%s 이면 쓸 수 있는 기준이 아니다", (_label, threshold) => {
    expect(burstUsable(threshold)).toBe(false);
    expect(detectBurst([abuse()], threshold).status).toBe("blocked");
  });

  it("창 안에 기준 건수만큼 있으면 그 창의 후기를 전부 올린다", () => {
    const scan = detectBurst(
      [
        abuse({ reviewId: "r1", createdAt: at(0) }),
        abuse({ reviewId: "r2", createdAt: at(1) }),
        abuse({ reviewId: "r3", createdAt: at(2) }),
      ],
      { windowHours: 24, minCount: 3 },
    );

    expect(scan.status).toBe("scanned");
    expect(scan.status === "scanned" && scan.flags.map((flag) => flag.reviewId).sort()).toEqual([
      "r1",
      "r2",
      "r3",
    ]);
  });

  it("창 경계 위(정확히 창 길이)는 창 안이다", () => {
    const scan = detectBurst(
      [
        abuse({ reviewId: "r1", createdAt: at(0) }),
        abuse({ reviewId: "r2", createdAt: at(24) }),
      ],
      { windowHours: 24, minCount: 2 },
    );

    expect(scan.status === "scanned" && scan.flags).toHaveLength(2);
  });

  it("창을 1시간이라도 벗어나면 세지 않는다", () => {
    const scan = detectBurst(
      [
        abuse({ reviewId: "r1", createdAt: at(0) }),
        abuse({ reviewId: "r2", createdAt: at(25) }),
      ],
      { windowHours: 24, minCount: 2 },
    );

    expect(scan.status === "scanned" && scan.flags).toHaveLength(0);
  });

  it("커플이 다르면 합쳐 세지 않는다", () => {
    const scan = detectBurst(
      [
        abuse({ reviewId: "r1", coupleId: "c1", createdAt: at(0) }),
        abuse({ reviewId: "r2", coupleId: "c2", createdAt: at(1) }),
      ],
      { windowHours: 24, minCount: 2 },
    );

    expect(scan.status === "scanned" && scan.flags).toHaveLength(0);
  });

  it("같은 후기를 두 번 올리지 않는다", () => {
    const scan = detectBurst(
      [
        abuse({ reviewId: "r1", createdAt: at(0) }),
        abuse({ reviewId: "r2", createdAt: at(1) }),
        abuse({ reviewId: "r3", createdAt: at(2) }),
        abuse({ reviewId: "r4", createdAt: at(3) }),
      ],
      { windowHours: 24, minCount: 2 },
    );

    expect(scan.status === "scanned" && scan.flags).toHaveLength(4);
  });

  it("신호 어휘가 셋이다", () => {
    expect([...ABUSE_SIGNALS]).toEqual(["reported", "no_body_extreme", "burst"]);
  });
});

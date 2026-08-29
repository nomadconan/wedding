// 쿠폰함·결제 적용 (S5-12 · F-C-35·36 · §6.2 `/coupons` · **FIX-13**)
//
// ══════════════════════════════════════════════════════════════════════════
// **못 쓰는 쿠폰을 감추지 않는다.**
// ══════════════════════════════════════════════════════════════════════════
//
// F-C-36 이 요구하는 것은 "쓸 수 있는 쿠폰 목록" 이 아니라 **받은 쿠폰 전부와 각각의
// 사유**다. 감추면 고객은 "쿠폰이 없다" 로 이해하고, 최소 주문 금액을 조금 넘기면
// 쓸 수 있다는 사실을 영영 모른다.
//
// 판정은 전부 `coupon.ts` 의 `couponEligibility` 가 한다 — 이 파일은 **목록을 만들고
// 줄을 세우는** 일만 하며 자기 규칙을 갖지 않는다. 규칙이 두 곳에 있으면 화면과
// 결제가 다른 답을 낸다.

import {
  type CouponBlockReason,
  type CouponEligibility,
  type CouponIssueStatus,
  type CouponIssuer,
  type CouponStatus,
  type DiscountType,
  couponEligibility,
} from "./coupon";

/** 화면 한 줄. 발급분 하나에 대응한다. */
export type WalletEntry = {
  issueId: string;
  couponId: string;
  name: string;
  issuerType: CouponIssuer;
  /** 업체 발행이면 그 업체 이름. 플랫폼 발행이면 null. */
  issuerName: string | null;
  discountType: DiscountType;
  discountValue: number;
  maxDiscountAmount: number | null;
  minOrderAmount: number;
  expiresAt: string | null;
  issueStatus: CouponIssueStatus;
  /** 이 결제에 쓸 수 있는가. 주문 금액이 없으면 `null` — **모르는 것을 '못 쓴다' 로 적지 않는다.** */
  usable: boolean | null;
  discountAmount: number | null;
  blockedReason: CouponBlockReason | null;
  blockedDetail: string | null;
};

export type WalletInput = {
  issueId: string;
  couponId: string;
  name: string;
  issuerType: CouponIssuer;
  issuerId: string | null;
  issuerName: string | null;
  discountType: DiscountType;
  discountValue: number;
  maxDiscountAmount: number | null;
  minOrderAmount: number;
  couponStatus: CouponStatus;
  validFrom: string | null;
  totalQuantity: number | null;
  issuedCount: number;
  issueStatus: CouponIssueStatus;
  expiresAt: string | null;
};

/**
 * 쿠폰함 한 화면.
 *
 * `orderAmount` 가 `null` 이면 **특정 결제를 놓고 보는 것이 아니다** — 그때는 적격성을
 * 판정하지 않고 `usable: null` 로 둔다. 0원 주문으로 판정하면 최소 주문 금액에 걸려
 * 전부 "못 쓴다" 가 되고, 그것은 **틀린 답을 확신 있게 적는 것**이다(함정 2).
 */
export function buildWallet(input: {
  entries: readonly WalletInput[];
  orderAmount: number | null;
  appliedCount?: number;
  stackingMode?: "single" | "multiple" | null;
  /** 이 결제가 속한 예약의 업체. 모르면 `null` — **모르는 것을 '안 맞는다' 로 적지 않는다.** */
  bookingVendorId?: string | null;
  now: Date;
}): WalletEntry[] {
  const rows = input.entries.map((entry) => {
    const base: WalletEntry = {
      issueId: entry.issueId,
      couponId: entry.couponId,
      name: entry.name,
      issuerType: entry.issuerType,
      issuerName: entry.issuerName,
      discountType: entry.discountType,
      discountValue: entry.discountValue,
      maxDiscountAmount: entry.maxDiscountAmount,
      minOrderAmount: entry.minOrderAmount,
      expiresAt: entry.expiresAt,
      issueStatus: entry.issueStatus,
      usable: null,
      discountAmount: null,
      blockedReason: null,
      blockedDetail: null,
    };

    if (input.orderAmount === null) return base;

    const verdict: CouponEligibility = couponEligibility({
      coupon: {
        discountType: entry.discountType,
        discountValue: entry.discountValue,
        maxDiscountAmount: entry.maxDiscountAmount,
        minOrderAmount: entry.minOrderAmount,
        status: entry.couponStatus,
        validFrom: entry.validFrom,
        totalQuantity: entry.totalQuantity,
        issuedCount: entry.issuedCount,
        issuerType: entry.issuerType,
        issuerId: entry.issuerId,
      },
      issue: { status: entry.issueStatus, expiresAt: entry.expiresAt },
      orderAmount: input.orderAmount,
      bookingVendorId: input.bookingVendorId,
      appliedCount: input.appliedCount,
      stackingMode: input.stackingMode,
      now: input.now,
    });

    return verdict.ok
      ? { ...base, usable: true, discountAmount: verdict.discountAmount }
      : {
          ...base,
          usable: false,
          blockedReason: verdict.reason,
          blockedDetail: verdict.detail,
        };
  });

  return sortWallet(rows);
}

/**
 * 줄 세우기.
 *
 * **쓸 수 있는 것이 위**다. 그 안에서는 **할인액이 큰 것**, 같으면 **먼저 만료되는 것**.
 * 못 쓰는 것은 아래로 내리되 **지우지 않는다**. 순서가 흔들리면 읽는 사람이 목록을
 * 의심한다(S8-02 가 세운 규칙).
 */
export function sortWallet(rows: readonly WalletEntry[]): WalletEntry[] {
  return [...rows].sort((a, b) => {
    const rank = (row: WalletEntry) => (row.usable === true ? 0 : row.usable === null ? 1 : 2);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);

    const discount = (row: WalletEntry) => row.discountAmount ?? -1;
    if (discount(a) !== discount(b)) return discount(b) - discount(a);

    const expiry = (row: WalletEntry) =>
      row.expiresAt === null ? Number.POSITIVE_INFINITY : Date.parse(row.expiresAt);
    if (expiry(a) !== expiry(b)) return expiry(a) - expiry(b);

    return a.issueId.localeCompare(b.issueId);
  });
}

/**
 * 쿠폰함 요약.
 *
 * **'쓸 수 있는 쿠폰 수' 를 저장하지 않는다**(D-124) — 주문 금액과 시계에 따라 달라지는
 * 값이라 볼 때마다 다시 센다.
 */
export type WalletSummary = {
  total: number;
  /** 이 결제에 쓸 수 있는 수. 주문 금액을 모르면 `null` — **0 으로 적지 않는다.** */
  usable: number | null;
  expiringSoon: number;
};

const SOON_MS = 7 * 24 * 3_600_000;

export function walletSummary(rows: readonly WalletEntry[], now: Date): WalletSummary {
  const judged = rows.some((row) => row.usable !== null);

  return {
    total: rows.length,
    usable: judged ? rows.filter((row) => row.usable === true).length : null,
    // 만료 임박은 **판정 없이도 셀 수 있다** — 시계만 있으면 되기 때문이다.
    expiringSoon: rows.filter((row) => {
      if (row.expiresAt === null || row.issueStatus !== "issued") return false;
      const until = Date.parse(row.expiresAt) - now.getTime();

      return until > 0 && until <= SOON_MS;
    }).length,
  };
}

// =============================================================================
// 결제 적용 — 서버가 다시 판정한다
// =============================================================================

/**
 * 화면이 고른 쿠폰을 그대로 믿지 않는다.
 *
 * **화면은 금액을 보내지 않는다.** 발급분 id 만 보내고 할인액은 **서버가 다시 센다** —
 * 클라이언트가 보낸 금액을 믿으면 그것이 곧 "할인액을 스스로 정하는" 경로가 되고,
 * `borne_by='vendor'` 인 쿠폰에서는 남의 정산에서 돈을 빼는 일이 된다.
 */
export type ApplyVerdict =
  | { ok: true; discountAmount: number; payableAmount: number; borneBy: CouponIssuer }
  | { ok: false; reason: CouponBlockReason | "not_owned" | "not_found"; message: string };

export const APPLY_FAILURE_MESSAGE: Record<"not_owned" | "not_found", string> = {
  not_owned: "이 쿠폰은 회원님의 것이 아니에요.",
  not_found: "쿠폰을 찾을 수 없어요.",
};

export function applyVerdict(input: {
  entry: WalletInput | null;
  installmentAmount: number;
  appliedCount: number;
  stackingMode: "single" | "multiple" | null;
  bookingVendorId?: string | null;
  now: Date;
}): ApplyVerdict {
  if (input.entry === null) {
    return { ok: false, reason: "not_found", message: APPLY_FAILURE_MESSAGE.not_found };
  }

  const [row] = buildWallet({
    entries: [input.entry],
    orderAmount: input.installmentAmount,
    appliedCount: input.appliedCount,
    stackingMode: input.stackingMode,
    bookingVendorId: input.bookingVendorId,
    now: input.now,
  });

  if (row.usable !== true || row.discountAmount === null) {
    return {
      ok: false,
      reason: row.blockedReason ?? "not_active",
      message: row.blockedDetail ?? "지금은 사용할 수 없는 쿠폰이에요.",
    };
  }

  return {
    ok: true,
    discountAmount: row.discountAmount,
    payableAmount: input.installmentAmount - row.discountAmount,
    // **부담 주체는 발행 주체를 그대로 따른다**(D-27). 사용 시점에 박아 두면 발행자가
    // 바뀌어도 이미 쓴 건의 부담이 소급 변경되지 않는다.
    borneBy: input.entry.issuerType,
  };
}

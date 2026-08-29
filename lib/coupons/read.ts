import type { CouponIssuer, CouponStatus, DiscountType } from "@/lib/core/coupon/coupon";
import {
  type WalletEntry,
  type WalletInput,
  type WalletSummary,
  buildWallet,
  walletSummary,
} from "@/lib/core/coupon/wallet";
import { createClient } from "@/lib/supabase/server";

import { readStackingMode } from "./settings";

/**
 * 쿠폰함 읽기 (S5-12 · F-C-35·36 · §6.2 `/coupons`)
 *
 * **세션 클라이언트로 읽는다.** `coupon_issues_select_own`(`user_id = auth.uid()` 또는
 * 커플 구성원)과 `coupons_select_issued`(`has_coupon_issue`)가 경계이며, 서비스롤로
 * 읽으면 그 경계를 우회해 "화면에서만 감추는" 상태가 된다.
 *
 * **임베드를 쓰지 않는다**(함정 1). `coupon_issues` 에서 `coupons` 를 한 번에 끌면
 * `coupons_select_issued` 의 조건에 걸리는 행이 **조용히 빠져** 쿠폰 정의가 없는
 * 발급분이 목록에서 사라진다. 표마다 따로 묻고 코드가 맞춘다.
 */

export type WalletPayload = {
  entries: WalletEntry[];
  summary: WalletSummary;
  /** 이 결제를 놓고 판정했는가. `null` 이면 특정 결제가 아니다. */
  orderAmount: number | null;
  /** 중복 사용 규칙. **값이 없으면 코드가 고르지 않는다** — `single` 이 스키마 기본이다. */
  stackingMode: "single" | "multiple";
};

type IssueRow = {
  id: string;
  coupon_id: string;
  status: string;
  expires_at: string | null;
};

type CouponRow = {
  id: string;
  name: string;
  issuer_type: string;
  issuer_id: string | null;
  discount_type: string;
  discount_value: number;
  max_discount_amount: number | null;
  min_order_amount: number;
  status: string;
  valid_from: string | null;
  total_quantity: number | null;
  issued_count: number;
};

export async function loadWallet(input: {
  orderAmount: number | null;
  appliedCount?: number;
  bookingVendorId?: string | null;
  now: Date;
}): Promise<WalletPayload> {
  const supabase = await createClient();

  const { data: issueRows, error } = await supabase
    .from("coupon_issues")
    .select("id, coupon_id, status, expires_at")
    .order("issued_at", { ascending: false })
    .limit(200);

  if (error) throw new Error("COUPON_LOAD_FAILED");

  const issues = (issueRows ?? []) as IssueRow[];
  const stackingMode = await readStackingMode();

  if (issues.length === 0) {
    return {
      entries: [],
      summary: walletSummary([], input.now),
      orderAmount: input.orderAmount,
      stackingMode,
    };
  }

  const { data: couponRows } = await supabase
    .from("coupons")
    .select(
      "id, name, issuer_type, issuer_id, discount_type, discount_value, max_discount_amount, min_order_amount, status, valid_from, total_quantity, issued_count",
    )
    .in("id", [...new Set(issues.map((row) => row.coupon_id))]);

  const coupons = new Map(((couponRows ?? []) as CouponRow[]).map((row) => [row.id, row]));
  const vendorNames = await nameOfVendors(
    ((couponRows ?? []) as CouponRow[])
      .filter((row) => row.issuer_type === "vendor" && row.issuer_id !== null)
      .map((row) => row.issuer_id as string),
  );

  const entries: WalletInput[] = issues.flatMap((issue) => {
    const coupon = coupons.get(issue.coupon_id);

    // 정의를 못 읽은 발급분은 **할인 조건을 모르는 상태**라 계산할 수 없다.
    // 이러는 경우는 `coupons_select_issued` 가 닫힌 때뿐이고, 그때는 발급분 자체도
    // 안 보이는 것이 맞다 — 둘 중 하나만 보이면 그것이 권한 갈림이므로 `db:rls` 가 대조한다.
    if (!coupon) return [];

    return [
      {
        issueId: issue.id,
        couponId: coupon.id,
        name: coupon.name,
        issuerType: coupon.issuer_type as CouponIssuer,
        issuerId: coupon.issuer_id,
        issuerName:
          coupon.issuer_type === "vendor" && coupon.issuer_id !== null
            ? (vendorNames.get(coupon.issuer_id) ?? null)
            : null,
        discountType: coupon.discount_type as DiscountType,
        discountValue: coupon.discount_value,
        maxDiscountAmount: coupon.max_discount_amount,
        minOrderAmount: coupon.min_order_amount,
        couponStatus: coupon.status as CouponStatus,
        validFrom: coupon.valid_from,
        totalQuantity: coupon.total_quantity,
        issuedCount: coupon.issued_count,
        issueStatus: issue.status as WalletInput["issueStatus"],
        expiresAt: issue.expires_at,
      },
    ];
  });

  const rows = buildWallet({
    entries,
    orderAmount: input.orderAmount,
    appliedCount: input.appliedCount,
    stackingMode,
    bookingVendorId: input.bookingVendorId,
    now: input.now,
  });

  return {
    entries: rows,
    summary: walletSummary(rows, input.now),
    orderAmount: input.orderAmount,
    stackingMode,
  };
}

/** 발급분 하나를 판정에 필요한 모양으로 읽는다. **서비스롤이 아니라 세션이다.** */
export async function loadWalletEntry(issueId: string): Promise<WalletInput | null> {
  const supabase = await createClient();

  const { data: issueRow } = await supabase
    .from("coupon_issues")
    .select("id, coupon_id, status, expires_at")
    .eq("id", issueId)
    .maybeSingle();

  const issue = issueRow as IssueRow | null;

  // **RLS 가 안 보여주면 없는 것과 같게 답한다** — 남의 쿠폰의 존재 여부를 알려주지 않는다.
  if (!issue) return null;

  const { data: couponRow } = await supabase
    .from("coupons")
    .select(
      "id, name, issuer_type, issuer_id, discount_type, discount_value, max_discount_amount, min_order_amount, status, valid_from, total_quantity, issued_count",
    )
    .eq("id", issue.coupon_id)
    .maybeSingle();

  const coupon = couponRow as CouponRow | null;
  if (!coupon) return null;

  return {
    issueId: issue.id,
    couponId: coupon.id,
    name: coupon.name,
    issuerType: coupon.issuer_type as CouponIssuer,
    issuerId: coupon.issuer_id,
    issuerName: null,
    discountType: coupon.discount_type as DiscountType,
    discountValue: coupon.discount_value,
    maxDiscountAmount: coupon.max_discount_amount,
    minOrderAmount: coupon.min_order_amount,
    couponStatus: coupon.status as CouponStatus,
    validFrom: coupon.valid_from,
    totalQuantity: coupon.total_quantity,
    issuedCount: coupon.issued_count,
    issueStatus: issue.status as WalletInput["issueStatus"],
    expiresAt: issue.expires_at,
  };
}

async function nameOfVendors(ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();

  const supabase = await createClient();
  const { data } = await supabase.from("vendors").select("id, name").in("id", unique);

  return new Map(((data ?? []) as { id: string; name: string }[]).map((row) => [row.id, row.name]));
}

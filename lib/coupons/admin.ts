import { readSetting } from "@/lib/app-settings";
import { recordEvent } from "@/lib/audit/record";
import type { CouponStatus, DiscountType } from "@/lib/core/coupon/coupon";
import {
  type CouponForm,
  type CouponFormError,
  type CouponStatusRow,
  type CouponSummary,
  buildStatusRow,
  frozenViolations,
  summarize,
  validateCouponForm,
} from "@/lib/core/coupon/issue";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * 플랫폼 쿠폰 관리 (S5-14 · F-A-19 · §6.4 `/admin/coupons`)
 *
 * **업체 쿠폰과 한 화면에 두지 않는다**(T-00e). 이 파일은 `issuer_type='platform'`
 * 만 읽고 쓴다 — 운영자가 업체 이름으로 쿠폰을 만들면 **남의 정산에서 깎는 쿠폰**이
 * 되고, 부담 주체가 만든 사람과 갈린다(FIX-45 가 드러낸 것과 같은 자리).
 * 그 경계는 화면이 아니라 **정책**이 지킨다(`coupons_write_platform`).
 *
 * **판정은 S5-13 이 만든 순수 함수를 그대로 쓴다.** 발행 폼의 규칙(리뷰 대가 금지 ·
 * 정률 상한 필수 · 발급 뒤 동결)은 두 면이 같아야 한다 — 한쪽만 느슨하면 그쪽이
 * 우회로가 된다.
 */

export type AdminCouponPayload = {
  rows: CouponStatusRow[];
  summary: CouponSummary;
  platformRateCapBp: number | null;
  /**
   * 비용은 **전액 플랫폼 손익**이다(F-A-19). 업체 정산에 닿지 않는다는 사실을
   * 화면이 적을 수 있게 들고 간다.
   */
  costBearer: "platform";
  /** 기간별 부담액. **집계는 볼 때마다 다시 센다**(D-124). */
  periodCost: { from: string; to: string; amount: number };
  /** 발급 실행 경로가 없다는 사실(FIX-46). 업체 면과 같은 고지다. */
  issuanceWired: false;
  /**
   * 대상 세그먼트. **만들지 않았다** — 그것을 읽는 코드가 없어(FIX-46) 설정 칸을
   * 두면 '지정했는데 아무 일도 안 일어나는' 상태가 된다(D-143 · S8-12 와 같은 판단).
   */
  segmentTargeting: { available: false; reason: string };
};

const SEGMENT_UNAVAILABLE = {
  available: false as const,
  reason:
    "대상 세그먼트 지정은 아직 없습니다. 쿠폰을 고객에게 실제로 꽂는 경로 자체가 없어서(FIX-46), 세그먼트를 적어도 그것을 읽는 코드가 없습니다 — 설정 칸을 두면 '지정했는데 아무 일도 안 일어나는' 상태가 됩니다. 발급 경로가 정해지면 세그먼트의 모양도 그때 정해집니다.",
};

type CouponRow = {
  id: string;
  name: string;
  status: string;
  discount_type: string;
  discount_value: number;
  max_discount_amount: number | null;
  min_order_amount: number;
  issue_condition: string;
  valid_from: string | null;
  valid_to: string | null;
  total_quantity: number | null;
  issued_count: number;
};

const COST_WINDOW_DAYS = 30;

export async function loadPlatformCoupons(now: Date): Promise<AdminCouponPayload> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("coupons")
    .select(
      "id, name, status, discount_type, discount_value, max_discount_amount, min_order_amount, issue_condition, valid_from, valid_to, total_quantity, issued_count",
    )
    .eq("issuer_type", "platform")
    .order("created_at", { ascending: false })
    .limit(200);

  // **권한 실패와 조회 실패를 구분한다** — 앞은 로그인 문제고 뒤는 장애다.
  if (error) {
    throw new Error(error.code === "42501" ? "ADMIN_COUPON_FORBIDDEN" : "ADMIN_COUPON_LOAD_FAILED");
  }

  const coupons = (data ?? []) as CouponRow[];
  const platformRateCapBp = await readRateCap();
  const from = new Date(now.getTime() - COST_WINDOW_DAYS * 86_400_000).toISOString();

  if (coupons.length === 0) {
    return {
      rows: [],
      summary: summarize([], true),
      platformRateCapBp,
      costBearer: "platform",
      periodCost: { from, to: now.toISOString(), amount: 0 },
      issuanceWired: false,
      segmentTargeting: SEGMENT_UNAVAILABLE,
    };
  }

  const ids = coupons.map((row) => row.id);

  // **임베드를 쓰지 않는다**(함정 1) — 표마다 따로 묻고 코드가 맞춘다.
  const { data: issueRows } = await supabase
    .from("coupon_issues")
    .select("id, coupon_id")
    .in("coupon_id", ids);

  const issues = (issueRows ?? []) as { id: string; coupon_id: string }[];
  const issueToCoupon = new Map(issues.map((row) => [row.id, row.coupon_id]));

  const used = new Map<string, { count: number; amount: number }>();
  let periodAmount = 0;

  if (issues.length > 0) {
    const { data: redemptionRows } = await supabase
      .from("coupon_redemptions")
      .select("coupon_issue_id, discount_amount, redeemed_at")
      .in("coupon_issue_id", issues.map((row) => row.id));

    for (const row of (redemptionRows ?? []) as {
      coupon_issue_id: string;
      discount_amount: number;
      redeemed_at: string;
    }[]) {
      const couponId = issueToCoupon.get(row.coupon_issue_id);
      if (!couponId) continue;

      const prev = used.get(couponId) ?? { count: 0, amount: 0 };
      used.set(couponId, { count: prev.count + 1, amount: prev.amount + row.discount_amount });

      if (row.redeemed_at >= from) periodAmount += row.discount_amount;
    }
  }

  const rows = coupons.map((coupon) =>
    buildStatusRow({
      coupon: {
        id: coupon.id,
        name: coupon.name,
        status: coupon.status as CouponStatus,
        discountType: coupon.discount_type as DiscountType,
        discountValue: coupon.discount_value,
        maxDiscountAmount: coupon.max_discount_amount,
        minOrderAmount: coupon.min_order_amount,
        issueCondition: coupon.issue_condition,
        validFrom: coupon.valid_from,
        validTo: coupon.valid_to,
        totalQuantity: coupon.total_quantity,
        issuedCount: coupon.issued_count,
      },
      usedCount: used.get(coupon.id)?.count ?? 0,
      // 운영자는 플랫폼 부담액을 본다 — **이것이 곧 플랫폼 손익**이라 가릴 이유가 없다.
      deductedAmount: used.get(coupon.id)?.amount ?? 0,
      now,
    }),
  );

  return {
    rows,
    summary: summarize(rows, true),
    platformRateCapBp,
    costBearer: "platform",
    periodCost: { from, to: now.toISOString(), amount: periodAmount },
    issuanceWired: false,
    segmentTargeting: SEGMENT_UNAVAILABLE,
  };
}

export type AdminCouponResult =
  | { ok: true; couponId: string }
  | { ok: false; status: number; code: string; message: string; errors?: CouponFormError[] };

/**
 * 플랫폼 쿠폰을 만든다.
 *
 * **`issuer_type` 을 입력으로 받지 않는다** — 여기서 만드는 것은 언제나 플랫폼
 * 쿠폰이다. 받으면 운영자가 `vendor` 로 적어 **남의 정산에서 깎는 쿠폰**을 만들 수
 * 있고, 그것이 T-00e 가 두 화면을 가른 이유다. 정책도 같은 것을 못 박는다.
 */
export async function createPlatformCoupon(input: {
  form: CouponForm;
  actorId: string;
  actorRole: string | null;
}): Promise<AdminCouponResult> {
  const platformRateCapBp = await readRateCap();
  const errors = validateCouponForm(input.form, platformRateCapBp);

  if (errors.length > 0) {
    return {
      ok: false,
      status: 422,
      code: "COUPON_FORM_INVALID",
      message: "쿠폰을 만들 수 없습니다.",
      errors,
    };
  }

  const admin = createAdminClient();

  const { data, error } = await admin
    .from("coupons")
    .insert({
      // **여기서 만드는 것은 언제나 플랫폼 쿠폰이다.**
      issuer_type: "platform",
      issuer_id: null,
      name: input.form.name.trim(),
      discount_type: input.form.discountType,
      discount_value: input.form.discountValue,
      max_discount_amount: input.form.maxDiscountAmount,
      min_order_amount: input.form.minOrderAmount,
      issue_condition: input.form.issueCondition,
      valid_from: input.form.validFrom,
      valid_to: input.form.validTo,
      total_quantity: input.form.totalQuantity,
      status: "active",
    })
    .select("id")
    .maybeSingle();

  if (error || !data) {
    const conditionViolation = (error?.message ?? "").includes("issue_condition");

    return {
      ok: false,
      status: conditionViolation ? 422 : 500,
      code: conditionViolation ? "COUPON_CONDITION_REJECTED" : "COUPON_CREATE_FAILED",
      message: conditionViolation ? "발행할 수 없는 조건입니다." : "쿠폰을 만들지 못했습니다.",
    };
  }

  const couponId = (data as { id: string }).id;

  await recordEvent({
    entityType: "coupon_issue",
    entityId: couponId,
    eventType: "coupon_created",
    actor: { id: input.actorId, role: input.actorRole },
    beforeState: null,
    afterState: "active",
    source: "admin",
    // **쿠폰 이름을 담지 않는다**(§7.3). 남길 사실은 부담 주체·방식·값·수량이다.
    memo: `issuer=platform type=${input.form.discountType} value=${input.form.discountValue} qty=${input.form.totalQuantity ?? "unlimited"}`,
  });

  return { ok: true, couponId };
}

/** 플랫폼 쿠폰을 고친다. **발급이 시작되면 돈에 관한 조건은 얼어붙는다**(D-159). */
export async function updatePlatformCoupon(input: {
  couponId: string;
  form: CouponForm;
  status: CouponStatus;
  actorId: string;
  actorRole: string | null;
}): Promise<AdminCouponResult> {
  const supabase = await createClient();

  const { data: current } = await supabase
    .from("coupons")
    .select(
      "id, issuer_type, status, discount_type, discount_value, max_discount_amount, min_order_amount, issue_condition, valid_from, valid_to, total_quantity, issued_count, name",
    )
    .eq("id", input.couponId)
    .maybeSingle();

  const coupon = current as (CouponRow & { issuer_type: string }) | null;

  // **업체 쿠폰은 이 경로로 못 고친다**(T-00e). 정책도 막지만 여기서 먼저 답해야
  // 화면이 이유를 적을 수 있다.
  if (!coupon || coupon.issuer_type !== "platform") {
    return { ok: false, status: 404, code: "COUPON_NOT_FOUND", message: "쿠폰을 찾을 수 없습니다." };
  }

  const platformRateCapBp = await readRateCap();
  const errors = validateCouponForm(input.form, platformRateCapBp);

  if (errors.length > 0) {
    return {
      ok: false,
      status: 422,
      code: "COUPON_FORM_INVALID",
      message: "쿠폰을 고칠 수 없습니다.",
      errors,
    };
  }

  const violations = frozenViolations({
    before: {
      name: coupon.name,
      discountType: coupon.discount_type as DiscountType,
      discountValue: coupon.discount_value,
      maxDiscountAmount: coupon.max_discount_amount,
      minOrderAmount: coupon.min_order_amount,
      issueCondition: coupon.issue_condition,
      validFrom: coupon.valid_from,
      validTo: coupon.valid_to,
      totalQuantity: coupon.total_quantity,
    },
    after: input.form,
    issuedCount: coupon.issued_count,
  });

  if (violations.length > 0) {
    return {
      ok: false,
      status: 409,
      code: "COUPON_TERMS_FROZEN",
      message: `이미 ${coupon.issued_count}장이 발급된 쿠폰입니다. 할인 조건은 바꿀 수 없습니다(${violations.join(", ")}). 새 쿠폰을 만드세요.`,
    };
  }

  const admin = createAdminClient();

  const { error } = await admin
    .from("coupons")
    .update({
      name: input.form.name.trim(),
      discount_type: input.form.discountType,
      discount_value: input.form.discountValue,
      max_discount_amount: input.form.maxDiscountAmount,
      min_order_amount: input.form.minOrderAmount,
      issue_condition: input.form.issueCondition,
      valid_from: input.form.validFrom,
      valid_to: input.form.validTo,
      total_quantity: input.form.totalQuantity,
      status: input.status,
    })
    .eq("id", input.couponId);

  if (error) {
    const frozen = (error.message ?? "").includes("발급된 쿠폰");

    return {
      ok: false,
      status: frozen ? 409 : 500,
      code: frozen ? "COUPON_TERMS_FROZEN" : "COUPON_UPDATE_FAILED",
      message: frozen
        ? "이미 발급된 쿠폰의 할인 조건은 바꿀 수 없습니다."
        : "쿠폰을 고치지 못했습니다.",
    };
  }

  await recordEvent({
    entityType: "coupon_issue",
    entityId: input.couponId,
    eventType: coupon.status === input.status ? "coupon_updated" : "coupon_status_changed",
    actor: { id: input.actorId, role: input.actorRole },
    beforeState: coupon.status,
    afterState: input.status,
    source: "admin",
    memo: `issuer=platform frozen=${coupon.issued_count > 0}`,
  });

  return { ok: true, couponId: input.couponId };
}

async function readRateCap(): Promise<number | null> {
  const setting = await readSetting("coupon.max_discount_rate_bp");
  const value = (setting as { rateBp?: unknown } | null)?.rateBp;

  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

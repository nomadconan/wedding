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
 * 업체 쿠폰 발행·관리 (S5-13 · F-V-19 · §6.3 `/vendor/coupons`)
 *
 * **읽기는 세션, 쓰기는 서비스롤이다**(D-62). 목록은 `coupons_select_vendor`
 * (`is_vendor_member`)가 가르고, 정산 차감액은 `coupon_redemptions_select_vendor`
 * (**대표 전용** · 0067)가 가른다 — 화면이 가리는 것이 아니라 **RLS 가 안 준다.**
 *
 * **임베드를 쓰지 않는다**(함정 1). `coupons` 에서 `coupon_issues`·
 * `coupon_redemptions` 를 한 번에 끌면, 대표가 아닌 사람에게는 redemption 행이
 * **조용히 빠져** 사용 수가 0 으로 보인다 — 그것은 "안 쓰였다" 가 아니라 "못 본다" 다.
 * 표마다 따로 묻고 **못 본 것은 `null` 로 남긴다.**
 */

export type VendorCouponPayload = {
  rows: CouponStatusRow[];
  summary: CouponSummary;
  /** 대표인가. 화면이 "왜 금액이 안 보이는가" 를 적는 데 쓴다. */
  canSeeMoney: boolean;
  /** 플랫폼 최대 할인율. **미설정이면 `null`** 이며 화면이 그 사실을 적는다. */
  platformRateCapBp: number | null;
  /**
   * 발급을 실행하는 경로가 아직 없다는 사실.
   *
   * **F-V-19 는 '발급·사용 현황' 까지다.** 조건이 맞는 고객에게 실제로 쿠폰을 꽂는
   * 배치·훅은 §4.5 에도 없고 어느 태스크에도 배정돼 있지 않다(FIX-46). 그것을 안
   * 적으면 업체는 만든 쿠폰이 고객에게 갔다고 믿는다.
   */
  issuanceWired: false;
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

export async function loadVendorCoupons(input: {
  vendorId: string;
  isOwner: boolean;
  now: Date;
}): Promise<VendorCouponPayload> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("coupons")
    .select(
      "id, name, status, discount_type, discount_value, max_discount_amount, min_order_amount, issue_condition, valid_from, valid_to, total_quantity, issued_count",
    )
    .eq("issuer_type", "vendor")
    .eq("issuer_id", input.vendorId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) throw new Error("VENDOR_COUPON_LOAD_FAILED");

  const coupons = (data ?? []) as CouponRow[];
  const platformRateCapBp = await readRateCap();

  if (coupons.length === 0) {
    return {
      rows: [],
      summary: summarize([], input.isOwner),
      canSeeMoney: input.isOwner,
      platformRateCapBp,
      issuanceWired: false,
    };
  }

  const ids = coupons.map((row) => row.id);

  // 발급 수는 **발급분을 세서** 만든다 — `issued_count` 는 수량 제한의 근거이고
  // 화면이 보여 줄 값은 실제로 남아 있는 행이다. 둘이 갈리면 그것도 사실이다.
  const { data: issueRows } = await supabase
    .from("coupon_issues")
    .select("id, coupon_id")
    .in("coupon_id", ids);

  const issues = (issueRows ?? []) as { id: string; coupon_id: string }[];
  const issueToCoupon = new Map(issues.map((row) => [row.id, row.coupon_id]));

  // **대표만 금액을 본다.** 대표가 아니면 아예 묻지 않는다 — 물어서 빈 결과를 받는
  // 것과 안 묻는 것은 같아 보이지만, 안 묻는 쪽이 "못 본다" 를 코드가 말한다.
  const used = new Map<string, { count: number; amount: number }>();

  if (input.isOwner && issues.length > 0) {
    const { data: redemptionRows } = await supabase
      .from("coupon_redemptions")
      .select("coupon_issue_id, discount_amount")
      .in("coupon_issue_id", issues.map((row) => row.id));

    for (const row of (redemptionRows ?? []) as {
      coupon_issue_id: string;
      discount_amount: number;
    }[]) {
      const couponId = issueToCoupon.get(row.coupon_issue_id);
      if (!couponId) continue;

      const prev = used.get(couponId) ?? { count: 0, amount: 0 };
      used.set(couponId, { count: prev.count + 1, amount: prev.amount + row.discount_amount });
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
      // **대표가 아니면 0 이 아니라 `null`** 이다(함정 2).
      deductedAmount: input.isOwner ? (used.get(coupon.id)?.amount ?? 0) : null,
      now: input.now,
    }),
  );

  return {
    rows,
    summary: summarize(rows, input.isOwner),
    canSeeMoney: input.isOwner,
    platformRateCapBp,
    issuanceWired: false,
  };
}

// =============================================================================
// 발행·수정 — 쓰기는 서비스롤, 자격은 서버가 판정한다
// =============================================================================

export type CouponWriteResult =
  | { ok: true; couponId: string }
  | { ok: false; status: number; code: string; message: string; errors?: CouponFormError[] };

/**
 * 쿠폰을 만든다.
 *
 * **대표만 만든다**(`coupons_write_vendor` 가 `is_vendor_owner` 다). 그 자격을
 * 서버가 세션으로 확인하고, RLS 가 최종 경계로 한 번 더 본다.
 *
 * **`issuer_id` 를 입력으로 받지 않는다** — 세션이 정한다. 받으면 남의 업체 이름으로
 * 쿠폰을 만들 수 있고, 그 쿠폰의 할인액은 **그 업체 정산에서 나간다**(FIX-45 가
 * 드러낸 것과 같은 자리다: 비용이 엉뚱한 쪽으로 간다).
 */
export async function createVendorCoupon(input: {
  vendorId: string;
  form: CouponForm;
  actorId: string;
  actorRole: string | null;
}): Promise<CouponWriteResult> {
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
      issuer_type: "vendor",
      // **세션이 정한 업체.** 비용을 지는 쪽과 만드는 쪽이 같아야 한다.
      issuer_id: input.vendorId,
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
    // 발행 조건 CHECK 위반은 **최종 경계가 막은 것**이다 — 화면·API 가 놓친 값이라는
    // 뜻이므로 사용자에게는 같은 문장을 준다.
    const conditionViolation = (error?.message ?? "").includes("issue_condition");

    return {
      ok: false,
      status: conditionViolation ? 422 : 500,
      code: conditionViolation ? "COUPON_CONDITION_REJECTED" : "COUPON_CREATE_FAILED",
      message: conditionViolation
        ? "발행할 수 없는 조건입니다."
        : "쿠폰을 만들지 못했습니다.",
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
    // **쿠폰 이름을 담지 않는다**(§7.3). 남길 사실은 방식·값·수량이다.
    memo: `type=${input.form.discountType} value=${input.form.discountValue} qty=${input.form.totalQuantity ?? "unlimited"}`,
  });

  return { ok: true, couponId };
}

/**
 * 쿠폰을 고친다.
 *
 * **발급이 시작되면 돈에 관한 조건은 얼어붙는다**(0067 트리거가 최종 경계다).
 * 여기서 먼저 판정하는 이유는 화면이 **왜** 막혔는지 말할 수 있어야 하기 때문이다 —
 * 트리거 메시지만 올려보내면 어느 칸이 문제인지 아무도 모른다.
 */
export async function updateVendorCoupon(input: {
  couponId: string;
  vendorId: string;
  form: CouponForm;
  status: CouponStatus;
  actorId: string;
  actorRole: string | null;
}): Promise<CouponWriteResult> {
  const supabase = await createClient();

  // **RLS 에게 먼저 묻는다** — 내 업체의 쿠폰인가. 안 보이면 없는 것과 같게 답한다.
  const { data: current } = await supabase
    .from("coupons")
    .select(
      "id, issuer_id, status, discount_type, discount_value, max_discount_amount, min_order_amount, issue_condition, valid_from, valid_to, total_quantity, issued_count, name",
    )
    .eq("id", input.couponId)
    .maybeSingle();

  const coupon = current as CouponRow & { issuer_id: string | null };

  if (!coupon || coupon.issuer_id !== input.vendorId) {
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

  const before: CouponForm = {
    name: coupon.name,
    discountType: coupon.discount_type as DiscountType,
    discountValue: coupon.discount_value,
    maxDiscountAmount: coupon.max_discount_amount,
    minOrderAmount: coupon.min_order_amount,
    issueCondition: coupon.issue_condition,
    validFrom: coupon.valid_from,
    validTo: coupon.valid_to,
    totalQuantity: coupon.total_quantity,
  };

  const violations = frozenViolations({
    before,
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
      // **`issued_count` 를 쓰지 않는다.** 0066 이 컬럼 권한을 걷은 값이고, 발급
      // 트랜잭션만 올린다.
    })
    .eq("id", input.couponId);

  if (error) {
    // 트리거가 막았다면 위 판정이 놓친 것이다 — 같은 뜻의 답을 준다.
    const frozen = (error.message ?? "").includes("발급된 쿠폰");

    return {
      ok: false,
      status: frozen ? 409 : 500,
      code: frozen ? "COUPON_TERMS_FROZEN" : "COUPON_UPDATE_FAILED",
      message: frozen ? "이미 발급된 쿠폰의 할인 조건은 바꿀 수 없습니다." : "쿠폰을 고치지 못했습니다.",
    };
  }

  await recordEvent({
    entityType: "coupon_issue",
    entityId: input.couponId,
    eventType: coupon.status === input.status ? "coupon_updated" : "coupon_status_changed",
    actor: { id: input.actorId, role: input.actorRole },
    beforeState: coupon.status,
    afterState: input.status,
    memo: `frozen=${coupon.issued_count > 0}`,
  });

  return { ok: true, couponId: input.couponId };
}

/** 로그인한 사용자의 업체와 대표 여부. 없으면 null. */
export async function vendorContext(
  userId: string,
): Promise<{ vendorId: string; isOwner: boolean } | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("vendor_members")
    .select("vendor_id, vendor_role")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  const row = data as { vendor_id: string; vendor_role: string } | null;
  if (!row) return null;

  return { vendorId: row.vendor_id, isOwner: row.vendor_role === "owner" };
}

/**
 * 플랫폼 최대 할인율 (`app_settings.coupon.max_discount_rate_bp`).
 *
 * **값이 없으면 `null`** 이고 그때는 상한 판정을 하지 않는다 — 코드가 상한을 지어내면
 * 그 순간 운영 파라미터의 두 번째 진실이 된다.
 */
async function readRateCap(): Promise<number | null> {
  const setting = await readSetting("coupon.max_discount_rate_bp");
  const value = (setting as { rateBp?: unknown } | null)?.rateBp;

  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

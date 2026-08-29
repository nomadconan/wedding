import { loadWallet } from "@/lib/coupons/read";
import { priorDiscountOf } from "@/lib/coupons/redeem";
import type { WalletEntry, WalletSummary } from "@/lib/core/coupon/wallet";
import {
  CHECKOUT_CONSENT_ITEMS,
  CHECKOUT_CONSENT_VERSION,
  COUPON_SLOT_MESSAGE,
  COUPON_SLOT_OWNER_TASK,
  PAY_BLOCK_MESSAGE,
  checkoutAmounts,
  couponSlotState,
  paymentProgress,
  viewSchedules,
  type CheckoutAmounts,
  type ConsentItem,
  type CouponSlotState,
  type ScheduleRow,
} from "@/lib/core/payment/checkout";
import { SCHEDULE_STATE_LABEL } from "@/lib/core/payment/payment";

/**
 * 결제 화면·API 가 함께 쓰는 조회 (S5-06)
 *
 * **화면과 API 가 같은 함수를 쓴다.** 판정 규칙을 두 벌 만들면 언젠가 화면과 API 의
 * 답이 갈리고, 그때 어느 쪽이 맞는지 알 수 없다(S4-07 이 상담에서 세운 규칙).
 *
 * **읽기는 호출자가 넘긴 세션 클라이언트로 한다.** `payment_schedules` 정책은 커플
 * **owner** 와 업체 멤버에게만 열려 있고(0028), 읽히면 당사자다 — 그것이 경계다.
 * 여기서 couple_id 를 다시 비교하지 않는다(§5.5 — 앱 레벨 체크는 보안 경계가 아니다).
 */
type Reader = Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>;

export type CheckoutSchedule = {
  id: string;
  seq: number;
  amount: number;
  status: string;
  dueAt: string | null;
  state: string;
  stateLabel: string;
  payable: boolean;
  blockedReason: string | null;
  blockedMessage: string | null;
};

export type CheckoutPayload = {
  /** 이 예약의 업체. 업체 발행 쿠폰의 적용 대상을 가르는 데 쓴다(FIX-45). */
  vendorId: string | null;
  contract: {
    id: string;
    status: string;
    totalAmount: number;
    contentHash: string | null;
    signingDeadlineAt: string | null;
  };
  schedules: CheckoutSchedule[];
  progress: ReturnType<typeof paymentProgress>;
  next: { scheduleId: string; seq: number; amounts: CheckoutAmounts } | null;
  consent: { version: string; items: readonly ConsentItem[] };
  coupon: {
    state: CouponSlotState;
    message: string;
    ownerTask: string;
    entries: WalletEntry[];
    summary: WalletSummary;
    stackingMode: "single" | "multiple";
  };
};

export async function loadCheckout(
  client: Reader,
  bookingId: string,
  now: Date = new Date(),
): Promise<CheckoutPayload | null> {
  const { data: contractRow } = await client
    .from("contracts")
    .select("id, status, total_amount, content_hash, signing_deadline_at")
    .eq("booking_id", bookingId)
    .neq("status", "cancelled")
    .maybeSingle();

  const contract = contractRow as {
    id: string;
    status: string;
    total_amount: number | null;
    content_hash: string | null;
    signing_deadline_at: string | null;
  } | null;

  if (!contract) return null;

  const { data: rows } = await client
    .from("payment_schedules")
    .select("id, seq, amount, status, due_at")
    .eq("contract_id", contract.id)
    .order("seq", { ascending: true });

  const schedules: ScheduleRow[] = (
    (rows ?? []) as {
      id: string;
      seq: number;
      amount: number;
      status: string;
      due_at: string | null;
    }[]
  ).map((row) => ({
    id: row.id,
    seq: row.seq,
    amount: row.amount,
    status: row.status as ScheduleRow["status"],
    dueAt: row.due_at,
  }));

  // 진행 중인 결제는 그 회차를 잠근다 — 0030 의 회차당 pending 유니크와 같은 판정을
  // 화면에서도 보여야 "왜 버튼이 막혔는가" 를 답할 수 있다.
  const { data: pendingRows } = await client
    .from("payments")
    .select("payment_schedule_id")
    .eq("status", "pending")
    .not("payment_schedule_id", "is", null);

  const views = viewSchedules({
    schedules,
    contractActive: contract.status === "active",
    pendingScheduleIds: ((pendingRows ?? []) as { payment_schedule_id: string }[]).map(
      (row) => row.payment_schedule_id,
    ),
    now,
  });

  const progress = paymentProgress(schedules);
  const totalAmount = contract.total_amount ?? progress.totalAmount;
  const next = views.find((view) => view.payable) ?? null;
  // ── 쿠폰 ── **이제 실제로 열렸다**(S5-12). '준비 중' 을 지운다 ───────────
  //
  // **낼 회차를 놓고 판정한다.** 주문 금액 없이 재면 최소 주문 금액에 걸려 전부
  // "못 쓴다" 가 되고, 그것은 틀린 답을 확신 있게 적는 일이다(함정 2).
  // 이 예약의 업체. **업체 발행 쿠폰은 그 업체와의 거래에만 쓴다**(FIX-45).
  const { data: bookingRow } = await client
    .from("bookings")
    .select("vendor_id")
    .eq("id", bookingId)
    .maybeSingle();
  const vendorId = (bookingRow as { vendor_id: string } | null)?.vendor_id ?? null;

  const wallet = await loadWallet({
    orderAmount: next?.amount ?? null,
    bookingVendorId: vendorId,
    now,
  });
  // **이미 쓴 할인의 합.** 계약 총액은 쿠폰 전 금액이고 낸 돈은 할인 뒤 금액이라,
  // 이것을 안 빼면 마지막 회차까지 낸 뒤에도 잔액이 남는다(FIX-13).
  const priorDiscountAmount = await priorDiscountOf(bookingId);
  const coupon = couponSlotState({
    featureReady: true,
    applicableCount: wallet.summary.usable ?? 0,
  });

  return {
    vendorId,
    contract: {
      id: contract.id,
      status: contract.status,
      totalAmount,
      contentHash: contract.content_hash,
      signingDeadlineAt: contract.signing_deadline_at,
    },
    schedules: views.map((view) => ({
      id: view.id,
      seq: view.seq,
      amount: view.amount,
      status: view.status,
      dueAt: view.dueAt,
      state: view.state,
      stateLabel: SCHEDULE_STATE_LABEL[view.state],
      payable: view.payable,
      blockedReason: view.blockedReason,
      blockedMessage: view.blockedReason ? PAY_BLOCK_MESSAGE[view.blockedReason] : null,
    })),
    progress,
    next:
      next === null
        ? null
        : {
            scheduleId: next.id,
            seq: next.seq,
            amounts: checkoutAmounts({
              contractTotal: totalAmount,
              installmentAmount: next.amount,
              paidAmount: progress.paidAmount,
              // **이미 쓴 할인을 넘긴다**(FIX-13) — 안 넘기면 다 낸 뒤에도 잔액이 남는다.
              priorDiscountAmount,
            }),
          },
    consent: { version: CHECKOUT_CONSENT_VERSION, items: CHECKOUT_CONSENT_ITEMS },
    // **못 쓰는 쿠폰도 사유와 함께 내려보낸다**(F-C-36) — 감추면 "쿠폰이 없다" 로
    // 읽히고, 최소 주문 금액을 조금 넘기면 쓸 수 있다는 사실을 영영 모른다.
    coupon: {
      state: coupon,
      message: COUPON_SLOT_MESSAGE[coupon],
      ownerTask: COUPON_SLOT_OWNER_TASK,
      entries: wallet.entries,
      summary: wallet.summary,
      stackingMode: wallet.stackingMode,
    },
  };
}

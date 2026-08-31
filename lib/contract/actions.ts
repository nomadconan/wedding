import { readIntSetting, readSetting } from "@/lib/app-settings";
import { recordEvent } from "@/lib/audit/record";
import {
  PLACEHOLDER_TEMPLATE_VERSION,
  canSign,
  contractTotalFromQuote,
  quoteEligibility,
  requiredSignerRoles,
  signingProgress,
  signingState,
  type ClauseSlot,
  type ContractContent,
  type SignerRole,
} from "@/lib/core/contract/contract";
import {
  dueAtOf,
  payableAtOf,
  plannerEarning,
  resolveGraceDays,
  resolveSplitPlans,
  splitAmount,
} from "@/lib/core/payment/payment";
import {
  PLANNER_FEE_SCOPE_ORDER,
  resolveRate,
  type RateRecord,
} from "@/lib/core/pricing/rates";
import { sendNotification } from "@/lib/notify/send";
import { resolveVendorCommission } from "@/lib/pricing/vendor-rate";
import {
  ISSUE_BLOCK_MESSAGE,
  canIssueContract,
} from "@/lib/core/booking/console";
import {
  loadPlannerRateRecords,
  resolvePlannerRateBp,
  selectedPlannerByCategory,
} from "@/lib/planners/rates";
import { createAdminClient } from "@/lib/supabase/admin";

import { contentHash } from "./hash";
import { verifyIdentity } from "./verification";

/**
 * 계약 발행 · 서명 · 확정 (S5-04 · S5-05 의 서버 경로 · S5-06 이 이어 씀)
 *
 * ── 왜 S5-06 에서 이 파일이 나오는가 ────────────────────────────────────────
 * 분할 결제(S5-06)의 입력은 `payment_schedules` 이고, 그 회차는 **계약 발행 시점에**
 * 만들어진다(0029 근거 8 — F-C-14 가 "각 회차의 지급 조건·기한·금액을 결제 전 고지"
 * 를 요구하므로 서명 전에 있어야 한다). S5-04·S5-05 는 스키마와 순수 함수까지만
 * 끝나 있었고 발행·서명 경로가 없었다. 그 경로 없이 결제만 만들면 **아무도 부를 수
 * 없는 코드**가 되므로 여기서 채운다. 범위를 늘린 것이 아니라 **선행의 잔여**다.
 *
 * ── 손의 구분 ───────────────────────────────────────────────────────────────
 * 전부 **서비스롤**이다. 0029 가 `contract_signatures` 의 INSERT 정책을 내렸고
 * (본인확인 없이 서명했다고 적을 수 있으므로), 요율·금액·회차는 당사자가 적을 수
 * 있으면 안 되는 값이다. 권한 판정은 이 파일을 부르는 API 가 세션으로 한다.
 *
 * ── 판정은 순수 함수가 한다 ─────────────────────────────────────────────────
 * 발행 자격·서명 진행·기한 판정은 `lib/core/contract`, 회차 분할·기한 계산은
 * `lib/core/payment` 가 갖는다. 이 파일은 그 결과를 DB 에 옮길 뿐이다.
 */
export type ContractFailure = { status: number; code: string; message: string };

function failure(
  status: number,
  code: string,
  message: string,
): ContractFailure {
  return { status, code, message };
}

export function isFailure(value: unknown): value is ContractFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "status" in value
  );
}

// =============================================================================
// 발행 — 회차가 여기서 생긴다
// =============================================================================

export type IssueResult = { contractId: string; scheduleCount: number };

/**
 * 계약을 발행한다.
 *
 * **`plannerId` 를 입력으로 받지 않는다**(S6-03 · FIX-53). 발행은 **업체**가 하는데,
 * 플래너를 본문으로 받으면 업체가 **고객이 고른 적 없는 플래너**를 계약 당사자로
 * 앉힐 수 있었다 — 그러면 그 플래너가 서명 당사자가 되고(F-C-15) `planner_settlements`
 * 행이 생겨 **고객이 수수료를 낸다.** 반대로 비워 보내면 고객이 고른 플래너가
 * 아무것도 못 받았다. 어느 쪽이든 "누구의 것인가" 가 판정에서 빠져 있었다
 * (FIX-45 와 같은 자리).
 *
 * 이제 **`planner_scopes` 가 정한다** — 그 표가 F-C-31 의 "카테고리별 부분 선택" 이고,
 * 이 자리가 그 선택의 **집행 지점**이다(D-17 — 상담만으로는 발생하지 않고 계약이
 * 성사돼야 한다).
 */
export async function issueContract(input: {
  bookingId: string;
  actorId: string;
  /** 견적에서 넘어온 계약이면 그 견적. 총액의 출처가 분쟁의 첫 질문이다. */
  quoteId?: string | null;
  now?: Date;
}): Promise<IssueResult | ContractFailure> {
  const admin = createAdminClient();
  const now = input.now ?? new Date();

  const { data: bookingRow } = await admin
    .from("bookings")
    .select(
      "id, couple_id, vendor_id, total_amount, status, accepted_at, declined_at",
    )
    .eq("id", input.bookingId)
    .maybeSingle();

  const booking = bookingRow as {
    id: string;
    couple_id: string;
    vendor_id: string;
    total_amount: number;
    status: string;
    accepted_at: string | null;
    declined_at: string | null;
  } | null;

  if (!booking)
    return failure(
      404,
      "CONTRACT_BOOKING_NOT_FOUND",
      "예약을 찾을 수 없습니다.",
    );

  // **승인이 발행의 선행이다**(S5-10 · D-36). 이 문을 걸지 않으면 `/vendor/bookings`
  // 의 승인 버튼이 **눌러도 다음이 달라지지 않는 장식**이 된다. 승인·거절 판정은
  // 순수 함수 하나가 하며 화면·API 가 같은 답을 낸다.
  const gate = canIssueContract({
    status: booking.status as Parameters<typeof canIssueContract>[0]["status"],
    acceptedAt: booking.accepted_at,
    declinedAt: booking.declined_at,
    // 살아 있는 계약 여부는 바로 아래에서 따로 본다(부분 유니크가 최종 경계다).
    hasLiveContract: false,
  });

  if (!gate.allowed && gate.reason !== null) {
    return failure(
      409,
      "CONTRACT_BOOKING_NOT_ACCEPTED",
      ISSUE_BLOCK_MESSAGE[gate.reason],
    );
  }

  // 예약당 유효 계약은 하나다(D-21). 부분 유니크가 최종 경계이지만, 여기서 먼저
  // 답해야 화면이 "왜 안 되는가" 를 말할 수 있다.
  const { data: existing } = await admin
    .from("contracts")
    .select("id, status")
    .eq("booking_id", input.bookingId)
    .neq("status", "cancelled")
    .maybeSingle();

  if (existing) {
    return failure(
      409,
      "CONTRACT_ALREADY_EXISTS",
      "이 예약에는 이미 유효한 계약이 있어요.",
    );
  }

  // ── 총액 ──────────────────────────────────────────────────────────────────
  let totalAmount = booking.total_amount;

  if (input.quoteId) {
    const { data: quoteRow } = await admin
      .from("quotes")
      .select("id, total_amount, status, valid_until")
      .eq("id", input.quoteId)
      .maybeSingle();

    const quote = quoteRow as {
      total_amount: number;
      status: string;
      valid_until: string | null;
    } | null;

    if (!quote)
      return failure(
        404,
        "CONTRACT_QUOTE_NOT_FOUND",
        "견적을 찾을 수 없습니다.",
      );

    const eligible = quoteEligibility({
      status: quote.status,
      validUntil: quote.valid_until,
      now,
      hasActiveContract: false,
    });

    if (!eligible.ok)
      return failure(
        422,
        `CONTRACT_QUOTE_${eligible.reason.toUpperCase()}`,
        eligible.detail,
      );

    totalAmount = contractTotalFromQuote({ totalAmount: quote.total_amount });
  }

  // ── 요율 스냅샷 (발행 시점 · D-16) ────────────────────────────────────────
  const { data: vendorRow } = await admin
    .from("vendors")
    .select("id, category")
    .eq("id", booking.vendor_id)
    .maybeSingle();

  const vendor = vendorRow as { category: string } | null;
  if (!vendor)
    return failure(
      404,
      "CONTRACT_VENDOR_NOT_FOUND",
      "업체를 찾을 수 없습니다.",
    );

  const commission = await resolveVendorCommission(admin as never, {
    vendorId: booking.vendor_id,
    category: vendor.category,
    at: now.toISOString(),
    salePrice: totalAmount,
  });

  // §3.8 — 조회 결과가 없으면 계약을 세우지 않는다. 요율 없이 확정된 계약은
  // 나중에 정산할 근거가 없다. 임의 기본값은 정산 분쟁의 씨앗이다(O-02).
  if (!commission.available) {
    return failure(
      422,
      "CONTRACT_RATE_UNRESOLVED",
      "적용 수수료율이 설정되지 않아 계약을 발행할 수 없어요. 운영자에게 문의해 주세요.",
    );
  }

  // **고객이 이 카테고리를 누구에게 맡겼는가.** 업체가 고르는 것이 아니다(F-C-31).
  // 고르지 않았으면 null 이고 2자 계약이며 플래너 수수료는 0이다(D-17).
  const plannerId = (await selectedPlannerByCategory(booking.couple_id)).get(vendor.category) ?? null;

  const plannerFeeRateBp = await resolvePlannerFeeRateBp({
    plannerId,
    category: vendor.category,
    at: now.toISOString(),
  });

  if (plannerFeeRateBp === null) {
    return failure(
      422,
      "CONTRACT_PLANNER_RATE_UNRESOLVED",
      "플래너 요율이 설정되지 않아 계약을 발행할 수 없어요.",
    );
  }

  // ── 템플릿 ────────────────────────────────────────────────────────────────
  const { data: templateRow } = await admin
    .from("contract_templates")
    .select("id, version, clauses_json")
    .eq("status", "active")
    .maybeSingle();

  const template = templateRow as {
    id: string;
    version: string;
    clauses_json: ClauseSlot[];
  } | null;

  if (!template) {
    return failure(
      422,
      "CONTRACT_TEMPLATE_MISSING",
      "발행할 계약서 판본이 없어요.",
    );
  }

  // ── 회차 ──────────────────────────────────────────────────────────────────
  const plans = resolveSplitPlans(await readSetting("payment.split_ratios_bp"));

  if (!plans.ok) {
    return failure(
      422,
      "CONTRACT_SPLIT_UNRESOLVED",
      `분할 회차 설정이 없습니다. ${plans.detail}`,
    );
  }

  const { data: coupleRow } = await admin
    .from("couples")
    .select("id, wedding_date")
    .eq("id", booking.couple_id)
    .maybeSingle();

  const eventDate =
    (coupleRow as { wedding_date: string | null } | null)?.wedding_date ?? null;
  const issuedAt = now.toISOString();
  const installments = splitAmount(totalAmount, plans.plans);

  // ── 정본 해시 (D-23) ──────────────────────────────────────────────────────
  const content: ContractContent = {
    templateVersion: template.version,
    clauses: template.clauses_json ?? [],
    totalAmount,
    appliedFeeRateBp: commission.feeRateBp,
    appliedPlannerFeeRateBp: plannerFeeRateBp,
    installments: installments.map((item) => ({
      seq: item.seq,
      amount: item.amount,
      ratioBp: item.ratioBp,
    })),
    parties: {
      coupleId: booking.couple_id,
      vendorId: booking.vendor_id,
      plannerId,
    },
  };

  const signingDeadlineDays = await readIntSetting(
    "contract.signing_deadline_days",
    "days",
  );

  const { data: created, error: createError } = await admin
    .from("contracts")
    .insert({
      booking_id: booking.id,
      template_id: template.id,
      template_version: template.version,
      clauses_json: template.clauses_json ?? [],
      quote_id: input.quoteId ?? null,
      planner_id: plannerId,
      content_hash: contentHash(content),
      total_amount: totalAmount,
      applied_fee_rate_bp: commission.feeRateBp,
      applied_planner_fee_rate_bp: plannerFeeRateBp,
      status: "issued",
      issued_at: issuedAt,
      // 기한 일수는 설정이 갖는다(§7.4). 값이 없으면 기한 없는 계약이며 만료로 막지 않는다.
      signing_deadline_at:
        signingDeadlineDays === null
          ? null
          : new Date(
              now.getTime() + signingDeadlineDays * 86_400_000,
            ).toISOString(),
    })
    .select("id")
    .maybeSingle();

  if (createError || !created) {
    return failure(
      500,
      "CONTRACT_CREATE_FAILED",
      "계약을 발행하지 못했습니다.",
    );
  }

  const contractId = (created as { id: string }).id;

  const { error: scheduleError } = await admin.from("payment_schedules").insert(
    installments.map((item) => ({
      contract_id: contractId,
      seq: item.seq,
      ratio_bp: item.ratioBp,
      amount: item.amount,
      due_anchor: item.anchor,
      due_offset_days: item.offsetDays,
      due_at: dueAtOf(
        {
          ratioBp: item.ratioBp,
          anchor: item.anchor,
          offsetDays: item.offsetDays,
        },
        { contractIssuedAt: issuedAt, eventDate },
      ),
      status: "scheduled",
    })),
  );

  if (scheduleError) {
    // 회차 없는 계약은 결제할 수 없다. 발행 자체를 되돌린다 — 반쪽 계약을 남기면
    // 고객이 서명할 대상이 "금액은 있는데 낼 방법이 없는" 문서가 된다.
    await admin.from("contracts").delete().eq("id", contractId);

    return failure(
      500,
      "CONTRACT_SCHEDULE_FAILED",
      "결제 회차를 만들지 못했습니다.",
    );
  }

  await recordEvent({
    entityType: "contract",
    entityId: contractId,
    eventType: "contract_issued",
    actor: { id: input.actorId },
    afterState: "issued",
    // 금액·요율·회차 수만 남긴다. 조항 본문·당사자 식별정보는 넣지 않는다(§7.3).
    memo: `total=${totalAmount} feeBp=${commission.feeRateBp} plannerBp=${plannerFeeRateBp} installments=${installments.length}`,
  });

  const { data: ownerRow } = await admin
    .from("couples")
    .select("owner_id")
    .eq("id", booking.couple_id)
    .maybeSingle();

  const ownerId = (ownerRow as { owner_id: string } | null)?.owner_id ?? null;

  if (ownerId) {
    await sendNotification({
      userId: ownerId,
      topic: "contract",
      channel: "in_app",
      templateKey: "contract.issued",
      // 참조만. 금액·조항은 담지 않는다(§7.3).
      params: { contractId },
      dedupeKey: `contract.issued:${contractId}`,
    });
  }

  return { contractId, scheduleCount: installments.length };
}

/**
 * 플래너 요율 스냅샷.
 *
 * **플래너를 쓰지 않는 계약은 0bp 다.** `null` 은 "아직 스냅샷하지 않았다" 라는
 * 뜻이므로 둘을 같은 값으로 적으면 "미선택" 과 "요율을 못 찾음" 이 구별되지 않는다
 * (0028 근거 4). 그래서 이 함수는 **미선택이면 0, 못 찾으면 null** 을 돌려준다.
 */
/**
 * 적용 플래너 요율.
 *
 * **해석은 `lib/planners/rates.ts` 하나가 든다**(S6-03). 예전에는 이 파일과
 * 장바구니가 각자 해석했고 **답이 달랐다** — 장바구니는 플래너 키 없이 풀어서
 * 플래너 전용 요율을 못 봤다(FIX-52).
 */
async function resolvePlannerFeeRateBp(input: {
  plannerId: string | null;
  category: string;
  at: string;
}): Promise<number | null> {
  // 고른 플래너가 없으면 2자 계약이고 플래너 수수료는 0이다(D-17).
  if (input.plannerId === null) return 0;

  return resolvePlannerRateBp({
    records: await loadPlannerRateRecords(),
    category: input.category,
    plannerId: input.plannerId,
    at: input.at,
  });
}

// =============================================================================
// 서명 — 전원 서명이면 확정까지 간다
// =============================================================================

export type SignResult = {
  contractId: string;
  signed: SignerRole[];
  pending: SignerRole[];
  activated: boolean;
};

export async function signContract(input: {
  contractId: string;
  role: SignerRole;
  actorId: string;
  /**
   * 화면이 보고 있던 정본 해시. **다른 내용에 서명하는 것을 한 층 더 막는다**(D-23).
   * DB 트리거가 최종 경계이지만, 여기서 먼저 걸러야 화면이 "새로 불러 주세요" 를
   * 말할 수 있다 — 트리거에 걸리면 사용자에게는 알 수 없는 오류로 보인다.
   */
  expectedContentHash?: string | null;
  ipHash?: string | null;
  now?: Date;
}): Promise<SignResult | ContractFailure> {
  const admin = createAdminClient();
  const now = input.now ?? new Date();

  const { data: contractRow } = await admin
    .from("contracts")
    .select(
      "id, booking_id, status, content_hash, planner_id, signing_deadline_at, total_amount, applied_fee_rate_bp, applied_planner_fee_rate_bp",
    )
    .eq("id", input.contractId)
    .maybeSingle();

  const contract = contractRow as {
    id: string;
    booking_id: string;
    status: string;
    content_hash: string | null;
    planner_id: string | null;
    signing_deadline_at: string | null;
    total_amount: number;
    applied_fee_rate_bp: number;
    applied_planner_fee_rate_bp: number;
  } | null;

  if (!contract)
    return failure(404, "CONTRACT_NOT_FOUND", "계약을 찾을 수 없습니다.");

  if (
    input.expectedContentHash &&
    input.expectedContentHash !== contract.content_hash
  ) {
    return failure(
      409,
      "CONTRACT_CONTENT_CHANGED",
      "계약 내용이 화면에 보이던 것과 달라요. 화면을 새로 불러 주세요.",
    );
  }

  const required = requiredSignerRoles({
    plannerParty: contract.planner_id !== null,
  });

  if (!required.includes(input.role)) {
    return failure(
      422,
      "CONTRACT_ROLE_NOT_PARTY",
      "이 계약의 당사자가 아닌 역할입니다.",
    );
  }

  const { data: signatureRows } = await admin
    .from("contract_signatures")
    .select("signer_role, signed_at")
    .eq("contract_id", contract.id);

  const signatures = (
    (signatureRows ?? []) as { signer_role: string; signed_at: string | null }[]
  ).map((row) => ({
    signerRole: row.signer_role as SignerRole,
    signedAt: row.signed_at,
  }));

  const before = signingProgress(signatures, required);
  const state = signingState({
    status: contract.status as "draft" | "issued" | "active" | "cancelled",
    deadlineAt: contract.signing_deadline_at,
    complete: before.complete,
    now,
  });

  if (!canSign(state)) {
    return failure(422, "CONTRACT_NOT_SIGNABLE", signStateMessage(state));
  }

  if (before.signed.includes(input.role)) {
    return failure(409, "CONTRACT_ALREADY_SIGNED", "이미 서명한 당사자예요.");
  }

  // ── 본인확인이 먼저다 (D-28) ──────────────────────────────────────────────
  const verified = await verifyIdentity({
    userId: input.actorId,
    contractId: contract.id,
  });

  if (!verified.ok) {
    return failure(422, "CONTRACT_VERIFICATION_FAILED", verified.reason);
  }

  const { error: signError } = await admin.from("contract_signatures").insert({
    contract_id: contract.id,
    signer_id: input.actorId,
    signer_role: input.role,
    signed_at: now.toISOString(),
    // **이 서명자가 본 내용의 해시.** 트리거가 계약 정본과의 일치를 강제한다(D-23).
    signed_content_hash: contract.content_hash,
    verification_method: verified.method,
    verification_ref: verified.ref,
    ip_hash: input.ipHash ?? null,
  });

  if (signError) {
    return failure(500, "CONTRACT_SIGN_FAILED", "서명을 기록하지 못했습니다.");
  }

  const after = signingProgress(
    [...signatures, { signerRole: input.role, signedAt: now.toISOString() }],
    required,
  );

  await recordEvent({
    entityType: "contract_signature",
    entityId: contract.id,
    eventType: "contract_signed",
    actor: { id: input.actorId, role: input.role },
    afterState: after.complete ? "complete" : "partial",
    memo: `role=${input.role} method=${verified.method} signed=${after.signed.length}/${required.length}`,
  });

  const activated = after.complete
    ? await activateContract({ contract, actorId: input.actorId, now })
    : false;

  return {
    contractId: contract.id,
    signed: after.signed,
    pending: after.pending,
    activated,
  };
}

function signStateMessage(state: string): string {
  if (state === "expired")
    return "서명 기한이 지났어요. 업체가 계약을 다시 발행해야 합니다.";
  if (state === "active") return "이미 확정된 계약이에요.";
  if (state === "cancelled") return "취소된 계약이에요.";

  return "아직 서명할 수 있는 상태가 아니에요.";
}

/**
 * 확정 — 전원 서명 뒤에만.
 *
 * **여기서 하는 일 셋.**
 *  1. 계약을 `active` 로 옮긴다. DB 트리거가 서명 수를 다시 센다(0029).
 *  2. **요율 스냅샷을 `bookings` 로 복사**하고 예약을 `confirmed` 로 옮긴다.
 *     0028 의 트리거가 두 요율 없이는 `confirmed` 로 넘어가지 못하게 막는다 —
 *     그래서 같은 UPDATE 에 함께 넣는다.
 *  3. **플래너 수수료 원장을 만든다**(D-17). `earned_at` 은 **계약 성사 시점**이며
 *     첫 회차 결제가 아니다 — 계약은 서명으로 성사되고 결제는 그 이행이다.
 *     결제 시점에 만들면 회차마다 원장이 여러 벌 생기고, 계약은 성사됐는데 결제가
 *     늦어지는 동안 플래너 수수료가 발생하지 않는다.
 */
async function activateContract(input: {
  contract: {
    id: string;
    booking_id: string;
    planner_id: string | null;
    total_amount: number;
    applied_fee_rate_bp: number;
    applied_planner_fee_rate_bp: number;
  };
  actorId: string;
  now: Date;
}): Promise<boolean> {
  const admin = createAdminClient();
  const activatedAt = input.now.toISOString();

  const { error: contractError } = await admin
    .from("contracts")
    .update({ status: "active", activated_at: activatedAt })
    .eq("id", input.contract.id);

  if (contractError) return false;

  await admin
    .from("bookings")
    .update({
      status: "confirmed",
      applied_fee_rate_bp: input.contract.applied_fee_rate_bp,
      applied_planner_fee_rate_bp: input.contract.applied_planner_fee_rate_bp,
    })
    .eq("id", input.contract.booking_id);

  if (input.contract.planner_id !== null) {
    const graceDays = resolveGraceDays(
      await readSetting("planner.payout_grace_days"),
    );

    // 유예 값이 없으면 원장을 만들지 않는다 — payable_at 을 지어내면 회수할 수 없는
    // 돈이 유예 없이 나갈 수 있다(0028 의 유예 트리거와 같은 취지).
    if (graceDays !== null) {
      const earning = plannerEarning({
        grossAmount: input.contract.total_amount,
        appliedPlannerFeeRateBp: input.contract.applied_planner_fee_rate_bp,
        earnedAt: activatedAt,
        graceDays,
      });

      if (earning) {
        await admin.from("planner_settlements").insert({
          planner_id: input.contract.planner_id,
          booking_id: input.contract.booking_id,
          gross_amount: earning.grossAmount,
          fee_rate_bp: earning.feeRateBp,
          fee_amount: earning.feeAmount,
          earned_at: earning.earnedAt,
          payable_at: payableAtOf(earning.earnedAt, graceDays),
          status: "earned",
        });
      }
    }
  }

  await recordEvent({
    entityType: "contract",
    entityId: input.contract.id,
    eventType: "contract_activated",
    actor: { id: input.actorId },
    beforeState: "issued",
    afterState: "active",
    memo: `total=${input.contract.total_amount}`,
  });

  const { data: bookingRow } = await admin
    .from("bookings")
    .select("couple_id")
    .eq("id", input.contract.booking_id)
    .maybeSingle();

  const coupleId =
    (bookingRow as { couple_id: string } | null)?.couple_id ?? null;

  if (coupleId) {
    const { data: coupleRow } = await admin
      .from("couples")
      .select("owner_id")
      .eq("id", coupleId)
      .maybeSingle();

    const ownerId =
      (coupleRow as { owner_id: string } | null)?.owner_id ?? null;

    if (ownerId) {
      await sendNotification({
        userId: ownerId,
        topic: "contract",
        channel: "in_app",
        templateKey: "contract.activated",
        params: { contractId: input.contract.id },
        dedupeKey: `contract.activated:${input.contract.id}`,
      });
    }
  }

  return true;
}

/** 화면이 기본 판본 여부를 물을 때 쓰는 상수. 문안 미확정 판본의 이름이다(§7.7). */
export const DEFAULT_TEMPLATE_VERSION = PLACEHOLDER_TEMPLATE_VERSION;

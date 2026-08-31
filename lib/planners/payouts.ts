import { readSetting } from "@/lib/app-settings";
import { recordEvent } from "@/lib/audit/record";
import {
  MAX_PAYOUT_ATTEMPTS,
  canRetryPayout,
  resolvePayoutAdapterName,
  type PayoutAdapter,
} from "@/lib/settlements/payout-adapter";
import { createNoopPayoutAdapter, createStubPayoutAdapter } from "@/lib/settlements/payout-stub";
import {
  PLANNER_PAYOUT_BLOCK_MESSAGE,
  dueForPayable,
  plannerPayoutEligibility,
  plannerPayoutIdempotencyKey,
  plannerPayoutState,
  summarizePlannerPayouts,
  type PlannerPayoutState,
  type PlannerPayoutSummary,
  type PlannerSettlementRow,
} from "@/lib/core/settlement/planner-payout";
import { resolveGraceDays, type PlannerSettlementStatus } from "@/lib/core/payment/payment";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * 플래너 정산·지급 (S6-05 · §3.4 · §4.5 · D-21 · D-28)
 *
 * **읽기는 세션, 쓰기는 서비스롤이다.** `planner_settlements_select`(본인)와
 * `planner_settlements_select_operator`(운영자)가 경계이고, 쓰기 정책은 **아예 없다** —
 * 0071 이 GRANT 를 걷었으므로 이 원장에 손대는 것은 서버 경로뿐이다(FIX-49).
 *
 * **임베드를 쓰지 않는다**(함정 1). `planner_settlements` 에서 `bookings`·`planners` 를
 * 한 번에 끌면 공개 조건이 붙은 표에서 행이 **조용히 빠져** 합계가 작아진다. 표마다
 * 따로 묻고 **못 본 것은 null 로 남긴다.**
 *
 * **어댑터는 업체 지급과 같은 것을 쓴다**(`lib/settlements/payout-adapter`). 방향도
 * 대행사도 실패 사유도 같아서, 나누면 같은 일이 두 벌이 된다.
 */

export type PlannerPayoutAttempt = {
  id: string;
  status: string;
  amount: number;
  attemptCount: number;
  failureReason: string | null;
  paidAt: string | null;
  failedAt: string | null;
  createdAt: string;
};

export type PlannerSettlementView = {
  id: string;
  plannerId: string;
  bookingId: string;
  grossAmount: number;
  /** 계약 확정 시점의 요율 스냅샷(D-16). 금액만으로는 "왜 이 금액인가" 를 못 푼다. */
  feeRateBp: number;
  feeAmount: number;
  earnedAt: string;
  payableAt: string;
  status: PlannerSettlementStatus;
  /** 저장된 상태가 아니라 **시계로 계산한** 국면이다. 배치가 늦어도 사실을 말한다. */
  state: PlannerPayoutState;
  /** 지급 시도. 실패 이유까지 남는다. */
  attempts: PlannerPayoutAttempt[];
};

export type PlannerPayoutPayload = {
  rows: PlannerSettlementView[];
  summary: PlannerPayoutSummary;
  /** 유예 기간(일). **미설정이면 null 이며 화면이 그 사실을 적는다**(§7.4). */
  graceDays: number | null;
  /** 지금 붙어 있는 지급 어댑터. 스텁이면 화면이 그 사실을 싣는다(D-28). */
  payoutAdapter: "stub" | "noop";
  /** 지급 대행 실연동이 아직 없다. **본문에도 싣는다**(함정 3). */
  payoutWired: false;
};

type SettlementRecord = {
  id: string;
  planner_id: string;
  booking_id: string;
  gross_amount: number;
  fee_rate_bp: number;
  fee_amount: number;
  earned_at: string;
  payable_at: string;
  status: PlannerSettlementStatus;
};

const COLUMNS =
  "id, planner_id, booking_id, gross_amount, fee_rate_bp, fee_amount, earned_at, payable_at, status";

function adapter(): PayoutAdapter {
  return resolvePayoutAdapterName() === "stub"
    ? createStubPayoutAdapter()
    : createNoopPayoutAdapter();
}

/**
 * 유예 기간(일).
 *
 * **계약 확정 경로와 같은 키를 같은 함수로 읽는다**(`lib/contract/actions.ts` 가 원장을
 * 만들 때 쓰는 것과 글자 그대로 같다). 두 곳이 다른 키·다른 해석을 쓰면 화면이 적는
 * 유예와 실제 `payable_at` 이 갈린다 — FIX-52 가 요율에서 실제로 그랬다.
 *
 * **없으면 null 이다.** `Number(null)` 이 0 이라 "미결" 이 "0일" 로 조용히 바뀌는 함정을
 * `resolveGraceDays` 가 이미 막고 있다(§7.4 — 값이 없으면 코드가 고르지 않는다).
 */
export async function readGraceDays(): Promise<number | null> {
  return resolveGraceDays(await readSetting("planner.payout_grace_days"));
}

function toRow(record: SettlementRecord): PlannerSettlementRow {
  return {
    id: record.id,
    status: record.status,
    feeAmount: record.fee_amount,
    earnedAt: record.earned_at,
    payableAt: record.payable_at,
  };
}

/** 지급 시도를 따로 읽는다(임베드 금지 · 함정 1). */
async function attemptsOf(
  client: Awaited<ReturnType<typeof createClient>>,
  settlementIds: readonly string[],
): Promise<Map<string, PlannerPayoutAttempt[]>> {
  const map = new Map<string, PlannerPayoutAttempt[]>();
  if (settlementIds.length === 0) return map;

  const { data } = await client
    .from("planner_payouts")
    .select(
      "id, planner_settlement_id, status, amount, attempt_count, failure_reason, paid_at, failed_at, created_at",
    )
    .in("planner_settlement_id", settlementIds)
    .order("created_at", { ascending: true });

  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const key = row.planner_settlement_id as string;
    const list = map.get(key) ?? [];

    list.push({
      id: row.id as string,
      status: row.status as string,
      amount: row.amount as number,
      attemptCount: row.attempt_count as number,
      failureReason: (row.failure_reason as string | null) ?? null,
      paidAt: (row.paid_at as string | null) ?? null,
      failedAt: (row.failed_at as string | null) ?? null,
      createdAt: row.created_at as string,
    });

    map.set(key, list);
  }

  return map;
}

async function buildPayload(
  records: SettlementRecord[],
  client: Awaited<ReturnType<typeof createClient>>,
  now: Date,
): Promise<PlannerPayoutPayload> {
  const attempts = await attemptsOf(
    client,
    records.map((record) => record.id),
  );

  const rows: PlannerSettlementView[] = records.map((record) => ({
    id: record.id,
    plannerId: record.planner_id,
    bookingId: record.booking_id,
    grossAmount: record.gross_amount,
    feeRateBp: record.fee_rate_bp,
    feeAmount: record.fee_amount,
    earnedAt: record.earned_at,
    payableAt: record.payable_at,
    status: record.status,
    state: plannerPayoutState({
      status: record.status,
      payableAt: record.payable_at,
      now,
    }),
    attempts: attempts.get(record.id) ?? [],
  }));

  return {
    rows,
    summary: summarizePlannerPayouts(records.map(toRow), now),
    graceDays: await readGraceDays(),
    payoutAdapter: resolvePayoutAdapterName(),
    payoutWired: false,
  };
}

// =============================================================================
// 읽기 — 본인과 운영자
// =============================================================================

/** 플래너 본인의 원장. RLS 가 `planners.user_id = auth.uid()` 로 가른다. */
export async function loadMyPlannerPayouts(input: {
  plannerId: string;
  now: Date;
}): Promise<PlannerPayoutPayload> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("planner_settlements")
    .select(COLUMNS)
    .eq("planner_id", input.plannerId)
    .order("earned_at", { ascending: false })
    .limit(200);

  if (error) throw new Error("PLANNER_PAYOUT_LOAD_FAILED");

  return buildPayload((data ?? []) as unknown as SettlementRecord[], supabase, input.now);
}

/**
 * 운영자가 보는 지급 큐.
 *
 * **세션 클라이언트로 읽는다** — 0071 이 `is_operator()` 정책을 만들었고 경계는 앱이
 * 아니라 RLS 여야 한다(§5.5 · `/admin/settlements` 가 세운 같은 규칙).
 */
export async function loadAdminPlannerPayouts(input: {
  now: Date;
}): Promise<PlannerPayoutPayload & { plannerNames: Record<string, string> }> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("planner_settlements")
    .select(COLUMNS)
    .order("payable_at", { ascending: true })
    .limit(200);

  if (error) throw new Error("PLANNER_PAYOUT_LOAD_FAILED");

  const records = (data ?? []) as unknown as SettlementRecord[];
  const payload = await buildPayload(records, supabase, input.now);

  // 이름만 서비스롤로 읽는다 — 공개가 내려간 플래너의 지급도 큐에 남아야 한다.
  const ids = [...new Set(records.map((record) => record.planner_id))];
  const plannerNames: Record<string, string> = {};

  if (ids.length > 0) {
    const { data: plannerRows } = await createAdminClient()
      .from("planners")
      .select("id, profile_json")
      .in("id", ids);

    for (const row of (plannerRows ?? []) as {
      id: string;
      profile_json: { headline?: string } | null;
    }[]) {
      const headline = row.profile_json?.headline;
      if (typeof headline === "string" && headline.length > 0) plannerNames[row.id] = headline;
    }
  }

  return { ...payload, plannerNames };
}

// =============================================================================
// 배치 — 유예가 지난 건을 지급 대상으로 옮긴다 (§4.5 planner-payout-due)
// =============================================================================

export type PayableRunResult = { scanned: number; moved: number };

/**
 * `earned → payable` 전환.
 *
 * **배치가 자체 규칙을 갖지 않는다** — 대상은 순수 함수(`dueForPayable`)가 고른다.
 * **일찍 옮기는 것은 DB 가 막는다**(0028 트리거) — 배치가 잘못 계산해도 최종 경계가 있다.
 * **배치가 늦어도 화면은 사실을 말한다** — 화면은 `payable_at` 과 시계로 판정한다.
 */
export async function runPlannerPayoutDue(now: Date): Promise<PayableRunResult> {
  const admin = createAdminClient();

  const { data } = await admin
    .from("planner_settlements")
    .select(COLUMNS)
    .eq("status", "earned")
    .limit(1000);

  const records = (data ?? []) as unknown as SettlementRecord[];
  const due = dueForPayable(records.map(toRow), now);

  let moved = 0;

  for (const item of due) {
    const { error } = await admin
      .from("planner_settlements")
      .update({ status: "payable" })
      .eq("id", item.id)
      .eq("status", "earned");

    if (error) continue;

    moved += 1;

    await recordEvent({
      entityType: "planner_settlement",
      entityId: item.id,
      eventType: "planner_settlement_payable",
      // **사람이 없다.** 배치가 옮긴 전이에 운영 계정을 빌려 넣으면 증적이
      // "운영자가 눌렀다" 고 거짓말을 한다 — `source: "system"` 이 실행자를 말한다.
      actor: { id: null, role: "system" },
      beforeState: "earned",
      afterState: "payable",
      source: "system",
      // **금액을 담지 않는다**(§7.3) — 행이 이미 갖고 있다.
      memo: "batch=planner-payout-due",
    });
  }

  return { scanned: records.length, moved };
}

// =============================================================================
// 지급 실행
// =============================================================================

export type PlannerPayoutFailure = { status: number; code: string; message: string };

export type PlannerPayOutcome =
  | { status: "paid"; payoutId: string }
  | { status: "failed"; payoutId: string; reason: string; retryable: boolean };

function failure(status: number, code: string, message: string): PlannerPayoutFailure {
  return { status, code, message };
}

export function isPlannerPayoutFailure(value: unknown): value is PlannerPayoutFailure {
  return typeof value === "object" && value !== null && "code" in value && "status" in value;
}

/**
 * 한 건을 지급한다.
 *
 * **순서가 중요하다** — 지급 기록이 먼저, 원장 상태가 나중이다. 0071 의 트리거가
 * **성공한 지급 행 없이 `paid` 로 가는 것**을 막으므로, 뒤집으면 트리거에 걸린다.
 * 그 순서가 곧 "나가지 않은 돈이 나갔다고 적히지 않는다" 는 보장이다.
 *
 * **`plannerId` 를 입력으로 받지 않는다** — 원장 행이 정한다. 받으면 남의 원장을 내
 * 계좌로 보내는 요청을 만들 수 있다(FIX-45·FIX-53 과 같은 자리).
 */
export async function payPlannerSettlement(input: {
  settlementId: string;
  actorId: string;
  actorRole: string | null;
  attempt?: number;
  now?: Date;
}): Promise<PlannerPayOutcome | PlannerPayoutFailure> {
  const admin = createAdminClient();
  const now = input.now ?? new Date();

  const { data } = await admin
    .from("planner_settlements")
    .select("id, planner_id, status, fee_amount, payable_at")
    .eq("id", input.settlementId)
    .maybeSingle();

  const row = data as {
    id: string;
    planner_id: string;
    status: PlannerSettlementStatus;
    fee_amount: number;
    payable_at: string;
  } | null;

  if (!row) {
    return failure(404, "PLANNER_SETTLEMENT_NOT_FOUND", "플래너 정산을 찾을 수 없습니다.");
  }

  const { data: payoutRows } = await admin
    .from("planner_payouts")
    .select("id, status")
    .eq("planner_settlement_id", row.id);

  const payouts = (payoutRows ?? []) as { id: string; status: string }[];

  const eligibility = plannerPayoutEligibility({
    state: plannerPayoutState({ status: row.status, payableAt: row.payable_at, now }),
    feeAmount: row.fee_amount,
    hasPending: payouts.some((item) => item.status === "pending"),
    failedCount: payouts.filter((item) => item.status === "failed").length,
    maxAttempts: MAX_PAYOUT_ATTEMPTS,
  });

  if (!eligibility.ok) {
    return failure(
      422,
      `PLANNER_PAYOUT_${eligibility.reason.toUpperCase()}`,
      PLANNER_PAYOUT_BLOCK_MESSAGE[eligibility.reason],
    );
  }

  const attempt = input.attempt ?? 1;
  const key = plannerPayoutIdempotencyKey({ plannerSettlementId: row.id, attempt });
  const providerName = adapter().name;

  // ── 1) 행을 먼저 만든다 — 유니크가 동시 실행을 막는 지점이다 ──────────────
  const { data: created, error: createError } = await admin
    .from("planner_payouts")
    .insert({
      planner_settlement_id: row.id,
      amount: row.fee_amount,
      status: "pending",
      idempotency_key: key,
      attempt_count: payouts.length + 1,
      provider: providerName,
    })
    .select("id")
    .maybeSingle();

  if (createError || !created) {
    if ((createError as { code?: string } | null)?.code === "23505") {
      return failure(409, "PLANNER_PAYOUT_IN_PROGRESS", "이 건의 지급이 이미 진행 중이에요.");
    }

    return failure(500, "PLANNER_PAYOUT_CREATE_FAILED", "지급을 시작하지 못했습니다.");
  }

  const payoutId = (created as { id: string }).id;

  // ── 2) 어댑터 — 업체 지급과 같은 것을 쓴다 ────────────────────────────────
  const result = await adapter().pay({
    ledgerId: row.id,
    payee: { type: "planner", plannerId: row.planner_id },
    amount: row.fee_amount,
    currency: "KRW",
    idempotencyKey: key,
  });

  if (!result.ok) {
    await admin
      .from("planner_payouts")
      .update({
        status: "failed",
        failed_at: now.toISOString(),
        failure_reason: result.failureReason,
      })
      .eq("id", payoutId);

    await recordEvent({
      entityType: "planner_payout",
      entityId: payoutId,
      eventType: "planner_payout_failed",
      actor: { id: input.actorId, role: input.actorRole },
      beforeState: "pending",
      afterState: "failed",
      // **실패 사유 문안을 담지 않는다**(§7.3) — 행이 갖고 있다. 재시도 가능 여부만.
      memo: `amount=${row.fee_amount} retryable=${result.retryable}`,
    });

    return {
      status: "failed",
      payoutId,
      reason: result.failureReason,
      retryable: result.retryable,
    };
  }

  // ── 3) 성공 — 지급 기록이 먼저, 원장 상태가 나중 ──────────────────────────
  await admin
    .from("planner_payouts")
    .update({ status: "paid", paid_at: result.paidAt, provider_ref: result.providerRef })
    .eq("id", payoutId);

  const { error: settleError } = await admin
    .from("planner_settlements")
    .update({ status: "paid", paid_at: result.paidAt })
    .eq("id", row.id);

  if (settleError) {
    // 돈은 나갔는데 원장이 안 옮겨졌다. **조용히 성공이라고 답하지 않는다.**
    return failure(
      500,
      "PLANNER_PAYOUT_LEDGER_FAILED",
      "지급은 실행됐지만 정산 상태를 옮기지 못했습니다. 운영자에게 알려 주세요.",
    );
  }

  await recordEvent({
    entityType: "planner_payout",
    entityId: payoutId,
    eventType: "planner_payout_paid",
    actor: { id: input.actorId, role: input.actorRole },
    beforeState: "pending",
    afterState: "paid",
    memo: `amount=${row.fee_amount} provider=${providerName}`,
  });

  return { status: "paid", payoutId };
}

export { MAX_PAYOUT_ATTEMPTS, canRetryPayout };

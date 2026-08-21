import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { recordEvent } from "@/lib/audit/record";
import {
  MEMBERSHIP_SETTING_KEYS,
  membershipPrice,
  membershipState,
  type MembershipPrice,
  type MembershipRow,
  type MembershipState,
} from "@/lib/core/membership/membership";
import { createAdminClient } from "@/lib/supabase/admin";

import { createMembershipAdapter } from "./stub";

/**
 * 멤버십 구독 (S7-11 · 명세서 §2.1 F-C-19 · §3.1 · D-28)
 *
 * ── 어떤 손으로 쓰는가 ──────────────────────────────────────────────────────
 * **읽기는 세션**이다 — `memberships` 는 `user_id = auth.uid()` 로 좁혀 있고(0005 [06])
 * 그 경계가 RLS 다. **쓰기는 서비스롤**이다: 상태 전이를 결제 결과가 정하고,
 * `subscription_payments` 는 애초에 쓰기 정책이 없다(0005 [07]).
 * **판정을 먼저 하고 그 뒤에 쓴다** — 사용자 id 는 세션에서만 온다.
 *
 * ── 등급을 저장하지 않는다 ──────────────────────────────────────────────────
 * 행이 갖는 것은 **무엇을 샀는가**이고 지금 유효한 등급은 계산한다
 * (`membershipState`). 만료를 배치가 옮겨 적기를 기다리면 그 사이 화면이 거짓말을 한다.
 *
 * ── 값이 없으면 팔지 않는다 ─────────────────────────────────────────────────
 * `membership.monthly_price` 가 비어 있으면 **어댑터를 부르지도 않는다**(O-17).
 * 0원으로 읽으면 "공짜로 준다" 가 되는데 그렇게 정한 적이 없다.
 */

export type MembershipFailure = { status: number; code: string; message: string };

type Row = {
  id: string;
  plan: string;
  status: string;
  started_at: string | null;
  expires_at: string | null;
  source: string | null;
};

function toRow(row: Row | null): MembershipRow | null {
  if (row === null) return null;

  return {
    plan: row.plan as MembershipRow["plan"],
    status: row.status as MembershipRow["status"],
    startedAt: row.started_at,
    expiresAt: row.expires_at,
  };
}

/**
 * 지금 이 사람의 등급.
 *
 * **세션으로 읽는다** — RLS 가 본인 것만 보여준다. 다른 사람의 등급을 물을 수 있는
 * 경로를 만들지 않는다.
 */
export async function loadMembership(
  client: SupabaseClient,
  input: { now?: Date } = {},
): Promise<{ state: MembershipState; row: MembershipRow | null; id: string | null }> {
  const { data } = await client
    .from("memberships")
    .select("id, plan, status, started_at, expires_at, source")
    .maybeSingle();

  const raw = (data ?? null) as Row | null;
  const row = toRow(raw);

  return {
    state: membershipState({ row, now: (input.now ?? new Date()).toISOString() }),
    row,
    id: raw?.id ?? null,
  };
}

/** 운영 파라미터 셋. **값이 아니라 키만** 코드가 갖는다(§7.4). */
async function loadSettings(): Promise<{ price: MembershipPrice; periodDays: number | null }> {
  const admin = createAdminClient();

  const { data } = await admin
    .from("app_settings")
    .select("key, value_json")
    .in("key", [
      MEMBERSHIP_SETTING_KEYS.monthlyPrice.key,
      MEMBERSHIP_SETTING_KEYS.currency.key,
      MEMBERSHIP_SETTING_KEYS.periodDays.key,
    ]);

  const rows = new Map(
    ((data ?? []) as { key: string; value_json: { value?: unknown } }[]).map((row) => [
      row.key,
      row.value_json?.value,
    ]),
  );

  const amount = Number(rows.get(MEMBERSHIP_SETTING_KEYS.monthlyPrice.key));
  const days = Number(rows.get(MEMBERSHIP_SETTING_KEYS.periodDays.key));

  return {
    price: membershipPrice({
      amount: Number.isFinite(amount) ? amount : null,
      currency: (rows.get(MEMBERSHIP_SETTING_KEYS.currency.key) as string | undefined) ?? null,
    }),
    periodDays: Number.isFinite(days) && days > 0 ? Math.trunc(days) : null,
  };
}

export async function loadMembershipPrice(): Promise<MembershipPrice> {
  return (await loadSettings()).price;
}

// =============================================================================
// 시작
// =============================================================================

export async function startMembership(
  client: SupabaseClient,
  input: { userId: string; now?: Date },
): Promise<{ expiresAt: string; adapter: string } | MembershipFailure> {
  const current = await loadMembership(client, { now: input.now });

  // **이미 쓰고 있으면 또 팔지 않는다.** 중복 결제는 되돌리기 어려운 사고다.
  if (current.state.plan === "premium") {
    return {
      status: 409,
      code: "MEMBERSHIP_ALREADY_ACTIVE",
      message: "이미 멤버십을 쓰고 있어요.",
    };
  }

  const { price, periodDays } = await loadSettings();

  // **값이 없으면 어댑터를 부르지도 않는다**(O-17).
  if (!price.ok) {
    return {
      status: 422,
      code: "MEMBERSHIP_PRICE_UNCONFIGURED",
      message: "멤버십 가격이 아직 정해지지 않아 가입할 수 없어요.",
    };
  }

  if (periodDays === null) {
    return {
      status: 422,
      code: "MEMBERSHIP_PERIOD_UNCONFIGURED",
      message: "구독 기간이 설정되지 않아 가입할 수 없어요.",
    };
  }

  const adapter = createMembershipAdapter();

  // 멱등 열쇠는 **서버가 만든다.** 클라이언트가 정하면 매 요청마다 새 열쇠가 되고,
  // 그러면 같은 사람이 두 번 결제된다(회차 결제와 같은 규칙 · S5-06).
  const idempotencyKey = `membership:${input.userId}:${randomUUID()}`;

  const result = await adapter.subscribe({
    userId: input.userId,
    amount: price.amount,
    currency: price.currency,
    idempotencyKey,
  });

  if (!result.ok) {
    return {
      status: 402,
      code: "MEMBERSHIP_PAYMENT_FAILED",
      message: result.failureReason,
    };
  }

  const startedAt = (input.now ?? new Date()).toISOString();
  const expiresAt = new Date(
    Date.parse(startedAt) + periodDays * 86_400_000,
  ).toISOString();

  const admin = createAdminClient();

  // 사용자당 하나다(0048 유니크). 있던 행이 만료됐으면 **같은 행을 되살린다** —
  // 새 행을 만들면 지난 구독 기록이 갈라진다.
  const { data: saved, error } = await admin
    .from("memberships")
    .upsert(
      {
        user_id: input.userId,
        plan: "premium",
        status: "active",
        started_at: startedAt,
        expires_at: expiresAt,
        source: adapter.name,
      },
      { onConflict: "user_id" },
    )
    .select("id")
    .maybeSingle();

  const membershipId = (saved as { id: string } | null)?.id ?? null;
  if (error || membershipId === null) {
    return { status: 500, code: "MEMBERSHIP_SAVE_FAILED", message: "구독을 저장하지 못했어요." };
  }

  await admin.from("subscription_payments").insert({
    membership_id: membershipId,
    amount: price.amount,
    billing_cycle: "monthly",
    status: "paid",
  });

  await recordEvent({
    entityType: "membership",
    entityId: membershipId,
    eventType: "membership_started",
    actor: { id: input.userId },
    afterState: "active",
    // **금액을 남기지 않는다**(§7.3) — `subscription_payments` 가 이미 갖고 있고
    // 옮겨 적으면 두 곳이 갈린다. 남길 사실은 **어느 어댑터로 열렸는가**다:
    // 스텁으로 열린 구독과 실결제로 열린 구독은 나중에 반드시 구분해야 한다.
    memo: `adapter:${adapter.name}`,
  });

  return { expiresAt, adapter: adapter.name };
}

// =============================================================================
// 해지
// =============================================================================

/**
 * 해지 예약.
 *
 * **지금 끊지 않는다.** 이미 낸 기간은 그의 것이므로 `status` 만 `canceled` 로 옮기고
 * 기한은 그대로 둔다 — 등급 판정은 기한이 한다(`membershipState`).
 */
export async function cancelMembership(
  client: SupabaseClient,
  input: { userId: string; now?: Date },
): Promise<{ canceled: boolean; expiresAt: string | null } | MembershipFailure> {
  const current = await loadMembership(client, { now: input.now });

  if (current.id === null || current.state.plan !== "premium") {
    return {
      status: 404,
      code: "MEMBERSHIP_NOT_ACTIVE",
      message: "해지할 멤버십이 없어요.",
    };
  }

  // **이미 해지 예약했으면 실패가 아니다** — 결과가 요청한 대로다(D-80).
  if (current.state.cancelPending) {
    return { canceled: false, expiresAt: current.state.expiresAt };
  }

  const admin = createAdminClient();

  await admin
    .from("memberships")
    .update({ status: "canceled" })
    .eq("id", current.id)
    // **소유자 필터를 넣는다.** 판정은 위에서 끝났지만 조건을 빼면 서비스롤 한 줄이
    // 표 전체를 건드릴 수 있는 모양이 된다.
    .eq("user_id", input.userId);

  await recordEvent({
    entityType: "membership",
    entityId: current.id,
    eventType: "membership_canceled",
    actor: { id: input.userId },
    afterState: "canceled",
    memo: null,
  });

  return { canceled: true, expiresAt: current.state.expiresAt };
}

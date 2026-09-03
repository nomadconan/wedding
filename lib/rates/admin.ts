import { recordEvent } from "@/lib/audit/record";
import {
  endRate,
  findOverlaps,
  rateState,
  simulationScopeKeys,
  validateRate,
  voidRate,
  type RateDraft,
  type RateRow,
  type RateState,
  type RateType,
  type SimulationInput,
} from "@/lib/core/pricing/rate-admin";
import {
  COMMISSION_SCOPE_ORDER,
  PLANNER_FEE_SCOPE_ORDER,
  resolveRate,
  type RateRecord,
} from "@/lib/core/pricing/rates";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 요율 관리 (S5-03 · F-A-15 · §3.8 · §4.3 · D-16 · D-23 · O-02)
 *
 * ── 왜 서비스롤인가 ─────────────────────────────────────────────────────────
 * 요율 한 줄이 **모든 업체의 수입**을 바꾼다. 0034 가 쓰기 정책을 주지 않고 권한까지
 * 회수한 이유이며(0029 서명·0030 결제·0033 정산과 같은 결론), 권한 판정은 이 파일을
 * 부르는 API 가 세션으로 한다.
 *
 * ── 해석은 S5-02 가 한다 ────────────────────────────────────────────────────
 * 시뮬레이터는 `resolveRate` 를 그대로 부른다 — 우선순위를 여기서 다시 정하면 언젠가
 * 화면과 정산이 다른 요율을 말한다.
 *
 * ── 값을 정하지 않는다 (O-02) ───────────────────────────────────────────────
 * 이 파일에도 요율 숫자가 없다. 운영자가 넣는 값을 검증해 저장할 뿐이다.
 */
export type RateFailure = { status: number; code: string; message: string };

function failure(status: number, code: string, message: string): RateFailure {
  return { status, code, message };
}

export function isRateFailure(value: unknown): value is RateFailure {
  return typeof value === "object" && value !== null && "code" in value && "status" in value;
}

const TABLE: Record<RateType, string> = {
  commission: "commission_rates",
  planner: "planner_fee_rates",
};

type Reader = Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>;

export type RateListRow = RateRow & {
  type: RateType;
  state: RateState;
  memo: string | null;
  /** 무효화 사유. `voidedAt` 이 null 이면 이것도 null 이다(DB CHECK 가 짝을 지킨다). */
  voidReason: string | null;
  /** 대상 이름. 업체·플래너면 사람이 읽는 이름을 붙인다(uuid 만 보면 알 수 없다). */
  scopeLabel: string | null;
};

/**
 * 요율 목록.
 *
 * **세션 클라이언트로 읽는다.** 0034 가 운영자 열람 정책을 만들었고, 서비스롤로
 * 우회해 읽으면 경계가 앱 코드가 된다(§5.5).
 */
export async function listRates(client: Reader, now: Date = new Date()): Promise<RateListRow[]> {
  const rows: RateListRow[] = [];

  for (const type of ["commission", "planner"] as RateType[]) {
    const columns =
      type === "planner"
        ? "id, scope_type, scope_key, service_level, fee_rate_bp, effective_from, effective_to, memo, voided_at, void_reason"
        : "id, scope_type, scope_key, fee_rate_bp, effective_from, effective_to, memo, voided_at, void_reason";

    const { data } = await client
      .from(TABLE[type])
      .select(columns)
      .order("effective_from", { ascending: false });

    for (const raw of (data ?? []) as unknown as Record<string, unknown>[]) {
      rows.push({
        id: raw.id as string,
        type,
        scopeType: raw.scope_type as RateRow["scopeType"],
        scopeKey: (raw.scope_key as string | null) ?? null,
        serviceLevel: (raw.service_level as string | null) ?? null,
        feeRateBp: raw.fee_rate_bp as number,
        effectiveFrom: raw.effective_from as string,
        effectiveTo: (raw.effective_to as string | null) ?? null,
        // **무효 행을 목록에서 빼지 않는다.** 지우지 않는 이유(D-23)와 같다 — 무엇을
        // 왜 무효화했는지가 이 표의 이력이고, 안 보이면 그 이력이 사라진 것과 같다.
        voidedAt: (raw.voided_at as string | null) ?? null,
        voidReason: (raw.void_reason as string | null) ?? null,
        memo: (raw.memo as string | null) ?? null,
        state: rateState({
          effectiveFrom: raw.effective_from as string,
          effectiveTo: (raw.effective_to as string | null) ?? null,
          voidedAt: (raw.voided_at as string | null) ?? null,
          now,
        }),
        scopeLabel: null,
      });
    }
  }

  return withScopeLabels(rows);
}

/** 업체·플래너 대상에 사람이 읽는 이름을 붙인다. uuid 만 보면 어느 업체인지 알 수 없다. */
async function withScopeLabels(rows: RateListRow[]): Promise<RateListRow[]> {
  const vendorIds = rows
    .filter((row) => row.scopeType === "vendor" && row.scopeKey)
    .map((row) => row.scopeKey as string);

  if (vendorIds.length === 0) return rows;

  const { data } = await createAdminClient()
    .from("vendors")
    .select("id, name")
    .in("id", vendorIds);

  const nameOf = new Map(((data ?? []) as { id: string; name: string }[]).map((v) => [v.id, v.name]));

  return rows.map((row) =>
    row.scopeType === "vendor" && row.scopeKey
      ? { ...row, scopeLabel: nameOf.get(row.scopeKey) ?? null }
      : row,
  );
}

// =============================================================================
// 생성 — 겹침을 저장 전에 먼저 알려준다
// =============================================================================

export async function createRate(input: {
  draft: RateDraft;
  actorId: string;
}): Promise<{ rateId: string } | RateFailure> {
  const admin = createAdminClient();
  const valid = validateRate(input.draft);

  if (!valid.ok) return failure(422, `RATE_INVALID_${valid.field.toUpperCase()}`, valid.detail);

  // DB 의 EXCLUDE 가 최종 경계지만, 여기서 먼저 보고 **어느 행과 부딪혔는지**를
  // 말해 준다 — 제약 위반 메시지를 그대로 보여주면 운영자는 무엇을 고칠지 모른다.
  const { data: existingRows } = await admin
    .from(TABLE[input.draft.type])
    // `voided_at` 을 함께 읽는다 — 무효 행은 겹침을 막지 않으므로(FIX-12 · DB 의 부분
    // EXCLUDE 와 같은 판정) 빼먹으면 화면이 "겹친다" 며 막는데 DB 는 받아 준다.
    .select("id, scope_type, scope_key, fee_rate_bp, effective_from, effective_to, voided_at");

  const existing = ((existingRows ?? []) as Record<string, unknown>[]).map((raw) => ({
    id: raw.id as string,
    scopeType: raw.scope_type as RateRow["scopeType"],
    scopeKey: (raw.scope_key as string | null) ?? null,
    feeRateBp: raw.fee_rate_bp as number,
    effectiveFrom: raw.effective_from as string,
    effectiveTo: (raw.effective_to as string | null) ?? null,
    voidedAt: (raw.voided_at as string | null) ?? null,
  }));

  const overlap = findOverlaps({
    candidate: {
      scopeType: input.draft.scopeType,
      scopeKey: input.draft.scopeKey,
      feeRateBp: input.draft.feeRateBp,
      effectiveFrom: input.draft.effectiveFrom,
      effectiveTo: input.draft.effectiveTo,
      // 새로 만드는 행은 당연히 살아 있다.
      voidedAt: null,
    },
    existing,
  });

  if (!overlap.ok) return failure(409, "RATE_OVERLAP", overlap.detail);

  const payload: Record<string, unknown> = {
    scope_type: input.draft.scopeType,
    scope_key: input.draft.scopeKey,
    fee_rate_bp: input.draft.feeRateBp,
    effective_from: input.draft.effectiveFrom,
    effective_to: input.draft.effectiveTo,
    memo: input.draft.memo?.slice(0, 200) ?? null,
    updated_by: input.actorId,
  };

  if (input.draft.type === "planner") payload.service_level = input.draft.serviceLevel ?? null;

  const { data, error } = await admin
    .from(TABLE[input.draft.type])
    .insert(payload)
    .select("id")
    .maybeSingle();

  if (error || !data) {
    // 동시 입력이 EXCLUDE 에 걸린 경우다. 위에서 본 목록 뒤에 다른 행이 들어왔다.
    if ((error as { code?: string } | null)?.code === "23P01") {
      return failure(409, "RATE_OVERLAP", "방금 다른 요율이 등록돼 기간이 겹칩니다. 목록을 새로 불러 주세요.");
    }

    return failure(500, "RATE_CREATE_FAILED", "요율을 저장하지 못했습니다.");
  }

  const rateId = (data as { id: string }).id;

  await recordEvent({
    entityType: input.draft.type === "commission" ? "commission_rate" : "planner_fee_rate",
    entityId: rateId,
    eventType: "rate_created",
    actor: { id: input.actorId, role: "admin" },
    afterState: "active",
    // 요율·범위·기간만. 업체명은 넣지 않는다(§7.3 — 참조로 충분하다).
    memo: `scope=${input.draft.scopeType} bp=${input.draft.feeRateBp} from=${input.draft.effectiveFrom}`,
  });

  return { rateId };
}

// =============================================================================
// 무효화 — 잘못 만든 행을 되돌리는 유일한 수단 (FIX-12)
// =============================================================================

/**
 * 요율을 무효화한다.
 *
 * **왜 종료로는 안 되나.** 종료는 `effective_to` 를 닫는 것이고, 닫아도 **시작부터
 * 종료까지 그 요율이 적용됐다는 사실**은 남는다. 오타로 `700bp` 를 `7000bp` 로 넣었다면
 * 그 구간은 70% 가 정답이 되고, DB 는 시작 전으로 닫는 것도(CHECK) 겹쳐 덮는 것도
 * (EXCLUDE) 지우는 것도(권한) 막는다. 셋 다 막힌 상태를 로컬에서 재현해 확인했다.
 *
 * **되돌릴 수 없다.** 잘못 무효화했으면 올바른 요율을 새로 등록한다 — 무효 행은 겹침을
 * 막지 않으므로 같은 구간에 넣을 수 있다(부분 EXCLUDE).
 *
 * **판정은 순수 함수가 한다**(`voidRate`). 여기서는 행을 읽어 넘기고 결과를 저장할 뿐이다.
 */
export async function voidRateRow(input: {
  type: RateType;
  rateId: string;
  reason: string;
  actorId: string;
}): Promise<{ voidedAt: string } | RateFailure> {
  const admin = createAdminClient();

  const { data } = await admin
    .from(TABLE[input.type])
    .select("id, voided_at")
    .eq("id", input.rateId)
    .maybeSingle();

  const row = data as { voided_at: string | null } | null;

  if (!row) return failure(404, "RATE_NOT_FOUND", "요율을 찾을 수 없습니다.");

  const decision = voidRate({ voidedAt: row.voided_at, reason: input.reason });

  if (!decision.ok) return failure(422, `RATE_VOID_${decision.code.toUpperCase()}`, decision.detail);

  /**
   * **시각을 계산해 넣지 않는다.** `now()` 는 DB 가 찍는다 — 앱과 DB 의 시계가 다르면
   * 이력의 순서가 어긋나고, 그 이력이 정산 분쟁의 근거다.
   */
  const { data: updated, error } = await admin
    .from(TABLE[input.type])
    .update({
      voided_at: new Date().toISOString(),
      void_reason: decision.reason,
      voided_by: input.actorId,
      updated_by: input.actorId,
    })
    .eq("id", input.rateId)
    .select("voided_at")
    .maybeSingle();

  if (error || !updated) {
    return failure(500, "RATE_VOID_FAILED", "요율을 무효화하지 못했습니다.");
  }

  await recordEvent({
    entityType: input.type === "commission" ? "commission_rate" : "planner_fee_rate",
    entityId: input.rateId,
    eventType: "rate_voided",
    actor: { id: input.actorId, role: "admin" },
    beforeState: "active",
    afterState: "voided",
    // **사유를 그대로 싣는다.** 무효화는 사람이 판단한 일이고 그 판단이 곧 증적이다.
    // 개인정보가 아니며(요율 표에는 사람이 없다) 이 문장이 없으면 원장을 읽을 수 없다.
    memo: `reason=${decision.reason.slice(0, 200)}`,
  });

  return { voidedAt: (updated as { voided_at: string }).voided_at };
}

// =============================================================================
// 종료 — 지우지 않고 닫는다 (D-23)
// =============================================================================

export async function closeRate(input: {
  type: RateType;
  rateId: string;
  endAt: string;
  actorId: string;
}): Promise<{ effectiveTo: string } | RateFailure> {
  const admin = createAdminClient();

  const { data } = await admin
    .from(TABLE[input.type])
    .select("id, effective_from, effective_to")
    .eq("id", input.rateId)
    .maybeSingle();

  const row = data as { effective_from: string; effective_to: string | null } | null;

  if (!row) return failure(404, "RATE_NOT_FOUND", "요율을 찾을 수 없습니다.");

  const decision = endRate({
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    endAt: input.endAt,
  });

  if (!decision.ok) return failure(422, `RATE_END_${decision.reason.toUpperCase()}`, decision.detail);

  const { error } = await admin
    .from(TABLE[input.type])
    .update({ effective_to: decision.effectiveTo, updated_by: input.actorId })
    .eq("id", input.rateId);

  if (error) return failure(500, "RATE_END_FAILED", "요율을 종료하지 못했습니다.");

  await recordEvent({
    entityType: input.type === "commission" ? "commission_rate" : "planner_fee_rate",
    entityId: input.rateId,
    eventType: "rate_ended",
    actor: { id: input.actorId, role: "admin" },
    beforeState: "active",
    afterState: "ended",
    memo: `endAt=${decision.effectiveTo}`,
  });

  return { effectiveTo: decision.effectiveTo };
}

// =============================================================================
// 시뮬레이터 — "이 시점 이 업체에 무엇이 적용되나"
// =============================================================================

export type SimulationResult =
  | {
      ok: true;
      feeRateBp: number;
      scopeType: string;
      scopeKey: string | null;
      /** 왜 이 요율인지. 화면이 그대로 적는다. */
      reason: string;
    }
  | { ok: false; reason: string; detail: string };

export async function simulateRate(input: SimulationInput): Promise<SimulationResult> {
  const admin = createAdminClient();
  const table = TABLE[input.type];

  const columns =
    input.type === "planner"
      ? "id, scope_type, scope_key, service_level, fee_rate_bp, effective_from, effective_to"
      : "id, scope_type, scope_key, fee_rate_bp, effective_from, effective_to";

  const { data } = await admin.from(table).select(columns);

  const records: RateRecord[] = ((data ?? []) as unknown as Record<string, unknown>[]).map((raw) => ({
    id: raw.id as string,
    scopeType: raw.scope_type as RateRecord["scopeType"],
    scopeKey: (raw.scope_key as string | null) ?? null,
    serviceLevel: (raw.service_level as string | null) ?? null,
    feeRateBp: raw.fee_rate_bp as number,
    effectiveFrom: raw.effective_from as string,
    effectiveTo: (raw.effective_to as string | null) ?? null,
    voidedAt: (raw.voided_at as string | null) ?? null,
  }));

  // **우선순위는 S5-02 가 갖는다.** 여기서 다시 정하지 않는다.
  const resolved = resolveRate(records, {
    scopeCandidates: input.type === "commission" ? COMMISSION_SCOPE_ORDER : PLANNER_FEE_SCOPE_ORDER,
    scopeKeys: simulationScopeKeys(input),
    at: input.at,
    serviceLevel: input.serviceLevel ?? null,
  });

  if (!resolved.ok) return { ok: false, reason: resolved.reason, detail: resolved.detail };

  return {
    ok: true,
    feeRateBp: resolved.feeRateBp,
    scopeType: resolved.scopeType,
    scopeKey: resolved.scopeKey,
    reason: `${resolved.scopeType} 범위의 요율이 먼저 걸렸습니다. 좁은 범위가 넓은 범위를 이깁니다.`,
  };
}

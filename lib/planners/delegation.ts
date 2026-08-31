import { recordEvent } from "@/lib/audit/record";
import {
  DELEGATABLE_SCOPES,
  DELEGATION_MESSAGE,
  type DelegationErrorCode,
  type EngagementPhase,
  engagementPhase,
  isDelegatableScope,
  scopeLabel,
  transitionAllowed,
  validateDelegation,
} from "@/lib/core/planner/delegation";
import type { DelegationOfferInput } from "@/lib/core/schemas/planner";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * 플래너 권한 위임 (S6-04 · F-C-18 · §3.7 · §6.2)
 *
 * **읽기는 세션, 쓰기는 서비스롤이다**(D-62 · 이 리포의 공통 방식).
 * `planner_engagements_select` 가 "커플 구성원 또는 그 플래너 본인" 으로 가르므로
 * 목록에서 다시 거르지 않는다 — 읽혔다면 볼 자격이 있는 것이다(§5.5).
 *
 * **임베드를 쓰지 않는다**(함정 1). `planner_engagements` 에서 `planners` 를 한 번에
 * 끌면, 수락 전(pending) 이거나 공개가 내려간 플래너의 행이 **조용히 빠져** 위임이
 * 사라진 것처럼 보인다. 표마다 따로 묻고 **못 본 것은 `null` 로 남긴다.**
 *
 * ── 플래너 쪽은 무엇을 보는가 ───────────────────────────────────────────────
 * **수락 전에는 고객이 누구인지도 열리지 않는다.** `couples` 는 `has_planner_scope`
 * 가 여는 표이고 그 함수는 `active` 만 인정한다(0005). 그러니 받은 제안 화면에는
 * **거래 조건**(범위·기간·제안 시각)만 실린다. 이름을 보여 주려면 위임 제안 자체가
 * 개인정보 열람 경로가 되어야 하는데, 그것은 "수락해야 열린다" 는 규칙과 정면으로
 * 어긋난다. 화면이 그 사실을 적는다.
 */

export type DelegationScopeView = { key: string; label: string };

export type DelegationRow = {
  id: string;
  plannerId: string;
  /** 플래너 이름. **못 읽으면 null 이며 화면이 그 사실을 적는다**(0으로 접지 않는다). */
  plannerHeadline: string | null;
  status: string;
  phase: EngagementPhase;
  scopes: DelegationScopeView[];
  /** 어휘에 없는 키가 저장돼 있으면 여기 모인다. 화면이 "열리지 않는다" 고 적는다. */
  unknownScopes: string[];
  validFrom: string | null;
  validTo: string | null;
  respondedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

const COLUMNS =
  "id, planner_id, couple_id, scope_json, status, valid_from, valid_to, responded_at, revoked_at, created_at";

type EngagementRecord = {
  id: string;
  planner_id: string;
  couple_id: string;
  scope_json: { tables?: unknown } | null;
  status: string;
  valid_from: string | null;
  valid_to: string | null;
  responded_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

function scopeKeysOf(record: EngagementRecord): string[] {
  const tables = record.scope_json?.tables;

  return Array.isArray(tables) ? tables.filter((key): key is string => typeof key === "string") : [];
}

function toRow(record: EngagementRecord, headline: string | null, now: Date): DelegationRow {
  const keys = scopeKeysOf(record);

  return {
    id: record.id,
    plannerId: record.planner_id,
    plannerHeadline: headline,
    status: record.status,
    phase: engagementPhase(
      { status: record.status, validFrom: record.valid_from, validTo: record.valid_to },
      now,
    ),
    scopes: keys
      .filter((key) => isDelegatableScope(key))
      .map((key) => ({ key, label: scopeLabel(key) })),
    // 어휘 밖의 키는 **버리지 않고 따로 보인다** — 저장돼 있는데 아무것도 열지
    // 않는다는 사실은 고객이 알아야 한다.
    unknownScopes: keys.filter((key) => !isDelegatableScope(key)),
    validFrom: record.valid_from,
    validTo: record.valid_to,
    respondedAt: record.responded_at,
    revokedAt: record.revoked_at,
    createdAt: record.created_at,
  };
}

/** 플래너 이름을 따로 읽는다(임베드 금지 · 함정 1). 못 읽은 id 는 목록에서 빠진다. */
async function headlinesOf(client: Awaited<ReturnType<typeof createClient>>, ids: string[]) {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;

  const { data } = await client.from("planners").select("id, profile_json").in("id", ids);

  for (const row of (data ?? []) as { id: string; profile_json: { headline?: string } | null }[]) {
    const headline = row.profile_json?.headline;
    if (typeof headline === "string" && headline.length > 0) map.set(row.id, headline);
  }

  return map;
}

// =============================================================================
// 커플 쪽 — 내가 위임한 목록
// =============================================================================

export type CoupleDelegationPayload = {
  rows: DelegationRow[];
  /** 지금 실제로 열려 있는 범위 키. 여러 위임의 합집합이다. */
  openScopes: DelegationScopeView[];
  /**
   * 카테고리 선택(과금)과 **연동하지 않는다**(D-43).
   *
   * 해제해도 `planner_scopes` 는 그대로다. 화면과 API 본문이 그 사실을 함께 싣는다 —
   * 화면에서만 적으면 이 API 를 쓰는 다음 사람은 연동된다고 읽는다(함정 3).
   */
  categoryAxisLinked: false;
};

export async function loadCoupleDelegations(input: {
  coupleId: string;
  now: Date;
}): Promise<CoupleDelegationPayload> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("planner_engagements")
    .select(COLUMNS)
    .eq("couple_id", input.coupleId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw new Error("DELEGATION_LOAD_FAILED");

  const records = (data ?? []) as unknown as EngagementRecord[];
  const headlines = await headlinesOf(supabase, records.map((record) => record.planner_id));

  const rows = records.map((record) =>
    toRow(record, headlines.get(record.planner_id) ?? null, input.now),
  );

  const open = new Set<string>();
  for (const row of rows) {
    if (row.phase !== "effective") continue;
    for (const scope of row.scopes) open.add(scope.key);
  }

  return {
    rows,
    openScopes: DELEGATABLE_SCOPES.filter((scope) => open.has(scope.key)).map((scope) => ({
      key: scope.key,
      label: scope.label,
    })),
    categoryAxisLinked: false,
  };
}

// =============================================================================
// 플래너 쪽 — 받은 제안
// =============================================================================

export type PlannerInboxRow = {
  id: string;
  phase: EngagementPhase;
  scopes: DelegationScopeView[];
  validFrom: string | null;
  validTo: string | null;
  createdAt: string;
  respondedAt: string | null;
};

export type PlannerInboxPayload = {
  rows: PlannerInboxRow[];
  /**
   * **고객 정보는 수락 전에 열리지 않는다.**
   *
   * 이 값이 언제나 false 인 것이 이 화면의 규칙이다 — 이름·예식일은 `couples` 에
   * 있고 그 표는 활성 위임에만 열린다(0005 `has_planner_scope`). 응답에 실어
   * 두어 API 를 쓰는 쪽도 같은 전제를 읽게 한다(함정 3).
   */
  customerIdentityVisible: false;
};

export async function loadPlannerInbox(input: {
  plannerId: string;
  now: Date;
}): Promise<PlannerInboxPayload> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("planner_engagements")
    .select(COLUMNS)
    .eq("planner_id", input.plannerId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw new Error("DELEGATION_INBOX_FAILED");

  const records = (data ?? []) as unknown as EngagementRecord[];

  return {
    rows: records.map((record) => {
      const row = toRow(record, null, input.now);

      return {
        id: row.id,
        phase: row.phase,
        scopes: row.scopes,
        validFrom: row.validFrom,
        validTo: row.validTo,
        createdAt: row.createdAt,
        respondedAt: row.respondedAt,
      };
    }),
    customerIdentityVisible: false,
  };
}

/** 로그인한 사용자의 플래너 행 id. 플래너가 아니면 null. */
export async function plannerIdOf(userId: string): Promise<string | null> {
  const admin = createAdminClient();

  const { data } = await admin
    .from("planners")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();

  return (data as { id: string } | null)?.id ?? null;
}

// =============================================================================
// 쓰기 — 제안 · 응답 · 회수
// =============================================================================

export type DelegationWriteResult =
  | { ok: true; engagementId: string }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      errors?: DelegationErrorCode[];
    };

function invalid(errors: DelegationErrorCode[]): DelegationWriteResult {
  return {
    ok: false,
    status: 422,
    code: "DELEGATION_FORM_INVALID",
    message: "위임을 만들 수 없습니다.",
    errors,
  };
}

/**
 * 위임을 제안한다.
 *
 * **`coupleId` 를 입력으로 받지 않는다** — 세션이 정한다. 받으면 남의 커플 데이터를
 * 여는 요청을 만들 수 있고, 그 열람의 대가(수수료)는 그 커플이 낸다(FIX-45 와 같은
 * 자리: "누구의 것인가" 가 판정에서 빠지면 비용도 권한도 엉뚱한 쪽으로 간다).
 *
 * **소유자만 제안한다.** `planner_engagements_insert` 가 `is_couple_owner` 다 —
 * 카테고리 선택(구성 선택)과 달리 이것은 **우리 데이터를 밖으로 여는 일**이라
 * 결제·서명과 같은 층에 둔다(§3.9). 서버가 먼저 답해야 화면이 이유를 적을 수 있다.
 */
export async function offerDelegation(input: {
  coupleId: string;
  coupleRole: string;
  plannerId: string;
  form: DelegationOfferInput;
  actorId: string;
  actorRole: string | null;
  now: Date;
}): Promise<DelegationWriteResult> {
  if (input.coupleRole !== "owner") {
    return {
      ok: false,
      status: 403,
      code: "DELEGATION_NOT_OWNER",
      message: "위임은 대표 계정만 제안할 수 있어요.",
    };
  }

  const validation = validateDelegation(
    { scopes: input.form.scopes, validFrom: input.form.validFrom, validTo: input.form.validTo },
    input.now,
  );

  if (!validation.ok) return invalid(validation.errors);

  const admin = createAdminClient();

  // **공개 중인 플래너에게만 위임한다.** 트리거가 최종 경계지만 여기서 먼저 답해야
  // 화면이 "왜 막혔는지" 를 말할 수 있다 — 트리거 메시지만 올려보내면 어느 조건이
  // 문제인지 아무도 모른다.
  const { data: plannerRow } = await admin
    .from("planners")
    .select("id, status")
    .eq("id", input.plannerId)
    .maybeSingle();

  const planner = plannerRow as { id: string; status: string } | null;

  if (!planner) {
    return {
      ok: false,
      status: 404,
      code: "PLANNER_NOT_FOUND",
      message: "플래너를 찾을 수 없어요.",
    };
  }

  if (planner.status !== "active") {
    return {
      ok: false,
      status: 422,
      code: "PLANNER_NOT_LISTED",
      message: "공개 중인 플래너에게만 위임할 수 있어요.",
    };
  }

  // 살아 있는 위임은 커플·플래너당 하나다(0069 부분 유니크). 먼저 답해서 화면이
  // "이미 제안돼 있다" 를 말하게 한다 — 유니크 위반 메시지는 사용자의 말이 아니다.
  const { data: liveRow } = await admin
    .from("planner_engagements")
    .select("id, status")
    .eq("couple_id", input.coupleId)
    .eq("planner_id", input.plannerId)
    .in("status", ["pending", "active"])
    .maybeSingle();

  if (liveRow) {
    return {
      ok: false,
      status: 409,
      code: "DELEGATION_ALREADY_LIVE",
      message: "이 플래너에게는 이미 살아 있는 위임이 있어요. 거둔 뒤 새로 제안해 주세요.",
    };
  }

  const { data, error } = await admin
    .from("planner_engagements")
    .insert({
      couple_id: input.coupleId,
      planner_id: input.plannerId,
      scope_json: { tables: input.form.scopes },
      valid_from: input.form.validFrom,
      valid_to: input.form.validTo,
      // **status 를 적지 않는다.** 기본값 pending 이며 수락은 플래너의 몫이다(D-165).
    })
    .select("id")
    .maybeSingle();

  if (error || !data) {
    return {
      ok: false,
      status: 500,
      code: "DELEGATION_CREATE_FAILED",
      message: "위임을 저장하지 못했습니다.",
    };
  }

  const engagementId = (data as { id: string }).id;

  await recordEvent({
    entityType: "planner_engagement",
    entityId: engagementId,
    eventType: "planner_engagement_offered",
    actor: { id: input.actorId, role: input.actorRole },
    beforeState: null,
    afterState: "pending",
    // **무엇을 열었는지 적지 않는다**(§7.3) — 행이 이미 갖고 있다. 개수면 재현에 충분하다.
    memo: `scopes=${input.form.scopes.length}`,
  });

  return { ok: true, engagementId };
}

/**
 * 수락 · 거절 · 회수.
 *
 * **행위자별로 허용 전이가 다르다**(순수 함수 `transitionAllowed` 가 표를 갖고 DB
 * 트리거가 같은 표를 든다). 여기서 먼저 판정하는 이유는 화면이 이유를 말할 수 있어야
 * 하기 때문이며, **최종 경계는 트리거와 정책이다.**
 */
export async function respondToDelegation(input: {
  engagementId: string;
  action: "accept" | "decline" | "revoke";
  actorId: string;
  actorRole: string | null;
  /** 커플 구성원이면 그 커플 id 와 역할. */
  couple: { coupleId: string; role: string } | null;
  /** 플래너면 그 플래너 행 id. */
  plannerId: string | null;
}): Promise<DelegationWriteResult> {
  const admin = createAdminClient();

  const { data } = await admin
    .from("planner_engagements")
    .select("id, couple_id, planner_id, status")
    .eq("id", input.engagementId)
    .maybeSingle();

  const engagement = data as {
    id: string;
    couple_id: string;
    planner_id: string;
    status: string;
  } | null;

  if (!engagement) {
    return { ok: false, status: 404, code: "DELEGATION_NOT_FOUND", message: "위임을 찾을 수 없어요." };
  }

  const isCoupleOwner =
    input.couple !== null &&
    input.couple.coupleId === engagement.couple_id &&
    input.couple.role === "owner";
  const isThisPlanner = input.plannerId !== null && input.plannerId === engagement.planner_id;

  const actor = input.action === "revoke" ? "couple" : "planner";
  const target = input.action === "accept" ? "active" : input.action === "decline" ? "declined" : "revoked";

  // **자격이 없으면 있는지조차 답하지 않는다** — 남의 위임 id 를 넣어 상태를 떠보는
  // 길을 만들지 않는다.
  if ((actor === "couple" && !isCoupleOwner) || (actor === "planner" && !isThisPlanner)) {
    return { ok: false, status: 404, code: "DELEGATION_NOT_FOUND", message: "위임을 찾을 수 없어요." };
  }

  if (!transitionAllowed(engagement.status, target, actor)) {
    return {
      ok: false,
      status: 422,
      code: "DELEGATION_TRANSITION_REJECTED",
      message:
        engagement.status === "pending"
          ? "이미 처리된 위임이에요."
          : "지금 상태에서는 할 수 없는 조치예요. 다시 맡기려면 새로 위임해 주세요.",
    };
  }

  const patch: Record<string, unknown> = { status: target };
  // 시각은 트리거가 적는다. **행위자만** 넘긴다 — 서비스롤 세션에는 auth.uid() 가
  // 없어 트리거가 "누가 거뒀는가" 를 알 수 없기 때문이다(로그인 세션이 직접 두드린
  // 경우에는 트리거가 auth.uid() 를 우선한다 — 위조할 수 없다).
  if (target === "revoked") patch.revoked_by = input.actorId;

  const { error } = await admin
    .from("planner_engagements")
    .update(patch)
    .eq("id", input.engagementId);

  if (error) {
    return {
      ok: false,
      status: 500,
      code: "DELEGATION_UPDATE_FAILED",
      message: "위임 상태를 바꾸지 못했습니다.",
    };
  }

  await recordEvent({
    entityType: "planner_engagement",
    entityId: input.engagementId,
    eventType: `planner_engagement_${target}`,
    actor: { id: input.actorId, role: input.actorRole },
    beforeState: engagement.status,
    afterState: target,
    memo: `actor=${actor}`,
  });

  return { ok: true, engagementId: input.engagementId };
}

/** 화면·API 가 같은 문장을 쓴다. */
export function delegationMessages(errors: readonly DelegationErrorCode[]) {
  return errors.map((code) => ({ code, message: DELEGATION_MESSAGE[code] }));
}

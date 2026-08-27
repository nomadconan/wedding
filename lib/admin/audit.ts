import {
  AUDIT_PAGE_SIZE,
  type AuditLogRow,
  type AuditQuery,
  type EntityEventRow,
  type TimelineEntry,
  buildTimeline,
} from "@/lib/core/audit/audit";
import { createClient } from "@/lib/supabase/server";

/**
 * 감사 로그 로더 (S8-02 · F-A-09)
 *
 * **세션 클라이언트로 읽는다.** 0053 이 `audit_logs` 에 `is_operator()` SELECT 정책을
 * 주었고 `entity_events` 는 이미 같은 정책을 갖고 있다(`entity_events_select_operator`).
 * 여기서 서비스롤을 쓰면 **경계가 앱 코드로 옮겨 온다** — 그러면 이 파일의 실수 하나가
 * 곧 전 사용자의 감사 로그 유출이다. 경계는 RLS 다(CLAUDE.md §5.5).
 *
 * S8-01 의 지표가 SECURITY DEFINER 였던 것과 다른 이유: 그쪽은 **합계**라 행을 열 필요가
 * 없었고 여기는 **행을 읽는 것이 목적**이다. 목적이 행이면 정책이 맞는 도구다.
 */
export type ActorLabel = { displayName: string | null; role: string | null };

export type AuditPayload = {
  entries: TimelineEntry[];
  /** 행위자 id → 이름. 못 찾은 id 는 키가 없다(화면이 id 앞자리로 대신한다). */
  actors: Record<string, ActorLabel>;
  /** 필터 드롭다운에 채울 값들. 실제로 쌓인 것만 낸다. */
  facets: { actions: string[]; actorRoles: string[]; targetTypes: string[] };
  /** 더 있는가. 커서는 마지막 항목의 `at` 이다. */
  hasMore: boolean;
  nextBefore: string | null;
};

type Client = Awaited<ReturnType<typeof createClient>>;

function applyFilters<T>(builder: T, query: AuditQuery, columns: {
  createdAt: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
}): T {
  // supabase-js 의 빌더는 체이닝이라 타입을 좁히기 어렵다. 여기서만 느슨하게 다룬다.
  let q = builder as unknown as {
    eq: (column: string, value: unknown) => typeof q;
    gte: (column: string, value: unknown) => typeof q;
    lt: (column: string, value: unknown) => typeof q;
  };

  if (query.actorRole) q = q.eq(columns.actorRole, query.actorRole);
  if (query.action) q = q.eq(columns.action, query.action);
  if (query.targetType) q = q.eq(columns.targetType, query.targetType);
  if (query.targetId) q = q.eq(columns.targetId, query.targetId);
  if (query.from) q = q.gte(columns.createdAt, query.from);
  if (query.to) q = q.lt(columns.createdAt, query.to);
  if (query.before) q = q.lt(columns.createdAt, query.before);

  return q as unknown as T;
}

/**
 * 행위자 이름을 채운다.
 *
 * **PostgREST 임베드(`profiles(display_name)`)를 쓰지 않는다.** `profiles` 의 SELECT
 * 정책은 *본인 또는 같은 커플* 이라 운영자가 임베드로 읽으면 **이름이 조용히 null 이 된다**
 * — 오류가 아니라 빈칸이라 화면은 "이름 없는 행위자" 를 그리고 아무도 이상하다고 느끼지
 * 않는다. 그래서 0053 의 `admin_actor_labels()` 로 필요한 두 칸만 받는다.
 */
async function loadActors(supabase: Client, ids: string[]): Promise<Record<string, ActorLabel>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return {};

  const { data, error } = await supabase.rpc("admin_actor_labels", { p_ids: unique });
  if (error) return {};

  const map: Record<string, ActorLabel> = {};
  for (const row of (data ?? []) as { user_id: string; display_name: string | null; role: string | null }[]) {
    map[row.user_id] = { displayName: row.display_name, role: row.role };
  }

  return map;
}

export async function loadAuditTimeline(query: AuditQuery): Promise<AuditPayload> {
  const supabase = await createClient();
  const limit = query.limit ?? AUDIT_PAGE_SIZE;

  // 두 표에서 각각 limit 만큼 가져와 섞은 뒤 자른다. 한쪽이 조용한 기간에도
  // 다른 쪽으로 화면이 채워진다.
  const logsQuery = applyFilters(
    supabase
      .from("audit_logs")
      .select("id, created_at, actor_id, actor_role, action, target_type, target_id, before_json, after_json, resolution_basis")
      .order("created_at", { ascending: false })
      .limit(limit),
    query,
    {
      createdAt: "created_at",
      actorRole: "actor_role",
      action: "action",
      targetType: "target_type",
      targetId: "target_id",
    },
  );

  const eventsQuery = applyFilters(
    supabase
      .from("entity_events")
      .select("id, occurred_at, entity_type, entity_id, event_type, actor_id, actor_role, before_state, after_state, source, memo")
      .order("occurred_at", { ascending: false })
      .limit(limit),
    query,
    {
      createdAt: "occurred_at",
      actorRole: "actor_role",
      action: "event_type",
      targetType: "entity_type",
      targetId: "entity_id",
    },
  );

  const [logsResult, eventsResult] = await Promise.all([logsQuery, eventsQuery]);

  if (logsResult.error) throw new Error("AUDIT_LOAD_FAILED");
  if (eventsResult.error) throw new Error("AUDIT_LOAD_FAILED");

  type RawLog = {
    id: string; created_at: string; actor_id: string | null; actor_role: string | null;
    action: string; target_type: string; target_id: string | null;
    before_json: unknown; after_json: unknown; resolution_basis: string[] | null;
  };
  type RawEvent = {
    id: string; occurred_at: string; entity_type: string; entity_id: string; event_type: string;
    actor_id: string | null; actor_role: string | null; before_state: string | null;
    after_state: string | null; source: string | null; memo: string | null;
  };

  const logs: AuditLogRow[] = ((logsResult.data ?? []) as RawLog[]).map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    beforeJson: row.before_json,
    afterJson: row.after_json,
    resolutionBasis: row.resolution_basis,
  }));

  const events: EntityEventRow[] = ((eventsResult.data ?? []) as RawEvent[]).map((row) => ({
    id: row.id,
    occurredAt: row.occurred_at,
    entityType: row.entity_type,
    entityId: row.entity_id,
    eventType: row.event_type,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    beforeState: row.before_state,
    afterState: row.after_state,
    source: row.source,
    memo: row.memo,
  }));

  const merged = buildTimeline(logs, events);
  const entries = merged.slice(0, limit);
  const hasMore = merged.length > entries.length;

  return {
    entries,
    actors: await loadActors(supabase, entries.map((entry) => entry.actorId ?? "")),
    facets: {
      actions: [...new Set([...logs.map((r) => r.action), ...events.map((r) => r.eventType)])].sort(),
      actorRoles: [...new Set(
        [...logs, ...events].map((r) => r.actorRole).filter((v): v is string => Boolean(v)),
      )].sort(),
      targetTypes: [...new Set([...logs.map((r) => r.targetType), ...events.map((r) => r.entityType)])].sort(),
    },
    hasMore,
    nextBefore: entries.length > 0 ? entries[entries.length - 1].at : null,
  };
}

/**
 * 한 대상의 증적 타임라인 (`GET /api/admin/entity-events`).
 *
 * **읽기 전용이다**(§4.3). 분쟁 조사에서 "이 예약에 무슨 일이 있었나" 를 시간순으로 본다.
 * S8-03 이 이 함수를 그대로 쓴다 — 조율 화면이 타임라인을 다시 만들면 두 벌이 된다.
 */
export async function loadEntityTimeline(
  entityType: string,
  entityId: string,
): Promise<AuditPayload> {
  return loadAuditTimeline({ targetType: entityType, targetId: entityId, limit: 200 });
}

import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { recordEvent } from "@/lib/audit/record";
import {
  SHARE_TOKEN_BYTES,
  shareExpiresAt,
  shareLinkState,
  shareableTypes,
  type ShareState,
} from "@/lib/core/share/share";
import type { EstimateComparison, NormalizedEstimate } from "@/lib/core/estimate/normalize";
import { loadReport, type ReportDetail } from "@/lib/reports/loader";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * 만료형 공유 링크 (S7-12 · 명세서 §2.1 F-C-20 · §4.2 · §6.2)
 *
 * ── 어떤 손으로 쓰는가 ──────────────────────────────────────────────────────
 * **발급·거둠의 권한은 "그 자원을 읽을 수 있는가" 로 판정한다.** 판정은 요청자의
 * **세션 클라이언트**가 자원을 실제로 읽어 보는 것으로 하며, 그러면 경계는 언제나
 * RLS 다. `share_links` 자체는 정책 없는 서비스롤 전용이라(0005 [61]) 행 쓰기는
 * 서비스롤이 한다 — **판정을 먼저 하고 그 뒤에 쓴다.**
 *
 * **여는 일은 익명이다.** 토큰을 가진 것이 곧 권한이라 RLS 로 표현할 수 없다.
 * 그래서 `share_link_open()`(SECURITY DEFINER · 0046)이 만료·거둠을 확인하고,
 * 자원은 서비스롤로 읽되 **뷰 전용으로 필요한 필드만** 옮긴다.
 *
 * ── 캐시를 끈다 (FIX-22 계열 · 흐름 점검이 잡았다) ──────────────────────────
 * 이 경로는 **쿠키를 하나도 읽지 않는다**(익명이 연다). 그래서 Next 가 서버 조회를
 * 정적 렌더로 취급해 캐시에 얹었고, **거둔 링크가 계속 열렸다** — 스위치가 스위치
 * 노릇을 못 한 S7-15 의 피처 플래그와 같은 증상이다. `lib/flags.ts` 가 한 것처럼
 * **자기 클라이언트를 만들고 `no-store` 를 못 박는다**(`createShareClient()` 를
 * 건드리면 전 호출부의 캐시 동작이 함께 바뀐다 · FIX-22).
 * 라우트·화면에는 `dynamic = "force-dynamic"` 을 함께 붙였다.
 *
 * ── 임베드를 쓰지 않는다 ────────────────────────────────────────────────────
 * 자원 조회에 PostgREST 임베드를 쓰지 않는다 — 공개 조건이 붙은 표가 섞이면 **행이
 * 안 보일 때 값이 조용히 사라진다**(S7-07 이 겪은 것). 리포트는 `loadReport` 를
 * 그대로 부르며, 그 함수는 문서와 분석을 각각 읽고 **둘 다 보여야 보여준다.**
 */


/**
 * 공유 전용 서비스롤 클라이언트.
 *
 * **`no-store` 를 못 박는다.** 거둠·만료가 즉시 반영돼야 하는데 캐시에 얹히면
 * **거둔 링크가 계속 열린다**(FIX-22 계열). `createShareClient()` 를 고치지 않은
 * 이유는 그쪽을 건드리면 전 호출부의 캐시 동작이 함께 바뀌기 때문이다.
 */
function createShareClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Supabase 서버 환경변수가 설정되지 않았습니다.");
  }

  return createSupabaseClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      fetch: (input, init) => fetch(input as RequestInfo, { ...init, cache: "no-store" }),
    },
  });
}

// =============================================================================
// 자원 로더 — 로더가 있는 유형만 열린다 (D-46 과 같은 처리)
// =============================================================================

/** 뷰 전용으로 내보내는 리포트. `loadReport` 결과에서 **화면이 쓰는 것만** 옮긴다. */
export type SharedFinding = Omit<ReportDetail["findings"][number], "negotiationScript">;

export type SharedReport = {
  kind: "report";
  createdAt: string;
  riskScore: number | null;
  findings: SharedFinding[];
  counts: ReportDetail["counts"];
  basisRefs: string[];
};

/**
 * 뷰 전용으로 내보내는 비교표 (S7-05).
 *
 * **저장한 스냅샷을 그대로 낸다** — 지금 다시 계산하지 않는다(D-87). 견적이 만료·
 * 변경됐다면 받은 사람이 보는 표와 보낸 사람이 만든 표가 달라지는데, 공유는 **그때
 * 무엇을 견줬는지**를 보이는 일이다.
 */
export type SharedComparison = {
  kind: "estimate_comparison";
  createdAt: string;
  estimates: NormalizedEstimate[];
  comparison: EstimateComparison;
};

export type SharedResource = SharedReport | SharedComparison;

/**
 * 유형별 로더.
 *
 * **서비스롤로 읽는다** — 링크를 여는 사람은 로그인하지 않았고 RLS 는 그를 모른다.
 * 대신 **여기 오기 전에** `share_link_open()` 이 토큰·만료·거둠을 확인했다: 그것이
 * 이 조회의 인가 근거다.
 *
 * **문서 id 를 내보내지 않는다.** 받은 사람이 알아야 할 것은 조항과 등급뿐이고,
 * 내부 식별자는 다른 경로를 여는 실마리가 된다(§5.3).
 */
const LOADERS: Record<string, (resourceId: string) => Promise<SharedResource | null>> = {
  report: async (resourceId) => {
    const report = await loadReport(createShareClient() as unknown as SupabaseClient, resourceId);
    if (report === null) return null;

    return {
      kind: "report",
      createdAt: report.createdAt,
      riskScore: report.riskScore,
      // `clauseExcerpt` 는 **마스킹본**이다(`clause_excerpt_masked` · S7-03).
      // 원문은 분석 직후 파기됐으므로(D-58) 링크로도 원문에 닿을 수 없다.
      //
      // **협상 문구(`negotiationScript`)를 벗긴다.** 그것은 계약 당사자가 업체에 보낼
      // 말이고 공유받은 사람은 당사자가 아니다 — 화면에서 안 그리는 것으로는 부족하다
      // (API 가 그대로 실어 보내면 링크를 가진 누구나 읽는다 · 흐름 점검이 잡았다).
      findings: report.findings.map(({ negotiationScript: _script, ...rest }) => rest),
      counts: report.counts,
      basisRefs: report.basisRefs,
    };
  },

  // **S7-05 가 연 유형.** 비교표는 조회 시점 계산이지만 공유하려고 누를 때 행이
  // 생기고(D-87), 여기서는 **그 스냅샷을 그대로** 낸다 — 다시 계산하지 않는다.
  estimate_comparison: async (resourceId) => {
    const { data } = await createShareClient()
      .from("estimate_comparisons")
      .select("normalized_json, created_at")
      .eq("id", resourceId)
      .maybeSingle();

    const row = (data ?? null) as {
      normalized_json: { estimates?: NormalizedEstimate[]; comparison?: EstimateComparison } | null;
      created_at: string;
    } | null;

    const snapshot = row?.normalized_json ?? null;

    // 스냅샷이 비어 있으면 **빈 표를 그리지 않는다** — 받은 사람에게는 "아무것도 없는
    // 비교표" 가 뜨고 보낸 사람은 그 사실을 모른다.
    if (row === null || snapshot?.comparison === undefined || snapshot.estimates === undefined) {
      return null;
    }

    return {
      kind: "estimate_comparison",
      createdAt: row.created_at,
      estimates: snapshot.estimates,
      comparison: snapshot.comparison,
    };
  },
};

export function hasShareLoader(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(LOADERS, type);
}

export function shareableResourceTypes(): string[] {
  return shareableTypes(hasShareLoader);
}

// =============================================================================
// 발급
// =============================================================================

export type ShareFailure = { status: number; code: string; message: string };

function newToken(): string {
  return randomBytes(SHARE_TOKEN_BYTES).toString("base64url");
}

async function loadTtlHours(): Promise<number | null> {
  const { data } = await createShareClient()
    .from("app_settings")
    .select("value_json")
    .eq("key", "share.link_ttl_hours")
    .maybeSingle();

  const hours = Number((data?.value_json as { hours?: unknown } | null)?.hours);

  return Number.isFinite(hours) && hours > 0 ? Math.trunc(hours) : null;
}

/**
 * **요청자가 그 자원을 읽을 수 있는가.**
 *
 * 세션 클라이언트로 읽어 본다 — 읽히면 그의 것이고, 안 읽히면 RLS 가 막은 것이다.
 * 소유 구조(커플·업체)를 이 파일이 다시 구현하지 않는다: **판정이 두 벌이면 언젠가
 * 둘이 다른 답을 낸다**(D-30 과 같은 이유).
 */
async function canReach(
  session: SupabaseClient,
  resourceType: string,
  resourceId: string,
): Promise<boolean> {
  if (resourceType === "report") {
    return (await loadReport(session, resourceId)) !== null;
  }
  if (resourceType === "estimate_comparison") {
    // **세션으로 읽어 본다.** `estimate_comparisons` 는 커플 스코프 RLS 라(0005 [48])
    // 읽히면 그의 것이고 안 읽히면 남의 것이다 — 판정을 여기서 다시 짜지 않는다.
    const { data } = await session
      .from("estimate_comparisons")
      .select("id")
      .eq("id", resourceId)
      .maybeSingle();

    return data !== null;
  }


  return false;
}

export async function createShareLink(
  session: SupabaseClient,
  input: { resourceType: string; resourceId: string; actorId: string; now?: Date },
): Promise<{ token: string; expiresAt: string; id: string } | ShareFailure> {
  if (!shareableResourceTypes().includes(input.resourceType)) {
    return {
      status: 422,
      code: "SHARE_TYPE_NOT_OPEN",
      message: "아직 공유할 수 없는 종류예요.",
    };
  }

  if (!(await canReach(session, input.resourceType, input.resourceId))) {
    // **없는 것과 남의 것을 같은 답으로 돌려준다.** 다른 코드를 주면 토큰 없이
    // "그 리포트가 존재하는가" 를 물어볼 수 있게 된다.
    return { status: 404, code: "SHARE_RESOURCE_NOT_FOUND", message: "공유할 대상을 찾을 수 없어요." };
  }

  const ttlHours = await loadTtlHours();
  const issuedAt = (input.now ?? new Date()).toISOString();
  const expiresAt = shareExpiresAt(issuedAt, ttlHours);

  // **기한이 없으면 만들지 않는다.** 기한 없는 공유 링크는 영구 공개와 같다.
  if (expiresAt === null) {
    return {
      status: 422,
      code: "SHARE_TTL_UNCONFIGURED",
      message: "공유 기한이 설정되지 않아 링크를 만들 수 없어요.",
    };
  }

  const token = newToken();

  const { data, error } = await createShareClient()
    .from("share_links")
    .insert({
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      token,
      expires_at: expiresAt,
      created_by: input.actorId,
    })
    .select("id")
    .maybeSingle();

  const id = (data as { id: string } | null)?.id ?? null;
  if (error || id === null) {
    return { status: 500, code: "SHARE_CREATE_FAILED", message: "링크를 만들지 못했어요." };
  }

  await recordEvent({
    entityType: "share_link",
    entityId: id,
    eventType: "share_link_created",
    actor: { id: input.actorId },
    // **토큰을 남기지 않는다**(§7.3) — 증적에 적으면 증적을 읽을 수 있는 사람이
    // 링크를 열 수 있게 된다. 남길 사실은 무엇을 공유했는가다.
    memo: `type:${input.resourceType}`,
  });

  return { token, expiresAt, id };
}

// =============================================================================
// 거둠
// =============================================================================

export async function revokeShareLink(
  session: SupabaseClient,
  input: { id: string; actorId: string },
): Promise<{ revoked: boolean } | ShareFailure> {
  const admin = createShareClient();

  const { data } = await admin
    .from("share_links")
    .select("id, resource_type, resource_id, revoked_at")
    .eq("id", input.id)
    .maybeSingle();

  const row = (data ?? null) as {
    id: string;
    resource_type: string;
    resource_id: string;
    revoked_at: string | null;
  } | null;

  // 없는 링크와 남의 링크를 같은 답으로 돌려준다(위와 같은 이유).
  if (row === null || !(await canReach(session, row.resource_type, row.resource_id))) {
    return { status: 404, code: "SHARE_LINK_NOT_FOUND", message: "링크를 찾을 수 없어요." };
  }

  // **이미 거둔 링크를 다시 거둬도 실패가 아니다** — 결과가 요청한 대로다(D-80).
  if (row.revoked_at !== null) return { revoked: false };

  await admin.from("share_links").update({ revoked_at: new Date().toISOString() }).eq("id", row.id);

  await recordEvent({
    entityType: "share_link",
    entityId: row.id,
    eventType: "share_link_revoked",
    actor: { id: input.actorId },
    memo: `type:${row.resource_type}`,
  });

  return { revoked: true };
}

// =============================================================================
// 목록 — 만든 사람이 보는 자리
// =============================================================================

export type ShareLinkRow = {
  id: string;
  token: string;
  expiresAt: string;
  revokedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  createdAt: string;
  state: ShareState;
};

/**
 * 이 자원에 걸린 링크들.
 *
 * **배우자가 만든 링크도 보인다**(D-19) — 판정이 `created_by` 가 아니라 **자원 소유**
 * 이기 때문이다. "누가 밖으로 보냈나" 를 커플이 함께 알아야 한다.
 */
export async function listShareLinks(
  session: SupabaseClient,
  input: { resourceType: string; resourceId: string; now?: Date },
): Promise<ShareLinkRow[]> {
  if (!(await canReach(session, input.resourceType, input.resourceId))) return [];

  const { data } = await createShareClient()
    .from("share_links")
    .select("id, token, expires_at, revoked_at, view_count, last_viewed_at, created_at")
    // **소유자 필터를 넣는다.** 판정은 위에서 끝났지만 조회 조건을 빼면 표 전체가
    // 나오고, 그때 화면이 무엇을 걸러 줄지에 기대게 된다.
    .eq("resource_type", input.resourceType)
    .eq("resource_id", input.resourceId)
    .order("created_at", { ascending: false })
    .limit(20);

  const now = (input.now ?? new Date()).toISOString();

  return ((data ?? []) as {
    id: string;
    token: string;
    expires_at: string;
    revoked_at: string | null;
    view_count: number;
    last_viewed_at: string | null;
    created_at: string;
  }[]).map((row) => ({
    id: row.id,
    token: row.token,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    viewCount: row.view_count,
    lastViewedAt: row.last_viewed_at,
    createdAt: row.created_at,
    state: shareLinkState({
      found: true,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      now,
    }),
  }));
}

// =============================================================================
// 열기 — 익명 경로
// =============================================================================

export type OpenedShare =
  | { state: "live"; resource: SharedResource; expiresAt: string; viewCount: number }
  | { state: Exclude<ShareState, "live">; resource: null };

export async function openShareLink(
  token: string,
  options: { now?: Date } = {},
): Promise<OpenedShare> {
  const now = (options.now ?? new Date()).toISOString();

  const { data } = await createShareClient().rpc("share_link_open", { p_token: token });

  const row = ((data ?? []) as {
    id: string;
    resource_type: string;
    resource_id: string;
    expires_at: string;
    revoked_at: string | null;
    view_count: number;
  }[])[0];

  const state = shareLinkState({
    found: row !== undefined,
    expiresAt: row?.expires_at ?? null,
    revokedAt: row?.revoked_at ?? null,
    now,
  });

  if (state !== "live" || row === undefined) return { state: state as Exclude<ShareState, "live">, resource: null };

  const loader = LOADERS[row.resource_type];

  // 어휘에는 있으나 로더가 없는 유형(`estimate_comparison` · S7-05)이거나 자원이
  // 사라진 경우. **빈 화면을 그리지 않고** 없는 것으로 답한다.
  if (loader === undefined) return { state: "missing", resource: null };

  const resource = await loader(row.resource_id);
  if (resource === null) return { state: "missing", resource: null };

  return { state: "live", resource, expiresAt: row.expires_at, viewCount: row.view_count };
}

/**
 * 만료형 공유 링크 (S7-12 · 명세서 §2.1 F-C-20 · §3.7 share_links · §4.2 · §6.2 `/share/[token]`)
 *
 * ── 이 파일이 정하는 것 ─────────────────────────────────────────────────────
 * 토큰의 **상태**와 **무엇을 공유할 수 있는가**뿐이다. 자원을 읽는 일은 서버가 하고
 * (`lib/share/links.ts`) 여기서는 프레임워크를 모른다.
 *
 * ── 링크가 안 열리는 이유를 뭉뚱그리지 않는다 ───────────────────────────────
 * "없는 링크" 하나로 답하면 **만료된 링크를 받은 사람이 자기가 주소를 잘못 옮겼다고
 * 생각한다.** 셋을 가른다 — **없음 · 만료 · 거둠**. 각각 다음에 할 일이 다르다
 * (다시 받기 · 다시 받기 · 보낸 사람에게 묻기). S7-04 가 "계산된 0" 과 "기준을 모른다" 를
 * 가른 것과 같은 규칙이다.
 */

// =============================================================================
// 공유할 수 있는 자원 — 로더가 있는 것만 연다
// =============================================================================

/**
 * `share_links.resource_type` 어휘.
 *
 * **로더가 없는 유형을 열지 않는다**(D-46 이 AI 툴에서 세운 규칙과 같다) — 열어 두면
 * 링크는 발급되는데 여는 쪽에서 실패한다. 그때의 증상은 **받은 사람에게 뜨는 빈 화면**
 * 이고, 링크를 보낸 사람은 그 사실을 모른다.
 *
 * `estimate_comparison` 은 **자원 자체가 아직 없다** — `estimate_comparisons` 행을
 * 만드는 것은 S7-05 다(§3.5). 담당 태스크가 끝나는 날 **상태 한 글자와 로더 하나면**
 * 열린다.
 */
export type ShareResourceSpec = {
  type: string;
  label: string;
  status: "available" | "pending";
  /** 아직 안 열린 유형의 담당 태스크. 열리면 비운다. */
  filledBy: string | null;
  /** 어느 표의 행을 가리키는가. 다음 사람이 로더를 찾는 자리다. */
  backing: string;
};

export const SHARE_RESOURCE_SPECS: readonly ShareResourceSpec[] = [
  {
    type: "report",
    label: "계약서 검토 리포트",
    status: "available",
    filledBy: null,
    backing: "document_analyses (S7-03)",
  },
  {
    type: "estimate_comparison",
    label: "견적 비교표",
    status: "pending",
    // §2.1 F-C-20 은 "리포트·비교표" 를 적었다. 비교표는 **저장된 자원이 아니라**
    // 조회 시점 계산이고(장바구니 비교 · D-77), 행으로 남는 비교표는
    // `estimate_comparisons` 이며 그것을 만드는 것은 S7-05 다.
    // `resource_id` 는 uuid 하나라 **행으로 존재하는 것만** 가리킬 수 있다.
    filledBy: "S7-05",
    backing: "estimate_comparisons (§3.5 · 미착수)",
  },
];

export type ShareResourceType = (typeof SHARE_RESOURCE_SPECS)[number]["type"];

/** 지금 실제로 공유할 수 있는 유형. */
export function shareableTypes(hasLoader: (type: string) => boolean): string[] {
  return SHARE_RESOURCE_SPECS.filter(
    (spec) => spec.status === "available" && hasLoader(spec.type),
  ).map((spec) => spec.type);
}

/** 아직 안 열린 유형과 그 이유. 운영 화면이 그대로 읽는다. */
export function shareGaps(hasLoader: (type: string) => boolean) {
  return SHARE_RESOURCE_SPECS.filter(
    (spec) => spec.status !== "available" || !hasLoader(spec.type),
  ).map((spec) => ({
    type: spec.type,
    reason: spec.status !== "available" ? "status" : "loader",
    filledBy: spec.filledBy,
  }));
}

export function shareResourceSpec(type: string): ShareResourceSpec | null {
  return SHARE_RESOURCE_SPECS.find((spec) => spec.type === type) ?? null;
}

// =============================================================================
// 만료 — 설정이 없으면 발급하지 않는다
// =============================================================================

/** 토큰 길이. 사람이 옮겨 적지 않고 링크에 실리므로 짧을 이유가 없다. */
export const SHARE_TOKEN_BYTES = 32;

/**
 * 만료 시각.
 *
 * **설정이 없으면 `null` 이고, 호출부는 링크를 만들지 않는다.** 폴백 상수를 두지 않은
 * 이유는 업체 초대(`vendor_invite.ttl_hours`)와 다르다 — 그쪽은 **이미 아는 사람에게
 * 보내는 초대**이고 이쪽은 **계약서 검토 결과를 링크 하나로 여는 일**이다. 만료 없는
 * 공유 링크는 **영구 공개**와 같고, 설정을 지웠을 때 그 상태로 조용히 넘어가는 경로를
 * 만들지 않는다(D-49 · D-82 와 같은 규칙 — 미설정을 무제한·0으로 읽지 않는다).
 */
export function shareExpiresAt(issuedAt: string, ttlHours: number | null): string | null {
  if (ttlHours === null || !Number.isFinite(ttlHours) || ttlHours <= 0) return null;

  const issued = Date.parse(issuedAt);
  if (Number.isNaN(issued)) throw new RangeError("발급 시각을 해석할 수 없습니다.");

  return new Date(issued + Math.trunc(ttlHours) * 3_600_000).toISOString();
}

// =============================================================================
// 상태 — 셋을 가른다
// =============================================================================

export const SHARE_STATES = ["live", "expired", "revoked", "missing"] as const;
export type ShareState = (typeof SHARE_STATES)[number];

export const SHARE_STATE_LABEL: Record<ShareState, string> = {
  live: "열려 있어요",
  expired: "링크가 만료됐어요",
  revoked: "보낸 사람이 링크를 거뒀어요",
  missing: "이 주소로는 아무것도 찾을 수 없어요",
};

/** 다음에 무엇을 할지. 셋의 답이 서로 다르기 때문에 가른다. */
export const SHARE_STATE_NOTE: Record<ShareState, string> = {
  live: "",
  expired: "공유 링크는 정해진 기간이 지나면 자동으로 닫혀요. 보낸 사람에게 새 링크를 받아 주세요.",
  revoked: "더 이상 열리지 않아요. 필요하면 보낸 사람에게 다시 요청해 주세요.",
  missing: "주소가 잘못 옮겨졌을 수 있어요. 받은 링크를 다시 확인해 주세요.",
};

export function shareLinkState(input: {
  found: boolean;
  expiresAt: string | null;
  revokedAt: string | null;
  now: string;
}): ShareState {
  if (!input.found) return "missing";

  // **거둠이 만료보다 먼저다.** 둘 다 해당하면 사람이 한 일을 말하는 편이 정확하다 —
  // 받은 사람이 "기다리면 다시 열리나" 를 묻지 않게 한다.
  if (input.revokedAt !== null) return "revoked";

  if (input.expiresAt === null) return "expired";

  return Date.parse(input.expiresAt) > Date.parse(input.now) ? "live" : "expired";
}

/**
 * 남은 시간(시간 단위). 만든 사람 화면이 쓴다.
 *
 * **음수를 내지 않는다** — 이미 지난 링크는 0이고, 그 사실은 `shareLinkState` 가 말한다.
 */
export function remainingHours(expiresAt: string | null, now: string): number | null {
  if (expiresAt === null) return null;

  const left = Date.parse(expiresAt) - Date.parse(now);

  return left <= 0 ? 0 : Math.ceil(left / 3_600_000);
}

// =============================================================================
// 화면 문구
// =============================================================================

export function shareUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/share/${token}`;
}

/**
 * 공유 화면 상단 고지.
 *
 * **뷰 전용이고 마스킹된 상태라는 사실**을 받은 사람에게 먼저 말한다(§2.1 F-C-20).
 * 원문은 분석 직후 파기됐으므로(D-58) 링크로도 원문에 닿을 수 없다.
 */
export const SHARE_VIEW_NOTICE =
  "공유받은 화면이에요. 보기만 할 수 있고 고칠 수는 없어요. 계약서 원문은 분석이 끝난 뒤 지워졌고, 남은 조항 인용은 이름·연락처 같은 개인정보를 가린 상태입니다.";

/** 만든 사람에게 보이는 안내. 링크를 넘기는 일의 뜻을 적는다. */
export const SHARE_OWNER_NOTICE =
  "링크를 가진 사람은 누구나 열 수 있어요. 기한이 지나면 자동으로 닫히고, 그전에도 직접 거둘 수 있습니다.";

export const SHARE_TTL_MISSING_NOTICE =
  "공유 기한이 설정되지 않아 링크를 만들 수 없어요. 기한 없는 링크는 만들지 않습니다.";

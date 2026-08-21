/**
 * 하객·좌석 (S7-09 · 명세서 §2.1 F-C-22 · §3.2 guests·seating_plans · §6.2 `/guests`)
 *
 * 프레임워크도 DB 도 모르는 순수 모듈이다.
 *
 * ── 이 파일이 지키는 것 ─────────────────────────────────────────────────────
 *  1. **이름을 다루지 않는다.** 여기 있는 계산(참석 인원·답례품 수량·좌석 배정)은
 *     전부 **수와 상태**로 돈다. 이름이 필요한 곳은 화면이고, 화면은 명단을 그릴 때만
 *     쓴다 — 계산에 이름이 끼면 로그·이벤트·집계 어디로든 흘러갈 길이 생긴다(§7.3).
 *  2. **세지 않은 것과 0을 가른다.** "미응답 3명" 과 "참석 0명" 은 다른 사실이고
 *     답례품 수량 판단이 다르다. 그래서 집계는 **응답 상태별로 따로** 낸다.
 *  3. **답례품 수량을 저장하지 않는다.** RSVP 응답에서 계산한다 — 저장하면 응답이
 *     바뀔 때마다 두 값이 갈리고, 갈린 순간 어느 쪽이 맞는지 아무도 모른다.
 */

// =============================================================================
// 값 집합 — DB CHECK 와 같아야 한다 (`db:rls` 가 대조한다)
// =============================================================================

/**
 * 참석 응답 상태.
 *
 * `pending` 은 **아직 답하지 않은 것**이고 `declined` 는 **안 온다고 답한 것**이다.
 * 둘을 합치면 "답례품 몇 개" 를 답할 수 없다 — 미응답은 아직 모르는 수이고,
 * 불참은 확정된 0이다.
 */
export const RSVP_STATUSES = ["pending", "attending", "declined"] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];

export const RSVP_STATUS_LABEL: Record<RsvpStatus, string> = {
  pending: "미응답",
  attending: "참석",
  declined: "불참",
};

/** 하객이 스스로 고를 수 있는 것. **`pending` 으로 되돌리는 것은 커플만** 한다. */
export const GUEST_ANSWERS = ["attending", "declined"] as const;
export type GuestAnswer = (typeof GUEST_ANSWERS)[number];

/**
 * 어느 쪽 하객인가.
 *
 * `unassigned` 를 두는 이유는 **모르는 것을 한쪽으로 밀어 넣지 않기** 위해서다 —
 * 명단을 옮겨 적다 보면 양가 구분이 빠진 줄이 생기고, 그것을 신랑 측으로 세면
 * 좌석 수가 조용히 틀어진다.
 */
export const GUEST_SIDES = ["groom", "bride", "both", "unassigned"] as const;
export type GuestSide = (typeof GUEST_SIDES)[number];

export const GUEST_SIDE_LABEL: Record<GuestSide, string> = {
  groom: "신랑 측",
  bride: "신부 측",
  both: "양가 공통",
  unassigned: "미정",
};

export const GUEST_NAME_MAX_LENGTH = 40;
export const GUEST_PARTY_SIZE_MAX = 20;

// =============================================================================
// 집계 — 세지 않은 것과 0을 가른다
// =============================================================================

export type GuestCounts = {
  /** 명단에 적힌 줄 수(동반 인원을 세지 않은 값). */
  entries: number;
  /** 상태별 **머릿수**(동반 인원 포함). */
  attending: number;
  declined: number;
  pending: number;
  /** 응답이 다 오면 몇 명이 되는가 — 참석 + 미응답. **상한이지 예상이 아니다.** */
  maxPossible: number;
};

export type GuestLike = { rsvpStatus: RsvpStatus; partySize: number };

/**
 * 명단 집계.
 *
 * `partySize` 는 **그 줄이 데려오는 총 인원**(본인 포함)이다. 불참으로 답한 줄의
 * 동반 인원은 세지 않는다 — 안 오는 사람의 동반자도 안 온다.
 */
export function countGuests(guests: readonly GuestLike[]): GuestCounts {
  const counts: GuestCounts = {
    entries: guests.length,
    attending: 0,
    declined: 0,
    pending: 0,
    maxPossible: 0,
  };

  for (const guest of guests) {
    const size = Number.isInteger(guest.partySize) && guest.partySize > 0 ? guest.partySize : 0;

    if (guest.rsvpStatus === "attending") counts.attending += size;
    else if (guest.rsvpStatus === "declined") counts.declined += size;
    else counts.pending += size;
  }

  counts.maxPossible = counts.attending + counts.pending;

  return counts;
}

// =============================================================================
// 답례품 수량 — 계산하고 저장하지 않는다
// =============================================================================

export type FavorEstimate = {
  /** 확정 참석 인원. **응답이 온 만큼만**이다. */
  confirmed: number;
  /** 미응답이 전부 온다면. 상한이다. */
  upperBound: number;
  /** 아직 답하지 않은 인원. 0이면 상한과 확정이 같다. */
  pending: number;
  /** 상한과 확정이 같은가 — 응답이 다 왔다는 뜻. */
  settled: boolean;
};

/**
 * 답례품 수량.
 *
 * **하나의 숫자를 주지 않는다.** 미응답이 남아 있는 동안 "몇 개 준비하세요" 는 답이
 * 될 수 없고, 하나만 주면 사용자는 그것을 확정으로 읽는다. **확정·상한·미응답 셋**을
 * 함께 내고 화면이 그대로 적는다(S7-04 가 위약금 기준에서 세운 규칙과 같다 —
 * 계산된 0과 모르는 것을 겹쳐 읽히게 두지 않는다).
 */
export function favorEstimate(counts: GuestCounts): FavorEstimate {
  return {
    confirmed: counts.attending,
    upperBound: counts.maxPossible,
    pending: counts.pending,
    settled: counts.pending === 0,
  };
}

/**
 * **0에 근거를 붙인다.**
 *
 * 참석 0명이 "아무도 안 온다" 인지 "아직 아무도 답하지 않았다" 인지 화면에서 갈린다.
 */
export function favorNote(estimate: FavorEstimate, entries: number): string {
  if (entries === 0) return "명단이 비어 있어요. 하객을 추가하면 수량을 계산해 드릴게요.";

  if (estimate.settled) {
    return estimate.confirmed === 0
      ? "응답은 모두 왔고 참석이 없습니다. 0명은 아직 세지 않은 것이 아니라 확정된 값이에요."
      : `응답이 모두 왔어요. ${estimate.confirmed}명 기준으로 준비하면 됩니다.`;
  }

  if (estimate.confirmed === 0) {
    return `아직 참석 응답이 없어요. 0명이 아니라 **응답을 기다리는 중**이며 최대 ${estimate.upperBound}명까지 늘 수 있어요.`;
  }

  return `지금까지 ${estimate.confirmed}명이 참석으로 답했어요. 미응답 ${estimate.pending}명이 모두 오면 ${estimate.upperBound}명입니다.`;
}

// =============================================================================
// 예상 하객 수와의 대조
// =============================================================================

export type GuestCountGap =
  | { known: false; reason: "no_estimate" }
  | { known: true; estimate: number; maxPossible: number; diff: number };

export const NO_ESTIMATE_NOTE =
  "온보딩에서 예상 하객 수를 정하지 않아 견줄 기준이 없어요. 0명과 다릅니다.";

/**
 * 온보딩의 예상 하객 수(`couples.guest_count`)와 실제 명단을 견준다.
 *
 * **기준이 없으면 0으로 읽지 않는다.** 예상값이 없을 때 0과 견주면 명단을 한 줄만
 * 넣어도 "예상보다 많다" 가 뜬다 — 그건 사실이 아니라 설정이 비었다는 뜻이다.
 */
export function guestCountGap(input: {
  estimate: number | null;
  counts: GuestCounts;
}): GuestCountGap {
  if (input.estimate === null || !Number.isInteger(input.estimate) || input.estimate <= 0) {
    return { known: false, reason: "no_estimate" };
  }

  return {
    known: true,
    estimate: input.estimate,
    maxPossible: input.counts.maxPossible,
    diff: input.counts.maxPossible - input.estimate,
  };
}

// =============================================================================
// 좌석 배치 초안
// =============================================================================

/**
 * 좌석 배치를 **테이블 단위 배정**으로 둔다.
 *
 * ── 배치도 편집기를 만들지 않은 이유 ───────────────────────────────────────
 * §2.1 이 적은 것은 **"좌석 배치 초안"** 이다. 실제 배치도(도면 위에 원탁을 끌어다
 * 놓는 것)는 **375px 화면에서 쓸 수 없고**(D-78 이 의존 관계 뷰에서 세운 판단과 같다 —
 * 노드·간선은 모바일에서 읽히지 않는다), 예식장이 주는 도면 없이는 배치가 사실도
 * 아니다. 사용자가 실제로 답해야 하는 물음은 **"누구를 같은 테이블에 앉힐 것인가"**
 * 이며 그건 그룹 배정으로 충분히 답한다.
 *
 * 도면이 필요해지는 날 `layout_json` 에 좌표를 더하면 된다 — 지금 좌표를 만들면
 * **아무도 안 쓰는 값**이 저장된다.
 */
export type SeatingTable = {
  id: string;
  name: string;
  /** 이 테이블에 앉힐 수 있는 인원. 0이면 상한을 모르는 것이다. */
  capacity: number;
  /** 배정된 하객 id. **이름을 담지 않는다.** */
  guestIds: string[];
};

export type SeatingLayout = { tables: SeatingTable[] };

export const SEATING_TABLE_NAME_MAX = 30;
export const SEATING_MAX_TABLES = 100;

/** 저장된 `layout_json` 을 읽는다. **모양이 틀려도 화면이 서야 한다.** */
export function parseLayout(raw: unknown): SeatingLayout {
  const source = (raw ?? {}) as Record<string, unknown>;
  const tables = Array.isArray(source.tables) ? source.tables : [];

  return {
    tables: tables
      .filter((table): table is Record<string, unknown> => typeof table === "object" && table !== null)
      .map((table) => ({
        id: String(table.id ?? ""),
        name: String(table.name ?? ""),
        capacity: Number.isInteger(table.capacity) && Number(table.capacity) > 0 ? Number(table.capacity) : 0,
        guestIds: Array.isArray(table.guestIds)
          ? table.guestIds.filter((id): id is string => typeof id === "string")
          : [],
      }))
      .filter((table) => table.id.length > 0),
  };
}

export type SeatingIssue =
  | { code: "over_capacity"; tableId: string; assigned: number; capacity: number }
  | { code: "duplicate_guest"; guestId: string }
  | { code: "unknown_guest"; guestId: string };

export const SEATING_ISSUE_NOTE: Record<SeatingIssue["code"], string> = {
  over_capacity: "테이블 정원을 넘었어요.",
  duplicate_guest: "같은 하객이 두 테이블에 배정돼 있어요.",
  unknown_guest: "명단에 없는 하객이 배정돼 있어요. 삭제된 분일 수 있습니다.",
};

/**
 * 배치 점검.
 *
 * **막지 않고 알린다.** 정원을 넘겨 두고 나중에 조정하는 것이 실제 준비 과정이라
 * 저장 자체를 거절하면 작업이 끊긴다(D-78 계열 — 순서를 보이되 잠그지 않는다).
 * 다만 **같은 사람이 두 테이블에 앉는 것**은 알려야 한다 — 인쇄해서 나눠 주는
 * 순간 되돌릴 수 없다.
 */
export function seatingIssues(input: {
  layout: SeatingLayout;
  guestIds: readonly string[];
}): SeatingIssue[] {
  const issues: SeatingIssue[] = [];
  const known = new Set(input.guestIds);
  const seen = new Set<string>();

  for (const table of input.layout.tables) {
    if (table.capacity > 0 && table.guestIds.length > table.capacity) {
      issues.push({
        code: "over_capacity",
        tableId: table.id,
        assigned: table.guestIds.length,
        capacity: table.capacity,
      });
    }

    for (const guestId of table.guestIds) {
      if (seen.has(guestId)) issues.push({ code: "duplicate_guest", guestId });
      else seen.add(guestId);

      if (!known.has(guestId)) issues.push({ code: "unknown_guest", guestId });
    }
  }

  return issues;
}

/** 아직 어느 테이블에도 앉지 않은 하객. **계산값이라 저장하지 않는다.** */
export function unseatedGuestIds(input: {
  layout: SeatingLayout;
  guestIds: readonly string[];
}): string[] {
  const seated = new Set(input.layout.tables.flatMap((table) => table.guestIds));

  return input.guestIds.filter((id) => !seated.has(id));
}

// =============================================================================
// 초대 링크 — 예식일이 없으면 만들지 않는다
// =============================================================================

export type InviteState = "live" | "closed" | "no_wedding_date" | "not_issued";

export const INVITE_STATE_NOTE: Record<InviteState, string> = {
  live: "링크가 열려 있어요.",
  closed: "예식일이 지나 응답을 받지 않습니다.",
  // **미설정을 무제한으로 읽지 않는다.** 다만 이유가 다르다 — 아래 주석 참조.
  no_wedding_date: "예식일을 먼저 정해 주세요. 언제까지 응답을 받을지 정할 수 없어요.",
  not_issued: "아직 링크를 만들지 않았어요.",
};

/**
 * 초대 링크의 상태.
 *
 * ── 공유 링크(S7-12)를 그대로 쓰지 않은 이유 ────────────────────────────────
 *  1. **가리키는 것이 다르다.** `share_links.resource_id` 는 **행 하나**를 가리키는데
 *     초대는 **하객마다 다른 링크**여야 한다(누가 답했는지 알아야 하므로). 한 표에
 *     행을 하객 수만큼 만들면 그 표의 뜻이 흐려진다.
 *  2. **만료의 뜻이 정반대다.** S7-12 는 설정이 없으면 **링크를 만들지 않는다** —
 *     만료 없는 공유는 영구 공개이기 때문이다. 청첩장은 반대로 **예식일까지 살아
 *     있어야** 하고 짧은 만료가 오히려 사고다.
 *
 * 그래서 만료를 **시간 상수가 아니라 예식일**로 둔다. 임의 숫자(며칠)가 끼지 않고,
 * **예식일이 없으면 링크를 만들지 않는다** — 언제까지 받을지 모르는 채로 여는 것은
 * 만료 없는 공개와 같다(D-49 계열).
 */
export function inviteState(input: {
  weddingDate: string | null;
  hasToken: boolean;
  today: string;
}): InviteState {
  if (input.weddingDate === null || input.weddingDate.length === 0) return "no_wedding_date";
  if (!input.hasToken) return "not_issued";

  // 예식일 **당일까지** 받는다. 날짜 문자열끼리 견주므로 시간대가 끼지 않는다.
  return input.today <= input.weddingDate.slice(0, 10) ? "live" : "closed";
}

/** 링크를 만들 수 있는가. 화면이 버튼을 열지 말지 정하는 근거다. */
export function canIssueInvite(weddingDate: string | null): boolean {
  return weddingDate !== null && weddingDate.length > 0;
}

// =============================================================================
// 입력 검증
// =============================================================================

export type GuestIssue = "empty_name" | "name_too_long" | "bad_party_size" | "bad_side";

export const GUEST_ISSUE_NOTE: Record<GuestIssue, string> = {
  empty_name: "이름을 적어 주세요.",
  name_too_long: `이름은 ${GUEST_NAME_MAX_LENGTH}자까지 넣을 수 있어요.`,
  bad_party_size: `동반 인원을 포함한 인원 수는 1~${GUEST_PARTY_SIZE_MAX}명 사이여야 해요.`,
  bad_side: "어느 쪽 하객인지 값이 올바르지 않아요.",
};

export function guestIssue(input: {
  name: string;
  partySize: number;
  side: string;
}): GuestIssue | null {
  const name = input.name.trim();

  if (name.length === 0) return "empty_name";
  if (name.length > GUEST_NAME_MAX_LENGTH) return "name_too_long";
  if (
    !Number.isInteger(input.partySize) ||
    input.partySize < 1 ||
    input.partySize > GUEST_PARTY_SIZE_MAX
  ) {
    return "bad_party_size";
  }
  if (!(GUEST_SIDES as readonly string[]).includes(input.side)) return "bad_side";

  return null;
}

// =============================================================================
// 화면 문구
// =============================================================================

export const GUEST_PRIVACY_NOTICE =
  "하객 이름과 연락처는 두 분과 위임한 플래너만 볼 수 있어요. 업체에는 인원 수만 전달되며 이름은 전달되지 않습니다.";

export const INVITE_SHARE_NOTICE =
  "하객마다 링크가 다릅니다. 링크를 받은 분은 이름을 고칠 수 없고 참석 여부와 인원만 답할 수 있어요.";

export const SEATING_DRAFT_NOTICE =
  "테이블 단위 초안입니다. 예식장 도면과 다를 수 있으니 최종 배치는 예식장과 확인해 주세요.";

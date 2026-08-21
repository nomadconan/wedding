import { createHash, randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { recordEvent } from "@/lib/audit/record";
import {
  countGuests,
  favorEstimate,
  favorNote,
  guestCountGap,
  inviteState,
  parseLayout,
  seatingIssues,
  unseatedGuestIds,
  type GuestCountGap,
  type GuestCounts,
  type GuestSide,
  type InviteState,
  type RsvpStatus,
  type SeatingIssue,
  type SeatingLayout,
} from "@/lib/core/guest/guest";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 하객·좌석 조회·갱신 (S7-09 · 명세서 §2.1 F-C-22 · §4.2 · §7.3)
 *
 * ── 세션으로 읽고 세션으로 쓴다 ─────────────────────────────────────────────
 * `guests`·`seating_plans` 는 커플 스코프이고 RLS(0005 [15][16])가 **커플 구성원 +
 * 위임 플래너(읽기만)** 를 판정한다. 서비스롤을 쓰는 자리는 **토큰 발급·회수 둘**
 * 뿐이다 — 0051 이 `invite_token`·`responded_at` 의 컬럼 권한을 세션에서 걷었기
 * 때문이며, 걷은 이유는 토큰을 손으로 넣을 수 있으면 **남의 하객 토큰을 자기 행에
 * 복사**하는 모양이 가능하기 때문이다.
 *
 * ── 임베드를 쓰지 않는다 ────────────────────────────────────────────────────
 * `guests` 는 단일 표 조회이고 이름·인원은 다른 표에서 오지 않는다. 예상 하객 수만
 * `couples` 에서 따로 읽는다 — **임베드로 붙이면 그 행이 안 보일 때 값이 조용히
 * 사라지고**(S7-05 함정) 그러면 "예상보다 많다" 가 근거 없이 뜬다.
 *
 * ── 이름을 이벤트에 담지 않는다 ─────────────────────────────────────────────
 * §7.3. `recordEvent` 의 `memo` 에는 **무엇이 몇 개 바뀌었는가**만 남긴다.
 */

export type GuestRow = {
  id: string;
  name: string;
  side: GuestSide;
  rsvpStatus: RsvpStatus;
  partySize: number;
  hasContact: boolean;
  hasInvite: boolean;
  respondedAt: string | null;
};

export type GuestsView = {
  guests: GuestRow[];
  counts: GuestCounts;
  favor: ReturnType<typeof favorEstimate>;
  favorNote: string;
  gap: GuestCountGap;
  weddingDate: string | null;
  invite: InviteState;
  layout: SeatingLayout;
  issues: SeatingIssue[];
  unseated: string[];
};

type Row = {
  id: string;
  name: string;
  side: string;
  rsvp_status: string;
  party_size: number;
  contact_hash: string | null;
  invite_token: string | null;
  responded_at: string | null;
};

/** 연락처는 **해시만 저장한다**(§7.3 · 0002 주석). 원문은 여기서 사라진다. */
export function hashContact(contact: string): string {
  return createHash("sha256").update(contact.trim(), "utf8").digest("hex");
}

/**
 * 명단·집계·좌석을 한 번에.
 *
 * **화면이 조회를 나눠 갖지 않는다** — 답례품 수량과 좌석 점검이 같은 명단에서
 * 나와야 하고, 따로 읽으면 그 사이에 바뀐 행 때문에 두 숫자가 어긋난다.
 */
export async function loadGuests(
  client: SupabaseClient,
  input: { coupleId: string; today: string },
): Promise<GuestsView> {
  const { data } = await client
    .from("guests")
    .select("id, name, side, rsvp_status, party_size, contact_hash, invite_token, responded_at")
    .eq("couple_id", input.coupleId)
    .order("created_at", { ascending: true });

  const guests: GuestRow[] = ((data ?? []) as Row[]).map((row) => ({
    id: row.id,
    name: row.name,
    side: row.side as GuestSide,
    rsvpStatus: row.rsvp_status as RsvpStatus,
    partySize: row.party_size,
    // **해시를 화면으로 내보내지 않는다.** 있는지 여부만 넘긴다(§7.2 와 같은 규칙).
    hasContact: row.contact_hash !== null,
    // **토큰도 목록에 싣지 않는다.** 링크는 발급 응답에서 한 번만 준다.
    hasInvite: row.invite_token !== null,
    respondedAt: row.responded_at,
  }));

  const { data: couple } = await client
    .from("couples")
    .select("wedding_date, guest_count")
    .eq("id", input.coupleId)
    .maybeSingle();

  const weddingDate = (couple as { wedding_date: string | null } | null)?.wedding_date ?? null;
  const estimate = (couple as { guest_count: number | null } | null)?.guest_count ?? null;

  const { data: plan } = await client
    .from("seating_plans")
    .select("layout_json")
    .eq("couple_id", input.coupleId)
    .maybeSingle();

  const layout = parseLayout((plan as { layout_json: unknown } | null)?.layout_json ?? null);
  const counts = countGuests(guests.map((g) => ({ rsvpStatus: g.rsvpStatus, partySize: g.partySize })));
  const guestIds = guests.map((g) => g.id);
  const favor = favorEstimate(counts);

  return {
    guests,
    counts,
    favor,
    favorNote: favorNote(favor, counts.entries),
    gap: guestCountGap({ estimate, counts }),
    weddingDate,
    invite: inviteState({
      weddingDate,
      hasToken: guests.some((g) => g.hasInvite),
      today: input.today,
    }),
    layout,
    issues: seatingIssues({ layout, guestIds }),
    unseated: unseatedGuestIds({ layout, guestIds }),
  };
}

// =============================================================================
// 명단
// =============================================================================

export type GuestFailure = { status: number; code: string; message: string };

export async function createGuest(
  client: SupabaseClient,
  input: {
    coupleId: string;
    userId: string;
    name: string;
    side: GuestSide;
    partySize: number;
    contact?: string;
  },
): Promise<{ guestId: string } | GuestFailure> {
  const { data, error } = await client
    .from("guests")
    .insert({
      couple_id: input.coupleId,
      name: input.name.trim(),
      side: input.side,
      party_size: input.partySize,
      contact_hash: input.contact ? hashContact(input.contact) : null,
      rsvp_status: "pending",
    })
    .select("id")
    .maybeSingle();

  const saved = (data ?? null) as { id: string } | null;
  if (error || saved === null) {
    return { status: 500, code: "GUEST_SAVE_FAILED", message: "하객을 추가하지 못했어요." };
  }

  await recordEvent({
    entityType: "guest",
    entityId: saved.id,
    eventType: "guest_added",
    actor: { id: input.userId },
    afterState: "pending",
    // **이름을 담지 않는다**(§7.3). 남길 사실은 인원 수뿐이다.
    memo: `party:${input.partySize}`,
  });

  return { guestId: saved.id };
}

export async function updateGuest(
  client: SupabaseClient,
  input: {
    coupleId: string;
    userId: string;
    guestId: string;
    name?: string;
    side?: GuestSide;
    partySize?: number;
    rsvpStatus?: RsvpStatus;
  },
): Promise<{ updated: boolean } | GuestFailure> {
  const patch: Record<string, unknown> = {};

  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.side !== undefined) patch.side = input.side;
  if (input.partySize !== undefined) patch.party_size = input.partySize;
  if (input.rsvpStatus !== undefined) patch.rsvp_status = input.rsvpStatus;

  if (Object.keys(patch).length === 0) {
    return { status: 422, code: "GUEST_NOTHING_TO_UPDATE", message: "바꿀 값이 없어요." };
  }

  // 커플이 대신 답을 적으면 **답한 시각이 필요하다**(0051 CHECK). 그 칸은 세션에서
  // 쓸 수 없으므로 서비스롤이 채운다 — 값을 사람이 정하지 않고 지금 시각을 넣는다.
  const needsRespondedAt = input.rsvpStatus !== undefined && input.rsvpStatus !== "pending";

  const { data, error } = await client
    .from("guests")
    .update(patch)
    .eq("id", input.guestId)
    // **소유자 필터를 넣는다.** RLS 가 경계지만 조건을 빼면 한 줄이 표 전체를
    // 건드릴 수 있는 모양이 된다.
    .eq("couple_id", input.coupleId)
    .select("id")
    .maybeSingle();

  if (error) {
    return { status: 500, code: "GUEST_UPDATE_FAILED", message: "하객 정보를 고치지 못했어요." };
  }

  if (data === null) {
    return { status: 404, code: "GUEST_NOT_FOUND", message: "하객을 찾을 수 없어요." };
  }

  if (needsRespondedAt) {
    await createAdminClient()
      .from("guests")
      .update({ responded_at: new Date().toISOString() })
      .eq("id", input.guestId)
      .eq("couple_id", input.coupleId)
      .is("responded_at", null);
  }

  if (input.rsvpStatus === "pending") {
    await createAdminClient()
      .from("guests")
      .update({ responded_at: null })
      .eq("id", input.guestId)
      .eq("couple_id", input.coupleId);
  }

  if (input.rsvpStatus !== undefined) {
    await recordEvent({
      entityType: "guest",
      entityId: input.guestId,
      eventType: "guest_rsvp_changed",
      actor: { id: input.userId },
      afterState: input.rsvpStatus,
      // **커플이 대신 적었다는 사실**을 남긴다 — 하객이 직접 답한 것과 다르다.
      memo: "by:couple",
    });
  }

  return { updated: true };
}

export async function deleteGuest(
  client: SupabaseClient,
  input: { coupleId: string; userId: string; guestId: string },
): Promise<{ deleted: boolean } | GuestFailure> {
  const { data } = await client
    .from("guests")
    .delete()
    .eq("id", input.guestId)
    .eq("couple_id", input.coupleId)
    .select("id")
    .maybeSingle();

  if (data === null) {
    return { status: 404, code: "GUEST_NOT_FOUND", message: "하객을 찾을 수 없어요." };
  }

  await recordEvent({
    entityType: "guest",
    entityId: input.guestId,
    eventType: "guest_removed",
    actor: { id: input.userId },
    afterState: "removed",
    memo: null,
  });

  return { deleted: true };
}

// =============================================================================
// 초대 링크
// =============================================================================

/** 토큰 길이. 링크에 실리므로 짧을 이유가 없다(S7-12 와 같은 판단). */
export const INVITE_TOKEN_BYTES = 32;

export async function issueInvite(
  client: SupabaseClient,
  input: { coupleId: string; userId: string; guestId: string; weddingDate: string | null },
): Promise<{ token: string } | GuestFailure> {
  // **예식일이 없으면 발급하지 않는다.** 언제까지 받을지 모르는 채로 여는 것은
  // 만료 없는 공개와 같다(D-49 계열 · lib/core/guest 의 `canIssueInvite` 와 같은 판단).
  if (input.weddingDate === null) {
    return {
      status: 422,
      code: "GUEST_NO_WEDDING_DATE",
      message: "예식일을 먼저 정해 주세요. 언제까지 응답을 받을지 정할 수 없어요.",
    };
  }

  // 소유 확인은 **세션으로** 한다 — 아래 쓰기가 서비스롤이므로 판정을 먼저 끝낸다.
  const { data: owned } = await client
    .from("guests")
    .select("id, invite_token")
    .eq("id", input.guestId)
    .eq("couple_id", input.coupleId)
    .maybeSingle();

  const guest = (owned ?? null) as { id: string; invite_token: string | null } | null;
  if (guest === null) {
    return { status: 404, code: "GUEST_NOT_FOUND", message: "하객을 찾을 수 없어요." };
  }

  // **이미 있으면 다시 만들지 않는다.** 새로 만들면 이미 보낸 링크가 죽는다.
  if (guest.invite_token !== null) return { token: guest.invite_token };

  const token = randomBytes(INVITE_TOKEN_BYTES).toString("base64url");

  const { error } = await createAdminClient()
    .from("guests")
    .update({ invite_token: token })
    .eq("id", input.guestId)
    .eq("couple_id", input.coupleId);

  if (error) {
    return { status: 500, code: "GUEST_INVITE_FAILED", message: "초대 링크를 만들지 못했어요." };
  }

  await recordEvent({
    entityType: "guest",
    entityId: input.guestId,
    eventType: "guest_invite_issued",
    actor: { id: input.userId },
    afterState: "issued",
    // **토큰도 이름도 담지 않는다.** 이벤트에 토큰이 남으면 링크가 로그로 새는 것과 같다.
    memo: null,
  });

  return { token };
}

export async function revokeInvite(
  client: SupabaseClient,
  input: { coupleId: string; userId: string; guestId: string },
): Promise<{ revoked: boolean } | GuestFailure> {
  const { data: owned } = await client
    .from("guests")
    .select("id")
    .eq("id", input.guestId)
    .eq("couple_id", input.coupleId)
    .maybeSingle();

  if (owned === null) {
    return { status: 404, code: "GUEST_NOT_FOUND", message: "하객을 찾을 수 없어요." };
  }

  await createAdminClient()
    .from("guests")
    .update({ invite_token: null })
    .eq("id", input.guestId)
    .eq("couple_id", input.coupleId);

  await recordEvent({
    entityType: "guest",
    entityId: input.guestId,
    eventType: "guest_invite_revoked",
    actor: { id: input.userId },
    afterState: "revoked",
    memo: null,
  });

  return { revoked: true };
}

// =============================================================================
// 좌석
// =============================================================================

export async function saveSeating(
  client: SupabaseClient,
  input: { coupleId: string; userId: string; layout: SeatingLayout },
): Promise<{ saved: boolean } | GuestFailure> {
  const { data: current } = await client
    .from("seating_plans")
    .select("id, version")
    .eq("couple_id", input.coupleId)
    .maybeSingle();

  const row = (current ?? null) as { id: string; version: number } | null;

  const { error } = row === null
    ? await client
        .from("seating_plans")
        .insert({ couple_id: input.coupleId, layout_json: input.layout, version: 1 })
    : await client
        .from("seating_plans")
        .update({ layout_json: input.layout, version: row.version + 1 })
        .eq("id", row.id)
        .eq("couple_id", input.coupleId);

  if (error) {
    return { status: 500, code: "SEATING_SAVE_FAILED", message: "좌석 배치를 저장하지 못했어요." };
  }

  await recordEvent({
    entityType: "seating_plan",
    entityId: row?.id ?? input.coupleId,
    eventType: "seating_saved",
    actor: { id: input.userId },
    afterState: "saved",
    // **테이블 수만** 남긴다. 이름도 배정도 담지 않는다.
    memo: `tables:${input.layout.tables.length}`,
  });

  return { saved: true };
}

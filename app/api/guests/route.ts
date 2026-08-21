import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import {
  GUEST_ISSUE_NOTE,
  GUEST_PRIVACY_NOTICE,
  INVITE_SHARE_NOTICE,
  INVITE_STATE_NOTE,
  NO_ESTIMATE_NOTE,
  SEATING_DRAFT_NOTICE,
  SEATING_ISSUE_NOTE,
  canIssueInvite,
  guestIssue,
} from "@/lib/core/guest/guest";
import { GuestActionSchema } from "@/lib/core/schemas/guest";
import { findMyCouple } from "@/lib/couple/membership";
import { createGuest, deleteGuest, loadGuests, updateGuest } from "@/lib/guest/loader";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * GET/POST /api/guests — 하객 명단 (F-C-22 · 명세서 §4.2)
 *
 * **§4.2 에 하객 API 행이 없어 이번에 신설한다.** 경로를 넷으로 쪼개는 대신 명단
 * 조작(추가·수정·삭제)을 **행위 union** 으로 한 경로에 모았다(`/api/tasks`·`/api/budget`
 * 과 같은 모양). 좌석·초대는 **다른 경로**다 — 좌석은 문서 하나를 통째로 쓰는 일이고,
 * 초대는 **되돌리기 어려운 링크 발급**이라 같은 문에 두면 실수하기 쉽다.
 *
 * ── 응답 본문에 이름 말고는 아무것도 더 싣지 않는다 ────────────────────────
 * 연락처 해시와 초대 토큰은 **내보내지 않는다** — 있는지 여부(`hasContact`·`hasInvite`)만
 * 넘긴다. 토큰이 목록에 실리면 화면을 한 번 캡처하는 것만으로 남의 응답을 대신할 수
 * 있게 된다.
 *
 * 인가의 경계는 RLS 다(0005 [15] — 커플 구성원 쓰기 · 위임 플래너 읽기만).
 */
export const dynamic = "force-dynamic";

async function context() {
  const user = await getSessionUser();
  if (!user) return { error: fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.") } as const;

  const membership = await findMyCouple(user.id);
  if (!membership) {
    return { error: fail(404, "GUEST_COUPLE_NOT_FOUND", "먼저 온보딩을 마쳐 주세요.") } as const;
  }

  return { user, membership } as const;
}

export async function GET() {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;

  const supabase = await createClient();
  const view = await loadGuests(supabase, {
    coupleId: ctx.membership.coupleId,
    today: new Date().toISOString().slice(0, 10),
  });

  return ok({
    ...view,
    canIssueInvite: canIssueInvite(view.weddingDate),
    inviteNote: INVITE_STATE_NOTE[view.invite],
    inviteShareNotice: INVITE_SHARE_NOTICE,
    privacyNotice: GUEST_PRIVACY_NOTICE,
    seatingNotice: SEATING_DRAFT_NOTICE,
    seatingIssueNote: SEATING_ISSUE_NOTE,
    noEstimateNote: NO_ESTIMATE_NOTE,
  });
}

export async function POST(request: NextRequest) {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "GUEST_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = GuestActionSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();
  const action = parsed.data;

  if (action.action === "create") {
    // 판정은 순수 함수가 갖는다 — 화면과 API 가 같은 문장을 쓴다.
    const issue = guestIssue({
      name: action.name,
      partySize: action.partySize,
      side: action.side,
    });
    if (issue !== null) {
      return fail(422, "GUEST_INVALID_INPUT", GUEST_ISSUE_NOTE[issue], { reason: issue });
    }

    const result = await createGuest(supabase, {
      coupleId: ctx.membership.coupleId,
      userId: ctx.user.id,
      name: action.name,
      side: action.side,
      partySize: action.partySize,
      contact: action.contact,
    });

    if ("status" in result) return fail(result.status, result.code, result.message);

    return ok(result, { status: 201 });
  }

  if (action.action === "update") {
    const result = await updateGuest(supabase, {
      coupleId: ctx.membership.coupleId,
      userId: ctx.user.id,
      guestId: action.guestId,
      name: action.name,
      side: action.side,
      partySize: action.partySize,
      rsvpStatus: action.rsvpStatus,
    });

    if ("status" in result) return fail(result.status, result.code, result.message);

    return ok(result);
  }

  const result = await deleteGuest(supabase, {
    coupleId: ctx.membership.coupleId,
    userId: ctx.user.id,
    guestId: action.guestId,
  });

  if ("status" in result) return fail(result.status, result.code, result.message);

  return ok(result);
}

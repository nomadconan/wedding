import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import {
  INVITE_TTL_HOURS,
  InviteActionSchema,
  InviteCodeSchema,
  inviteBlocker,
} from "@/lib/core/schemas/onboarding";
import { findMyCouple, generateInviteCode } from "@/lib/couple/membership";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * GET/POST /api/couples/invite — 커플 연동 (F-C-02, 명세서 §4.2)
 *
 *   POST { action: "issue" }         초대 코드 발급(owner 전용). 기존 미사용 코드는 만료시킨다
 *   POST { action: "accept", code }  코드로 수락 → partner 로 합류
 *   GET  ?code=...                   코드 검증(수락 전 확인용)
 *
 * **코드 조회는 서비스롤로 한다.** 초대받은 사람은 아직 그 커플의 멤버가 아니라 RLS 로는
 * 코드를 볼 수 없고, 볼 수 있게 만들면 남의 커플 정보가 열린다. 서버가 코드를 검증한 뒤
 * 멤버로 넣어 주는 것이 유일하게 안전한 경로다(0015 주석 참조).
 *
 * **메일 발송은 알림 인프라(S4-13) 대기다.** 지금은 코드를 화면에 띄우고 링크를 복사하게
 * 한다. 발송 지점은 아래 TODO 에 표시해 뒀다.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const raw = request.nextUrl.searchParams.get("code");
  const parsed = InviteCodeSchema.safeParse(raw ?? "");

  if (!parsed.success) {
    return fail(422, "COUPLE_INVITE_INVALID_CODE", "초대 코드 형식을 확인해 주세요.");
  }

  const admin = createAdminClient();
  const { data: invite } = await admin
    .from("couple_invites")
    .select("id, couple_id, expires_at, accepted_by")
    .eq("code", parsed.data)
    .maybeSingle();

  if (!invite) return fail(404, "COUPLE_INVITE_NOT_FOUND", "없는 초대 코드예요.");

  const blocker = inviteBlocker(
    { expiresAt: invite.expires_at, acceptedBy: invite.accepted_by },
    new Date().toISOString(),
  );

  if (blocker) {
    return fail(422, `COUPLE_INVITE_${blocker.code}`, blocker.message);
  }

  // 상대가 이미 커플에 속해 있으면 수락 화면까지 가기 전에 알려 준다.
  const mine = await findMyCouple(user.id);

  // 커플 이름을 노출하지 않는다. 초대가 유효하다는 사실만 알려 준다.
  return ok({
    valid: true,
    expiresAt: invite.expires_at,
    alreadyInCouple: Boolean(mine),
    sameCouple: mine?.coupleId === invite.couple_id,
  });
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "COUPLE_INVITE_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = InviteActionSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();
  const admin = createAdminClient();

  // ── 발급 ──────────────────────────────────────────────────────────────────
  if (parsed.data.action === "issue") {
    const membership = await findMyCouple(user.id);

    if (!membership) {
      return fail(404, "COUPLE_NOT_FOUND", "먼저 온보딩을 마쳐 주세요.");
    }

    if (membership.role !== "owner") {
      return fail(403, "COUPLE_INVITE_FORBIDDEN", "초대는 커플을 만든 사람만 보낼 수 있습니다.");
    }

    const { count } = await admin
      .from("couple_members")
      .select("id", { count: "exact", head: true })
      .eq("couple_id", membership.coupleId)
      .in("member_role", ["owner", "partner"]);

    if ((count ?? 0) >= 2) {
      return fail(409, "COUPLE_ALREADY_PAIRED", "이미 배우자와 연결돼 있어요.");
    }

    // 재발급하면 이전 코드는 죽인다. 살아 있는 코드가 여러 개면 회수할 수 없다.
    await admin
      .from("couple_invites")
      .update({ expires_at: new Date().toISOString() })
      .eq("couple_id", membership.coupleId)
      .is("accepted_by", null)
      .gt("expires_at", new Date().toISOString());

    const code = generateInviteCode();
    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3_600_000).toISOString();

    const { data: created, error } = await supabase
      .from("couple_invites")
      .insert({ couple_id: membership.coupleId, code, expires_at: expiresAt })
      .select("code, expires_at")
      .maybeSingle();

    if (error?.code === "42501" || (!error && !created)) {
      return fail(403, "COUPLE_INVITE_FORBIDDEN", "초대는 커플을 만든 사람만 보낼 수 있습니다.");
    }

    if (error || !created) {
      return fail(500, "COUPLE_INVITE_ISSUE_FAILED", "초대 코드를 만들지 못했습니다.");
    }

    await admin.from("entity_events").insert({
      entity_type: "couple",
      entity_id: membership.coupleId,
      event_type: "couple_invite_issued",
      actor_id: user.id,
      actor_role: user.role,
      source: "web",
    });

    // TODO(S4-13): 알림 인프라가 붙으면 여기서 초대 메일·알림톡을 발송하고
    // notifications 에 발송 이력을 남긴다(D-23 — 발송·수신·열람 분리 기록).

    return ok({ code: created.code, expiresAt: created.expires_at }, { status: 201 });
  }

  // ── 수락 ──────────────────────────────────────────────────────────────────
  const { code } = parsed.data;

  const { data: invite } = await admin
    .from("couple_invites")
    .select("id, couple_id, expires_at, accepted_by")
    .eq("code", code)
    .maybeSingle();

  if (!invite) return fail(404, "COUPLE_INVITE_NOT_FOUND", "없는 초대 코드예요.");

  const blocker = inviteBlocker(
    { expiresAt: invite.expires_at, acceptedBy: invite.accepted_by },
    new Date().toISOString(),
  );

  if (blocker) return fail(422, `COUPLE_INVITE_${blocker.code}`, blocker.message);

  // **이미 커플에 속한 사람은 받을 수 없다.** DB 에도 같은 규칙이 부분 유니크로 걸려 있다.
  const mine = await findMyCouple(user.id);

  if (mine) {
    return fail(
      409,
      "COUPLE_ALREADY_MEMBER",
      mine.coupleId === invite.couple_id
        ? "이미 이 커플에 속해 있어요."
        : "이미 다른 커플에 속해 있어요. 기존 연결을 정리한 뒤 다시 시도해 주세요.",
    );
  }

  // 초대받은 사람은 아직 멤버가 아니라 RLS 로 INSERT 할 수 없다. 서버가 넣어 준다.
  const { error: joinError } = await admin
    .from("couple_members")
    .insert({ couple_id: invite.couple_id, user_id: user.id, member_role: "partner" });

  if (joinError) {
    // 부분 유니크(한 사람 한 커플)에 걸린 경우다.
    if (joinError.code === "23505") {
      return fail(409, "COUPLE_ALREADY_MEMBER", "이미 다른 커플에 속해 있어요.");
    }

    return fail(500, "COUPLE_INVITE_ACCEPT_FAILED", "연결하지 못했습니다.");
  }

  await admin
    .from("couple_invites")
    .update({ accepted_by: user.id, accepted_at: new Date().toISOString() })
    .eq("id", invite.id);

  await admin.from("entity_events").insert({
    entity_type: "couple",
    entity_id: invite.couple_id,
    event_type: "couple_invite_accepted",
    actor_id: user.id,
    actor_role: user.role,
    after_state: "partner",
    source: "web",
  });

  return ok({ coupleId: invite.couple_id, role: "partner" });
}

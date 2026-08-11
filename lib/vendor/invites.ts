import { randomBytes } from "node:crypto";

import { recordEvent } from "@/lib/audit/record";
import { dedupeKey } from "@/lib/core/schemas/notification";
import type { VendorMemberRole } from "@/lib/core/schemas/vendor-member";
import {
  ALREADY_MEMBER_ELSEWHERE_MESSAGE,
  ALREADY_MEMBER_HERE_MESSAGE,
  EMAIL_MISMATCH_MESSAGE,
  VENDOR_INVITE_TOKEN_BYTES,
  emailMatches,
  inviteExpiresAt,
  inviteStatus,
  normalizeEmail,
  vendorInviteBlocker,
} from "@/lib/core/vendor/vendor-invite";
import { sendNotification } from "@/lib/notify/send";
import { createAdminClient } from "@/lib/supabase/admin";
import { findUserByEmail } from "@/lib/vendor/members";

/**
 * 업체 멤버 초대 (S2-09 · F-V-13 잔여)
 *
 * S2-07 이 "가입된 이메일만 연결하고 미가입은 422" 로 남긴 자리를 채운다.
 *
 * ── 어떤 손으로 쓰는가 ──────────────────────────────────────────────────────
 * 초대 발행·거둠은 **세션 클라이언트**다(0026 정책이 owner 로 좁혔다).
 * **수락만 서비스롤**이다 — `vendor_members` INSERT 정책이 owner 전용인데(0005)
 * 초대받은 사람은 owner 가 아니다. 토큰·이메일·만료를 서버가 확인한 뒤 멤버 행을
 * 만든다. §3.9 가 입점 심사에 쓴 "서비스롤 경유" 와 같은 방식이다.
 */
type Client = Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>;

export type InviteFailure = { status: number; code: string; message: string };

/**
 * 토큰.
 *
 * 커플 초대(8자 코드)와 달리 **사람이 옮겨 적지 않는다** — 이메일 링크에 실린다.
 * 그래서 짧을 이유가 없고, 업체 멤버 권한은 가격·정산에 닿으므로(§3.9) 추측에
 * 견디는 길이를 쓴다.
 */
function newToken(): string {
  return randomBytes(VENDOR_INVITE_TOKEN_BYTES).toString("base64url");
}

/** 초대 링크. 발송사 연동 전이라 업체가 직접 전달할 수 있게 화면에도 내보낸다(D-28). */
export function inviteUrl(token: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  return `${base}/vendor/invite/${token}`;
}

async function loadTtlHours(): Promise<number | null> {
  const { data } = await createAdminClient()
    .from("app_settings")
    .select("value_json")
    .eq("key", "vendor_invite.ttl_hours")
    .maybeSingle();

  const hours = Number((data?.value_json as { hours?: unknown } | null)?.hours);

  return Number.isFinite(hours) && hours > 0 ? Math.trunc(hours) : null;
}

// =============================================================================
// 발행
// =============================================================================

export async function inviteMember(
  supabase: Client,
  input: { vendorId: string; actorId: string; email: string; role: VendorMemberRole; now: Date },
): Promise<
  | { inviteId: string; url: string; registered: boolean; alreadySent: boolean }
  | InviteFailure
> {
  const email = normalizeEmail(input.email);

  // ── 이미 이 업체 멤버인가 ─────────────────────────────────────────────────
  const existingUser = await findUserByEmail(email);

  if (existingUser) {
    const admin = createAdminClient();

    const { data: membership } = await admin
      .from("vendor_members")
      .select("vendor_id")
      .eq("user_id", existingUser.id)
      .maybeSingle();

    const row = membership as { vendor_id: string } | null;

    if (row?.vendor_id === input.vendorId) {
      return { status: 409, code: "VENDOR_MEMBER_EXISTS", message: ALREADY_MEMBER_HERE_MESSAGE };
    }

    // 다중 소속을 막는다 — `findMemberVendor()` 가 limit(1) 로 하나만 고르므로
    // 두 업체에 속하면 어느 화면이 뜰지 비결정적이 된다(vendor-invite.ts 주석 참조).
    if (row) {
      return {
        status: 409,
        code: "VENDOR_MEMBER_ELSEWHERE",
        message: ALREADY_MEMBER_ELSEWHERE_MESSAGE,
      };
    }
  }

  // ── 살아 있는 초대가 이미 있으면 재발송으로 다룬다 ────────────────────────
  // 0026 의 부분 유니크가 중복을 막으므로, 먼저 찾아 새 토큰을 끼운다.
  const { data: pending } = await supabase
    .from("vendor_invites")
    .select("id")
    .eq("vendor_id", input.vendorId)
    .eq("email", email)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .maybeSingle();

  const token = newToken();
  const expiresAt = inviteExpiresAt(input.now.toISOString(), await loadTtlHours());

  if (pending) {
    const inviteId = (pending as { id: string }).id;

    // 재발행은 서비스롤이다 — 0026 이 UPDATE 를 `revoked_at` 한 컬럼으로 좁혔다.
    const { error } = await createAdminClient()
      .from("vendor_invites")
      .update({ token, expires_at: expiresAt, vendor_role: input.role })
      .eq("id", inviteId);

    if (error) {
      return { status: 500, code: "VENDOR_INVITE_FAILED", message: "초대를 갱신하지 못했어요." };
    }

    await deliver({ inviteId, vendorId: input.vendorId, email, token, userId: existingUser?.id ?? null });

    return {
      inviteId,
      url: inviteUrl(token),
      registered: existingUser !== null,
      alreadySent: true,
    };
  }

  const { data: created, error } = await supabase
    .from("vendor_invites")
    .insert({
      vendor_id: input.vendorId,
      email,
      vendor_role: input.role,
      token,
      expires_at: expiresAt,
      invited_by: input.actorId,
    })
    .select("id")
    .maybeSingle();

  if (error || !created) {
    // 정책이 owner 전용이라 staff 가 부르면 여기서 끊긴다(0026).
    return {
      status: 403,
      code: "VENDOR_INVITE_FORBIDDEN",
      message: "멤버 초대는 대표만 할 수 있어요.",
    };
  }

  const inviteId = (created as { id: string }).id;

  await recordEvent({
    entityType: "vendor_invite",
    entityId: inviteId,
    eventType: "vendor_invite_sent",
    actor: { id: input.actorId, role: "vendor" },
    afterState: "pending",
    // **이메일·토큰을 넣지 않는다**(§7.3). 남길 사실은 어떤 권한으로 불렀는가다.
    memo: input.role,
  });

  await deliver({ inviteId, vendorId: input.vendorId, email, token, userId: existingUser?.id ?? null });

  return { inviteId, url: inviteUrl(token), registered: existingUser !== null, alreadySent: false };
}

/**
 * 발송.
 *
 * ── 가입자와 미가입자를 다르게 다룬다 ───────────────────────────────────────
 * **가입자**: `sendNotification()` 으로 앱 알림함에 남긴다 — 로그인하면 바로 본다.
 * **미가입자**: `notifications` 행을 만들 수 없다. `user_id` 가 `auth.users` FK 라
 * 계정이 없으면 넣을 자리가 없다. 그래서 발송 증적을 `vendor_invites.sent_at` 에
 * 남긴다 — D-23 이 요구하는 것은 **기록**이지 특정 표가 아니다.
 *
 * 실제 메일은 아직 나가지 않는다(D-28). 화면이 그 사실을 적고 링크를 함께 보여준다.
 */
async function deliver(input: {
  inviteId: string;
  vendorId: string;
  email: string;
  token: string;
  userId: string | null;
}): Promise<void> {
  const admin = createAdminClient();

  try {
    if (input.userId) {
      await sendNotification({
        userId: input.userId,
        topic: "vendor_invite",
        channel: "in_app",
        templateKey: "vendor_invite.received",
        // **토큰을 넣지 않는다.** 알림함에 토큰이 있으면 알림 한 건이 곧 업체
        // 접근 열쇠가 된다. 링크는 메일로 가고, 알림은 "왔다" 만 말한다.
        params: { inviteId: input.inviteId },
        dedupeKey: dedupeKey({
          templateKey: "vendor_invite.received",
          subjectId: `${input.inviteId}:${input.userId}`,
        }),
      });
    }

    await admin
      .from("vendor_invites")
      .update({
        sent_at: new Date().toISOString(),
        send_attempts: 1,
        send_failure_reason: null,
      })
      .eq("id", input.inviteId);
  } catch {
    await admin
      .from("vendor_invites")
      .update({ send_failure_reason: "발송 경로에서 오류가 발생했습니다." })
      .eq("id", input.inviteId);

    // 발송 실패가 초대를 되돌리지 않는다 — 링크는 이미 유효하고 재발송할 수 있다.
    console.error("[vendor-invite] delivery failed");
  }
}

// =============================================================================
// 거둠
// =============================================================================

export async function revokeInvite(
  supabase: Client,
  input: { inviteId: string; actorId: string },
): Promise<{ inviteId: string } | InviteFailure> {
  // 0026 이 UPDATE 를 `revoked_at` 컬럼으로 좁혔고 정책은 owner 다.
  const { data, error } = await supabase
    .from("vendor_invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", input.inviteId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();

  if (error) {
    return { status: 403, code: "VENDOR_INVITE_FORBIDDEN", message: "대표만 취소할 수 있어요." };
  }

  if (!data) {
    return {
      status: 409,
      code: "VENDOR_INVITE_NOT_PENDING",
      message: "이미 수락되었거나 취소된 초대예요.",
    };
  }

  await recordEvent({
    entityType: "vendor_invite",
    entityId: input.inviteId,
    eventType: "vendor_invite_revoked",
    actor: { id: input.actorId, role: "vendor" },
    beforeState: "pending",
    afterState: "revoked",
    memo: null,
  });

  return { inviteId: input.inviteId };
}

// =============================================================================
// 수락
// =============================================================================

export type InvitePreview = {
  id: string;
  vendorId: string;
  vendorName: string;
  email: string;
  role: VendorMemberRole;
  status: string;
  expiresAt: string;
};

/**
 * 토큰으로 초대를 찾는다.
 *
 * **서비스롤로 읽는다.** 초대받은 사람은 아직 멤버가 아니고, 로그인 전일 수도 있다.
 * 토큰을 아는 것이 곧 조회 자격이며 — 그래서 토큰이 길다.
 * 내보내는 것은 **업체 이름과 권한까지**다. 이메일은 마스킹해 보낸다.
 */
export async function previewInvite(token: string, now: Date): Promise<InvitePreview | null> {
  const admin = createAdminClient();

  const { data } = await admin
    .from("vendor_invites")
    .select("id, vendor_id, email, vendor_role, expires_at, accepted_at, revoked_at")
    .eq("token", token)
    .maybeSingle();

  if (!data) return null;

  const invite = data as {
    id: string;
    vendor_id: string;
    email: string;
    vendor_role: VendorMemberRole;
    expires_at: string;
    accepted_at: string | null;
    revoked_at: string | null;
  };

  const { data: vendor } = await admin
    .from("vendors")
    .select("name")
    .eq("id", invite.vendor_id)
    .maybeSingle();

  return {
    id: invite.id,
    vendorId: invite.vendor_id,
    vendorName: (vendor as { name?: string } | null)?.name ?? "업체",
    email: maskEmail(invite.email),
    role: invite.vendor_role,
    status: inviteStatus(
      {
        expiresAt: invite.expires_at,
        acceptedAt: invite.accepted_at,
        revokedAt: invite.revoked_at,
      },
      now.toISOString(),
    ),
    expiresAt: invite.expires_at,
  };
}

/** 초대받은 주소를 그대로 보여주지 않는다 — 토큰만 있으면 남의 이메일을 알 수 있게 된다. */
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  const head = local.slice(0, 2);

  return `${head}${"*".repeat(Math.max(1, local.length - 2))}@${domain}`;
}

export async function acceptInvite(input: {
  token: string;
  userId: string;
  userEmail: string | null;
  now: Date;
}): Promise<{ vendorId: string; role: VendorMemberRole } | InviteFailure> {
  const admin = createAdminClient();

  const { data } = await admin
    .from("vendor_invites")
    .select("id, vendor_id, email, vendor_role, expires_at, accepted_at, revoked_at")
    .eq("token", input.token)
    .maybeSingle();

  if (!data) {
    return { status: 404, code: "VENDOR_INVITE_NOT_FOUND", message: "초대를 찾을 수 없어요." };
  }

  const invite = data as {
    id: string;
    vendor_id: string;
    email: string;
    vendor_role: VendorMemberRole;
    expires_at: string;
    accepted_at: string | null;
    revoked_at: string | null;
  };

  const blocker = vendorInviteBlocker(
    {
      expiresAt: invite.expires_at,
      acceptedAt: invite.accepted_at,
      revokedAt: invite.revoked_at,
    },
    input.now.toISOString(),
  );

  if (blocker) {
    return { status: 409, code: `VENDOR_INVITE_${blocker.code}`, message: blocker.message };
  }

  // **초대받은 이메일과 로그인 계정이 같아야 한다.** 토큰이 유출되면 아무나 업체
  // 멤버가 되는데 그건 가격·정산 접근이다(§3.9).
  if (!emailMatches(invite.email, input.userEmail)) {
    return { status: 403, code: "VENDOR_INVITE_EMAIL_MISMATCH", message: EMAIL_MISMATCH_MESSAGE };
  }

  const { data: membership } = await admin
    .from("vendor_members")
    .select("vendor_id")
    .eq("user_id", input.userId)
    .maybeSingle();

  const current = membership as { vendor_id: string } | null;

  if (current?.vendor_id === invite.vendor_id) {
    return { status: 409, code: "VENDOR_MEMBER_EXISTS", message: ALREADY_MEMBER_HERE_MESSAGE };
  }

  if (current) {
    return {
      status: 409,
      code: "VENDOR_MEMBER_ELSEWHERE",
      message: ALREADY_MEMBER_ELSEWHERE_MESSAGE,
    };
  }

  // ── 멤버로 넣는다 (서비스롤) ──────────────────────────────────────────────
  // `vendor_members` INSERT 정책은 owner 전용이다(0005). 초대받은 사람은 owner 가
  // 아니므로 세션으로는 넣을 수 없다 — 서버가 토큰·이메일·만료를 확인한 뒤 넣는다.
  const { error: memberError } = await admin.from("vendor_members").insert({
    vendor_id: invite.vendor_id,
    user_id: input.userId,
    vendor_role: invite.vendor_role,
  });

  if (memberError) {
    return { status: 500, code: "VENDOR_INVITE_ACCEPT_FAILED", message: "합류하지 못했어요." };
  }

  await admin
    .from("vendor_invites")
    .update({ accepted_by: input.userId, accepted_at: input.now.toISOString() })
    .eq("id", invite.id);

  await recordEvent({
    entityType: "vendor_invite",
    entityId: invite.id,
    eventType: "vendor_invite_accepted",
    actor: { id: input.userId },
    beforeState: "pending",
    afterState: "accepted",
    memo: invite.vendor_role,
  });

  await recordEvent({
    entityType: "vendor_member",
    entityId: invite.vendor_id,
    eventType: "vendor_member_joined",
    actor: { id: input.userId },
    afterState: invite.vendor_role,
    memo: "via_invite",
  });

  return { vendorId: invite.vendor_id, role: invite.vendor_role };
}

// =============================================================================
// 목록
// =============================================================================

export async function loadInvites(
  supabase: Client,
  vendorId: string,
  now: Date,
): Promise<
  {
    id: string;
    email: string;
    role: VendorMemberRole;
    status: string;
    expiresAt: string;
    sentAt: string | null;
    acceptedAt: string | null;
    createdAt: string;
    inviteUrl: string | null;
  }[]
> {
  const { data } = await supabase
    .from("vendor_invites")
    .select(
      "id, email, vendor_role, token, expires_at, sent_at, accepted_at, revoked_at, created_at",
    )
    .eq("vendor_id", vendorId)
    .order("created_at", { ascending: false })
    .limit(100);

  return ((data ?? []) as {
    id: string;
    email: string;
    vendor_role: VendorMemberRole;
    token: string;
    expires_at: string;
    sent_at: string | null;
    accepted_at: string | null;
    revoked_at: string | null;
    created_at: string;
  }[]).map((row) => {
    const status = inviteStatus(
      { expiresAt: row.expires_at, acceptedAt: row.accepted_at, revokedAt: row.revoked_at },
      now.toISOString(),
    );

    return {
      id: row.id,
      email: row.email,
      role: row.vendor_role,
      status,
      expiresAt: row.expires_at,
      sentAt: row.sent_at,
      acceptedAt: row.accepted_at,
      createdAt: row.created_at,
      // **살아 있는 초대에만 링크를 내보낸다.** 발송사 연동 전이라 업체가 직접
      // 전달해야 하지만(D-28), 만료·수락된 초대의 토큰까지 보여줄 이유는 없다.
      inviteUrl: status === "pending" ? inviteUrl(row.token) : null,
    };
  });
}

import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { ProfileUpdateSchema, unlinkBlocker } from "@/lib/core/schemas/me";
import { findMyCouple } from "@/lib/couple/membership";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * PUT/DELETE /api/me — 프로필 수정 · 커플 연동 해제 (F-C-23)
 *
 * §4.2 는 `/api/me` 에 `POST /api/me/delete-request` 만 명시한다. 프로필 수정과
 * 연동 해제는 화면(§6.2 `/me`)이 요구하는 동작이라 **같은 경로 아래 메서드로** 붙였다 —
 * API 표면을 새로 늘리는 대신 `/api/me` 하나에 모은다(S2-02 가 미디어 변경을
 * 프로필 PUT 에 실은 것과 같은 방식).
 *
 * **연락처는 해시로만 저장한다**(§7.2·§7.3). 평문을 돌려주는 경로를 만들지 않으며,
 * 그래서 화면은 '등록됨/미등록' 만 말한다 — 마스킹조차 원문이 있어야 만들 수 있다.
 */
export async function PUT(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "ME_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = ProfileUpdateSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const input = parsed.data;
  const supabase = await createClient();

  const values: Record<string, unknown> = {
    display_name: input.displayName,
    marketing_opt_in: input.marketingOptIn,
  };

  // 숫자만 남겨 해시한다. 표기(하이픈·공백)가 달라도 같은 번호는 같은 해시여야 한다.
  if (input.removePhone) {
    values.phone_hash = null;
  } else if (input.phone !== null) {
    values.phone_hash = createHash("sha256").update(input.phone.replace(/\D/g, "")).digest("hex");
  }

  const { data: updated } = await supabase
    .from("profiles")
    .update(values)
    .eq("user_id", user.id)
    .select("user_id");

  if (!updated || updated.length === 0) {
    return fail(403, "ME_PROFILE_FORBIDDEN", "프로필을 수정할 권한이 없습니다.");
  }

  const admin = createAdminClient();
  await admin.from("entity_events").insert({
    entity_type: "profile",
    entity_id: user.id,
    event_type: "profile_updated",
    actor_id: user.id,
    actor_role: user.role,
    // 마케팅 수신 동의의 켜고 끔은 증적으로 남긴다(D-23) — 나중에 "동의한 적 없다" 는
    // 다툼이 생기는 항목이다. 이름·연락처 값은 남기지 않는다(§7.3 증적 최소화).
    after_state: input.marketingOptIn ? "marketing_on" : "marketing_off",
    source: "web",
  });

  return ok({ displayName: input.displayName, marketingOptIn: input.marketingOptIn });
}

/**
 * 커플 연동 해제. **나가는 사람의 멤버 행만 지운다.**
 *
 * 장바구니·찜은 `couple_id` 에 매달린 커플의 것이라 그대로 둔다 — 나가는 사람이
 * 지우면 남는 사람의 준비 기록이 함께 사라진다(`lib/core/schemas/me.ts` 주석 참조).
 */
export async function DELETE() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const membership = await findMyCouple(user.id);
  if (!membership) return fail(404, "COUPLE_NOT_FOUND", "연동된 커플이 없어요.");

  const admin = createAdminClient();
  const { count } = await admin
    .from("couple_members")
    .select("id", { count: "exact", head: true })
    .eq("couple_id", membership.coupleId)
    .in("member_role", ["owner", "partner"]);

  const blocker = unlinkBlocker(membership.role, count ?? 0);
  if (blocker) return fail(409, blocker.code, blocker.message);

  // 자기 멤버 행만 지운다. RLS 는 owner 에게만 DELETE 를 열어 두므로 서비스롤로
  // 수행하고, 지울 수 있는 조건은 위 `unlinkBlocker` 가 이미 판정했다.
  const { error } = await admin
    .from("couple_members")
    .delete()
    .eq("couple_id", membership.coupleId)
    .eq("user_id", user.id);

  if (error) return fail(500, "COUPLE_UNLINK_FAILED", "연동을 해제하지 못했습니다.");

  await admin.from("entity_events").insert({
    entity_type: "couple",
    entity_id: membership.coupleId,
    event_type: "couple_member_left",
    actor_id: user.id,
    actor_role: user.role,
    before_state: membership.role,
    source: "web",
  });

  return ok({ coupleId: membership.coupleId, left: true });
}

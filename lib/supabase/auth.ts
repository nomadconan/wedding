import type { User } from "@supabase/supabase-js";
import { redirect } from "next/navigation";

import { createClient } from "./server";

/**
 * 서버 세션 헬퍼 (S2-01)
 *
 * 명세서 §1.4 NOTE / CLAUDE.md §5.5:
 *   **권한 판정의 최종 경계는 RLS 다.** 여기 있는 함수들은 UX 보조 —
 *   미인증 사용자를 로그인으로 보내고, 권한 없는 화면을 미리 막는 용도다.
 *   이 체크를 통과했다고 데이터 접근이 허용되는 것이 아니다.
 */

/** 운영자 역할. §1.4 의 ops·admin 이다. */
export const OPERATOR_ROLES = ["ops", "admin"] as const;

export type SessionUser = {
  id: string;
  email: string | null;
  /** profiles.role. 프로필 행이 아직 없으면 null 이다. */
  role: string | null;
};

function toSessionUser(user: User, role: string | null): SessionUser {
  return { id: user.id, email: user.email ?? null, role };
}

/** 로그인 상태면 사용자를, 아니면 null 을 돌려준다. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const supabase = await createClient();

  // getUser() 는 쿠키의 JWT 를 서버에서 검증한다. getSession() 은 검증 없이
  // 쿠키 내용을 그대로 믿으므로 인가 판단에 쓰지 않는다.
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("user_id", data.user.id)
    .maybeSingle();

  return toSessionUser(data.user, profile?.role ?? null);
}

/** 미인증이면 로그인 화면으로 보낸다. `next` 로 원래 목적지를 넘긴다. */
export async function requireUser(nextPath: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(nextPath)}`);

  return user;
}

export function isOperator(user: SessionUser | null): boolean {
  return user?.role === "ops" || user?.role === "admin";
}

/**
 * 운영자 전용 화면 가드.
 * 권한이 없으면 로그인 화면으로 보낸다 — 화면의 존재 여부를 알려주지 않기 위해서다.
 */
export async function requireOperator(nextPath: string): Promise<SessionUser> {
  const user = await requireUser(nextPath);
  if (!isOperator(user)) redirect(`/login?next=${encodeURIComponent(nextPath)}&denied=1`);

  return user;
}

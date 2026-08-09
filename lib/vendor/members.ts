import type { VendorMemberRole } from "@/lib/core/schemas/vendor-member";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 업체 멤버 조회 공통 조각 (S2-07)
 *
 * 이메일은 `auth.users` 에 있고 클라이언트에서 조회할 수 없다. 그래서 **서비스롤**로 읽되
 * 대상은 항상 "이 업체의 멤버" 로 좁힌다 — 다른 업체 사용자의 이메일이 새지 않게 한다.
 */
export type VendorMemberView = {
  id: string;
  userId: string;
  role: VendorMemberRole;
  displayName: string | null;
  email: string | null;
  joinedAt: string;
  /** 계정이 이메일 인증을 마쳤는가. 미인증이면 아직 로그인하지 못한다. */
  confirmed: boolean;
};

/** 이메일로 가입 사용자를 찾는다. 없으면 null — 미가입자 초대는 S2-09 다. */
export async function findUserByEmail(
  email: string,
): Promise<{ id: string; email: string } | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) throw new Error("Supabase 서버 환경변수가 없습니다.");

  // auth.users 는 PostgREST 로 노출되지 않는다. Admin REST 를 그대로 쓴다.
  const response = await fetch(`${url}/auth/v1/admin/users?per_page=200`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store",
  });

  if (!response.ok) return null;

  const body = (await response.json()) as { users?: { id: string; email?: string }[] };
  const found = (body.users ?? []).find(
    (user) => (user.email ?? "").toLowerCase() === email.toLowerCase(),
  );

  return found?.email ? { id: found.id, email: found.email } : null;
}

/** 업체 멤버 목록. 대표를 먼저, 그다음 가입 순으로 보여준다. */
export async function loadVendorMembers(vendorId: string): Promise<VendorMemberView[]> {
  const admin = createAdminClient();

  const { data: members } = await admin
    .from("vendor_members")
    .select("id, user_id, vendor_role, created_at")
    .eq("vendor_id", vendorId)
    .order("vendor_role", { ascending: true })
    .order("created_at", { ascending: true });

  if (!members || members.length === 0) return [];

  const userIds = members.map((member) => member.user_id);

  const { data: profiles } = await admin
    .from("profiles")
    .select("user_id, display_name")
    .in("user_id", userIds);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const accounts = new Map<string, { email: string | null; confirmed: boolean }>();

  if (url && key) {
    const response = await fetch(`${url}/auth/v1/admin/users?per_page=200`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: "no-store",
    });

    if (response.ok) {
      const body = (await response.json()) as {
        users?: { id: string; email?: string; email_confirmed_at?: string | null }[];
      };

      for (const user of body.users ?? []) {
        if (!userIds.includes(user.id)) continue;

        accounts.set(user.id, {
          email: user.email ?? null,
          confirmed: Boolean(user.email_confirmed_at),
        });
      }
    }
  }

  return members.map((member) => ({
    id: member.id,
    userId: member.user_id,
    role: member.vendor_role as VendorMemberRole,
    displayName: profiles?.find((row) => row.user_id === member.user_id)?.display_name ?? null,
    email: accounts.get(member.user_id)?.email ?? null,
    joinedAt: member.created_at,
    confirmed: accounts.get(member.user_id)?.confirmed ?? false,
  }));
}

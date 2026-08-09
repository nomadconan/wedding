import { INVITE_CODE_ALPHABET, INVITE_CODE_LENGTH } from "@/lib/core/schemas/onboarding";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 커플 공통 조각 (S3-01)
 *
 * `route.ts` 는 HTTP 메서드 외의 export 를 허용하지 않으므로 공유물을 여기에 둔다.
 */

/** 세션 사용자가 속한 커플. owner·partner 만 본다(플래너는 위임이지 소속이 아니다). */
export async function findMyCouple(
  userId: string,
): Promise<{ coupleId: string; role: string } | null> {
  const admin = createAdminClient();

  const { data } = await admin
    .from("couple_members")
    .select("couple_id, member_role")
    .eq("user_id", userId)
    .in("member_role", ["owner", "partner"])
    .limit(1)
    .maybeSingle();

  return data ? { coupleId: data.couple_id, role: data.member_role } : null;
}

/**
 * 초대 코드 생성.
 *
 * 사람이 불러 주는 코드라 헷갈리는 글자(O·0·I·1)를 뺀 알파벳을 쓴다.
 * `crypto.getRandomValues` 로 만든다 — 초대 코드는 남의 커플에 들어가는 열쇠라
 * 예측 가능한 난수를 쓰면 안 된다.
 */
export function generateInviteCode(): string {
  const bytes = new Uint32Array(INVITE_CODE_LENGTH);
  crypto.getRandomValues(bytes);

  return [...bytes].map((value) => INVITE_CODE_ALPHABET[value % INVITE_CODE_ALPHABET.length]).join("");
}

import { findMyCouple } from "@/lib/couple/membership";

/**
 * 해지 절차에서 어느 편인가 (S5-08)
 *
 * **입력으로 받지 않고 세션으로 판정한다.** S4-07 의 이행 확인이 세운 규칙 그대로다 —
 * 받으면 고객이 업체 칸에 답하는 요청을 만들 수 있고, 트리거가 막더라도 그런 모양의
 * API 를 두지 않는다.
 *
 * **커플은 소유자만이다.** §3.9 가 결제·계약 서명에 owner 조건을 걸었고, 해지는 그
 * 둘보다 되돌리기 어렵다. 배우자는 절차를 **볼 수는** 있지만 결론을 내지 않는다.
 */
type Reader = Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>;

export type PartySide = "couple" | "vendor";

export async function resolvePartySide(input: {
  userId: string;
  coupleId: string;
  vendorId: string;
  supabase: Reader;
}): Promise<PartySide | null> {
  const membership = await findMyCouple(input.userId);

  if (membership?.coupleId === input.coupleId) {
    return membership.role === "owner" ? "couple" : null;
  }

  const { data: member } = await input.supabase
    .from("vendor_members")
    .select("vendor_id")
    .eq("vendor_id", input.vendorId)
    .eq("user_id", input.userId)
    .maybeSingle();

  return member ? "vendor" : null;
}

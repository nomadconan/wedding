import type { SupabaseClient } from "@supabase/supabase-js";

import { findMyCouple } from "@/lib/couple/membership";
import { createPublicClient } from "@/lib/explore/query";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/supabase/auth";

/**
 * 툴 실행 맥락 (S7-20 · 명세서 §5.6)
 *
 * **스코프는 세션이 정한다. 모델이 정하지 않는다.**
 * 툴 인자에 `coupleId` 를 두지 않은 이유가 여기 있다 — 모델이 넘긴 id 를 그대로 쓰면
 * 그 값이 곧 권한 경계가 되고, 대화 한 줄로 남의 커플을 읽을 수 있게 된다. 커플 id 는
 * 세션 사용자로부터 유도하고, 조회는 **세션 클라이언트**로 한다.
 *
 * **커플 데이터를 서비스롤로 읽지 않는다.** 서비스롤로 부르면 RLS 가 통째로 비켜서고,
 * 그러면 인가의 최종 경계가 툴 코드의 `eq("couple_id", …)` 한 줄이 된다. 그 줄을
 * 빠뜨린 날 아무 일도 일어나지 않는다 — 조용히 남의 데이터가 나간다.
 * (요율·운영 파라미터처럼 커플과 무관한 참조 데이터만 `reference.ts` 가 따로 읽는다.)
 *
 * `asOf` 는 **호출자가 만들어 넘긴다.** 툴 안에서 `new Date()` 를 부르면 같은 대화가
 * 자정을 넘기며 다른 답을 내고, 그 차이를 사용자가 재현할 수 없다(S2-06·S7-02 규칙).
 */
export type ToolContext = {
  userId: string;
  /** 온보딩 전이면 null 이다. 커플 스코프 툴은 그때 `no_couple` 로 답한다. */
  coupleId: string | null;
  /** 커플 데이터용 — RLS 가 적용되는 세션 클라이언트. */
  supabase: SupabaseClient;
  /** 공개 데이터용(업체·상품·참가격) — 익명 클라이언트. */
  publicClient: SupabaseClient;
  /** 기준일 YYYY-MM-DD. 응답에 실어 돌려준다. */
  asOf: string;
};

export async function buildToolContext(options: { asOf?: string } = {}): Promise<ToolContext | null> {
  const user = await getSessionUser();
  if (!user) return null;

  const membership = await findMyCouple(user.id);
  const supabase = (await createClient()) as unknown as SupabaseClient;

  return {
    userId: user.id,
    coupleId: membership?.coupleId ?? null,
    supabase,
    publicClient: createPublicClient(),
    asOf: options.asOf ?? new Date().toISOString().slice(0, 10),
  };
}

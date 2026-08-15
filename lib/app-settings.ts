import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 운영 파라미터 읽기 (§7.4)
 *
 * **행이 없으면 null 이다.** 코드가 숫자를 지어내지 않는다 — 지어낸 비율로 회차를
 * 나누거나 지어낸 기한으로 서명을 마감할 수는 없다. 값이 없을 때 무엇을 할지는
 * 호출부가 정하며, 대개는 "그 작업을 세우지 않는다" 이다(`resolveSplitPlans` ·
 * `feeBasisOf` 가 같은 규칙으로 실패를 돌려준다).
 *
 * 이 파일이 생긴 이유 — 같은 세 줄이 `lib/consultation/loader.ts`·`lib/cart/loader.ts`
 * 등에 흩어져 있었다. S5-06 이 네 번째 사본을 만들 차례가 되어 한 곳으로 모은다
 * (D-11 "기록 래퍼는 소비처 생성 시점에 만든다" 와 같은 판단이다).
 * 기존 사본은 각자의 로더가 도메인 값으로 바꿔 쓰고 있어 이번에 건드리지 않는다.
 */
export async function readSetting(key: string): Promise<Record<string, unknown> | null> {
  const { data } = await createAdminClient()
    .from("app_settings")
    .select("value_json")
    .eq("key", key)
    .maybeSingle();

  return (data?.value_json ?? null) as Record<string, unknown> | null;
}

/**
 * 정수 파라미터. 값이 없거나 정수가 아니면 null 이며 호출부가 판단한다.
 *
 * **`null` 을 0 으로 읽지 않는다(S7-17 에서 물렸다).** `seed.sql`·마이그레이션은 미결
 * 파라미터를 `{"value": null, "status": "undecided"}` 로 넣는데, `Number(null)` 은 **0**
 * 이고 `Number.isInteger(0)` 은 참이다 — 그래서 "값이 없다" 가 "값이 0 이다" 로 조용히
 * 바뀌었다. 기한이 0시간이면 **모든 건이 기한 초과**가 되고, 유예가 0일이면 **오늘
 * 지급 대상**이 된다. 미결 파라미터를 읽는 모든 호출부가 같은 함정을 지나므로 여기서
 * 막는다(§7.4 · CLAUDE.md §7.6 — 값이 없으면 코드가 고르지 않는다).
 */
export async function readIntSetting(key: string, field: string): Promise<number | null> {
  const raw = (await readSetting(key))?.[field];

  // null·undefined·빈 문자열은 **미결**이다. 숫자로 변환하기 전에 걸러낸다.
  if (raw === null || raw === undefined || raw === "") return null;

  const value = Number(raw);

  return Number.isInteger(value) ? value : null;
}

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

/** 정수 파라미터. 값이 없거나 정수가 아니면 null 이며 호출부가 판단한다. */
export async function readIntSetting(key: string, field: string): Promise<number | null> {
  const value = Number((await readSetting(key))?.[field]);

  return Number.isInteger(value) ? value : null;
}

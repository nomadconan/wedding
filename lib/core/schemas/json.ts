// jsonb 로 들어갈 값의 zod 스키마 (FIX-67)
//
// **`z.record(z.unknown())` 은 JSON 을 뜻하지 않는다.** `unknown` 은 무엇이든 될 수
// 있어서, 그 결과를 `jsonb` 칸에 넣으려면 단언을 붙여야 하고 **단언을 붙이는 순간
// 함수·undefined·순환 참조까지 같이 통과한다**. 그런 값은 `JSON.stringify` 에서
// 조용히 사라지거나(함수·undefined) 던진다(순환) — 둘 다 저장 시점이 아니라
// 나중에 드러난다.
//
// 그래서 **모양을 실제로 검증한다.** 단언이 아니라 파싱이므로, 통과한 값은 정말로
// JSON 이다(§6 — API 입출력은 zod 로 양방향 검증한다).

import { z } from "zod";

import type { JsonValue } from "../json";

/**
 * JSON 값. 재귀라 `z.lazy` 로 묶는다.
 *
 * `z.record` 는 키가 없는 객체도 통과시키므로 `{}` 도 유효한 JSON 객체다 — 맞다.
 */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

/** JSON 객체. `options_json` 처럼 객체가 와야 하는 칸에 쓴다. */
export const jsonObjectSchema = z.record(jsonValueSchema);

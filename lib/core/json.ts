/**
 * JSON 값 (FIX-67)
 *
 * `jsonb` 칸에 넣을 값의 모양이다. **`Record<string, unknown>` 은 이 자리에 못 쓴다** —
 * `unknown` 은 JSON 이라는 것을 증명하지 못해서, 생성된 `Json` 을 기대하는 칸에
 * 넘길 수 없다. 넘기려고 단언을 붙이면 그때부터 아무 값이나 통과한다.
 *
 * **왜 `types/database.ts` 의 `Json` 을 그대로 안 쓰는가.** 여기는 `lib/core` 이고
 * 프레임워크·생성물에 기대지 않는 것이 이 폴더의 조건이다(CLAUDE.md §3.1 — Expo 전환
 * 대비). 대신 **같은 모양인지를 테스트가 지킨다**(`json.test.ts`) — `lib/core/schemas`
 * 가 `finding_severity` enum 을 다루는 방식과 같다. 모양이 갈리면 테스트가 먼저 깨진다.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue | undefined }
  | JsonValue[];

/** JSON 객체. `before_json`·`after_json` 처럼 객체가 와야 하는 칸에 쓴다. */
export type JsonObject = { [key: string]: JsonValue | undefined };

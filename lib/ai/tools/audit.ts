import { createAdminClient } from "@/lib/supabase/admin";

import type { ToolCallAudit } from "./registry";

/**
 * 툴 호출 감사 (S7-20 · 명세서 §3.6 `ai_tool_calls` · §5.6)
 *
 * **서비스롤이 적는다.** `ai_tool_calls` 에는 INSERT 정책이 없다(0005) — 정책이
 * 없다는 것이 곧 "클라이언트는 못 쓴다" 는 뜻이며, 열람만 상위 메시지 스코프로 열려
 * 있다. 커플은 자기 대화의 툴 호출을 볼 수 있고 남의 것은 못 본다.
 *
 * **메시지가 있어야 기록이 선다.** `message_id` 는 NOT NULL 이므로 이 함수는 대화가
 * 메시지를 저장한 뒤에 불린다(S7-06). 레지스트리는 감사 **레코드를 만들기만** 하고
 * 적는 시점은 대화가 정한다 — 그래야 툴 실행이 대화 저장 실패에 끌려가지 않는다.
 *
 * **적재 실패가 본 작업을 깨뜨리지 않는다**(`lib/audit/record.ts` 와 같은 규칙).
 * 다만 조용히 삼키지도 않는다 — **식별자만** 남긴다. 인자·결과를 로그에 실으면
 * §5.3 을 어긴다.
 */
export async function recordToolCalls(
  messageId: string,
  calls: readonly ToolCallAudit[],
): Promise<void> {
  if (calls.length === 0) return;

  const { error } = await createAdminClient()
    .from("ai_tool_calls")
    .insert(
      calls.map((call) => ({
        message_id: messageId,
        tool_name: call.toolName,
        arguments_json: call.argumentsJson,
        // 상태와 개수뿐이다. 조회 결과 본문을 감사 표에 복사하지 않는다.
        result_summary: call.resultSummary,
        latency_ms: call.latencyMs,
        error: call.error,
      })),
    );

  if (error) {
    console.error("[ai_tool_calls] insert failed", {
      toolCount: calls.length,
      code: error.code,
    });
  }
}

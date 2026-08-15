import type { NextRequest } from "next/server";

import { recordEvent } from "@/lib/audit/record";
import { fail, failValidation } from "@/lib/api/response";
import { conversationGate } from "@/lib/core/ai/limits";
import { AI_DISCLAIMER } from "@/lib/core/legal";
import { PlannerTurnSchema, type PlannerEvent } from "@/lib/core/schemas/planner-chat";
import {
  appendMessage,
  createConversation,
  loadMessages,
  ownsConversation,
  sessionTokens,
  turnsUsedToday,
} from "@/lib/ai/planner/conversation";
import { plannerMode, runPlannerTurn, saveToolAudits } from "@/lib/ai/planner/run";
import { buildToolContext } from "@/lib/ai/tools/context";
import { aiLimitSettings } from "@/lib/ai/tools/reference";
import { findMyCouple } from "@/lib/couple/membership";
import { getSessionUser } from "@/lib/supabase/auth";

/**
 * POST /api/ai/planner — 플래너 대화 (F-C-03, 명세서 §4.2 · §5.6)
 *
 * **응답이 SSE 라 실패를 두 자리에서 다르게 낸다.** 스트림이 열리기 전의 실패(로그인·
 * 입력·상한)는 표준 포맷(`{ ok, error }`)으로 상태 코드와 함께 답하고, 열린 뒤의 실패는
 * `event: error` 로 나간다 — 스트림이 시작되면 상태 코드를 바꿀 수 없다.
 *
 * **상한을 먼저 본다.** 턴·토큰 상한은 아무것도 저장하기 전에 판정해야 한다. 사용자
 * 메시지를 먼저 넣고 막으면 **막힌 턴이 사용량으로 계산**되고, 그러면 상한이 실제보다
 * 하루 일찍 온다. 값이 없으면 **열지 않는다**(S7-20 · D-49 — 없는 상한을 무제한으로
 * 읽으면 비용 상한이 사라진다).
 *
 * **Claude 호출은 이 서버에서만 한다**(CLAUDE.md §3.1·§5.4). 키는 클라이언트로 나가지
 * 않으며 화면은 이 라우트만 부른다.
 *
 * 쓰기가 있지만 `Idempotency-Key` 를 요구하지 않는다 — 같은 문장을 두 번 보내는 것은
 * 대화에서 정상 행위이고, 중복을 막으면 "네" 를 두 번 못 말한다. 대신 **상한이** 반복
 * 호출의 비용을 막는다.
 */
export const dynamic = "force-dynamic";

/** 멤버십 등급. **S7-11 전까지 모두 무료**다 — 등급을 지어내지 않는다. */
const MEMBERSHIP_TIER = "free";

function sseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // 프록시가 버퍼링하면 문장이 한꺼번에 도착해 스트리밍이 무의미해진다.
    "X-Accel-Buffering": "no",
  };
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const membership = await findMyCouple(user.id);
  if (!membership) {
    return fail(404, "AI_COUPLE_NOT_FOUND", "먼저 온보딩을 마쳐 주세요.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "AI_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = PlannerTurnSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const { conversationId: requestedId, message } = parsed.data;

  // **남의 대화에 이어 쓰지 못한다.** id 만 믿지 않고 커플 소유를 먼저 확인한다.
  if (requestedId !== undefined && !(await ownsConversation(membership.coupleId, requestedId))) {
    return fail(404, "AI_CONVERSATION_NOT_FOUND", "대화를 찾을 수 없습니다.");
  }

  const asOf = new Date().toISOString().slice(0, 10);
  const limits = await aiLimitSettings();

  const gate = conversationGate({
    usedToday: await turnsUsedToday(membership.coupleId, asOf),
    sessionTokens: await sessionTokens(requestedId ?? null),
    freeDailyTurns: limits.freeDailyTurns,
    sessionTokenCap: limits.sessionTokenCap,
    membership: MEMBERSHIP_TIER,
  });

  if (!gate.ok) {
    // 막힌 사실을 남긴다 — 남용 탐지·비용 분석의 근거다(§5.6). 본문은 담지 않는다.
    await recordEvent({
      entityType: "ai_conversation",
      entityId: requestedId ?? membership.coupleId,
      eventType: "ai_turn_blocked",
      actor: { id: user.id },
      afterState: gate.reason,
      memo: `limit:${gate.reason}`,
    });

    return fail(429, "AI_TURN_LIMIT", gate.notice, { reason: gate.reason });
  }

  const ctx = await buildToolContext({ asOf });
  if (ctx === null) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const history = requestedId === undefined ? [] : await loadMessages(requestedId);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: PlannerEvent, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      let conversationId = requestedId ?? null;

      try {
        if (conversationId === null) {
          conversationId = await createConversation({
            coupleId: membership.coupleId,
            firstMessage: message,
            // 그 시점의 맥락을 박는다(§3.6) — 나중에 예산이 바뀌어도 재현할 수 있어야 한다.
            contextSnapshot: { asOf, mode: plannerMode(), promptVersion: "planner@1" },
          });

          if (conversationId !== null) {
            await recordEvent({
              entityType: "ai_conversation",
              entityId: conversationId,
              eventType: "ai_conversation_opened",
              actor: { id: user.id },
              afterState: "open",
            });
          }
        }

        send("meta", {
          conversationId,
          mode: plannerMode(),
          turnsRemaining: gate.turnsRemaining,
          // AI 결과가 포함된 응답이라 고지를 함께 싣는다(CLAUDE.md §2.3).
          disclaimer: AI_DISCLAIMER,
        });

        if (conversationId === null) {
          send("error", { message: "대화를 시작하지 못했어요. 잠시 후 다시 시도해 주세요." });
          send("done", {});
          controller.close();

          return;
        }

        await appendMessage({ conversationId, role: "user", content: message });

        const outcome = await runPlannerTurn({
          ctx,
          message,
          history,
          emit: send,
        });

        const messageId = await appendMessage({
          conversationId,
          role: "assistant",
          content: outcome.text,
          cards: outcome.cards,
          tokenIn: outcome.tokenIn,
          tokenOut: outcome.tokenOut,
        });

        await saveToolAudits(messageId, outcome.audits);

        send("done", { conversationId });
      } catch {
        // 예외를 그대로 흘리지 않는다 — 스택·쿼리에 식별자가 실릴 수 있다(§5.3).
        send("error", { message: "대화를 이어 가지 못했어요. 잠시 후 다시 시도해 주세요." });
        send("done", {});
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}

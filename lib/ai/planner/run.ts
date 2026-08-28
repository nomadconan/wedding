import {
  FALLBACK_GUIDE_REPLY,
  FALLBACK_MODE_NOTICE,
  FALLBACK_SEARCH_REPLY,
  detectIrreversibleRequest,
  planWithoutModel,
  toolCard,
  type ToolCard,
} from "@/lib/core/ai/conversation";
import { POSTCHECK_FALLBACK, buildPostcheckFeedback, checkResponse } from "@/lib/core/ai/postcheck";
import { PLANNER_PROMPT_VERSION, buildRegenerateInstruction } from "@/lib/core/ai/prompt";
import { createSentenceGate } from "@/lib/core/ai/stream";
import { parseSearchQuery } from "@/lib/core/search/parse";
import type { PlannerEvent, PlannerMode } from "@/lib/core/schemas/planner-chat";

import { recordToolCalls } from "@/lib/ai/tools/audit";
import type { ToolContext } from "@/lib/ai/tools/context";
import {
  plannerSystemPrompt,
  registeredTools,
  runTool,
  type ToolCallAudit,
} from "@/lib/ai/tools/registry";

import type { StoredMessage } from "./conversation";

/**
 * 한 턴을 돌린다 (S7-06 · 명세서 §5.6 · §4.2 `POST /api/ai/planner`)
 *
 * **모델이 없어도 대화가 선다.** `ANTHROPIC_API_KEY` 가 없으면 S7-02 가 만든 룰
 * 파서로 조건을 읽어 `search_vendors` 를 그대로 부르고, **코드가 가진 고정 문구**로
 * 답한다. 대화형 답변만 없을 뿐 조회는 된다 — 그리고 그 모드에서는 모델이 쓴 문장이
 * 없으므로 지어낸 수치가 생길 자리도 없다(D-28 계열).
 *
 * **되돌릴 수 없는 요청은 모델에게 가기 전에 걸러낸다.** 프롬프트가 금지해도 지켜지지
 * 않을 수 있고, 그때의 증상이 결제·서명이다. 입력에서 먼저 알아채고 안내로 답한다.
 *
 * **툴 결과가 이번 턴의 허용 목록이다.** 후처리는 이 배열에 없는 수치·이름을 반려한다.
 * 그래서 **이전 턴의 툴 결과를 다시 보내지 않는다** — 지난 조회의 값이 이번 문장에
 * 나오면 그 문장은 (옳게도) 반려되고, 사용자에게는 이유 없는 실패로 보인다.
 */

export type PlannerEmit = (event: PlannerEvent, data: unknown) => void;

export type TurnOutcome = {
  mode: PlannerMode;
  /** 저장할 최종 본문. 빈 문자열이면 저장하지 않는다. */
  text: string;
  cards: ToolCard[];
  audits: ToolCallAudit[];
  tokenIn: number;
  tokenOut: number;
  /**
   * 실제로 부른 모델. 룰만 쓴 턴은 `null` 이다(S8-07).
   *
   * **라우트가 `lib/ai/client` 를 정적 import 하지 않게** 하려고 여기서 돌려준다 —
   * 그쪽은 SDK 를 끌어오므로 키가 없는 환경에서도 번들에 들어간다. 이 파일은 이미
   * 동적 import 로 그것을 피하고 있고, 그 판단을 라우트가 깨뜨리면 안 된다.
   */
  model: string | null;
};

/** 툴 왕복 상한. 넘으면 그 턴은 지금까지 모은 것으로 답한다. */
const MAX_TOOL_STEPS = 4;
const MAX_TOKENS = 1_024;
/** 사람이 기다리는 화면이다. 모델이 오래 걸리면 그 턴을 접는다. */
const REQUEST_TIMEOUT_MS = 60_000;

export function plannerMode(): PlannerMode {
  return (process.env.ANTHROPIC_API_KEY ?? "") === "" ? "rules_only" : "model";
}

export async function runPlannerTurn(input: {
  ctx: ToolContext;
  message: string;
  history: readonly StoredMessage[];
  emit: PlannerEmit;
}): Promise<TurnOutcome> {
  const mode = plannerMode();

  // ── 되돌릴 수 없는 요청 ───────────────────────────────────────────────────
  const irreversible = detectIrreversibleRequest(input.message);

  if (irreversible !== null) {
    input.emit("delta", { text: irreversible.notice });

    return { mode, text: irreversible.notice, cards: [], audits: [], tokenIn: 0, tokenOut: 0, model: null };
  }

  if (mode === "rules_only") return runWithoutModel(input);

  return runWithModel(input);
}

// =============================================================================
// 룰만으로 (키 없음)
// =============================================================================

async function runWithoutModel(input: {
  ctx: ToolContext;
  message: string;
  emit: PlannerEmit;
}): Promise<TurnOutcome> {
  const rule = parseSearchQuery(input.message, { asOf: input.ctx.asOf });
  const plan = planWithoutModel({
    text: input.message,
    fields: rule.conditions.map((condition) => condition.field),
  });

  if (plan.kind === "guide") {
    const text = `${FALLBACK_GUIDE_REPLY}\n${FALLBACK_MODE_NOTICE}`;
    input.emit("delta", { text });

    return { mode: "rules_only", text, cards: [], audits: [], tokenIn: 0, tokenOut: 0, model: null };
  }

  const run = await runTool("search_vendors", { query: plan.query }, input.ctx);
  const card = toolCard("search_vendors", run.result, run.rankingBasis);

  input.emit("card", card);

  const text = `${FALLBACK_SEARCH_REPLY}\n${FALLBACK_MODE_NOTICE}`;
  input.emit("delta", { text });

  return {
    mode: "rules_only",
    text,
    cards: [card],
    audits: [run.audit],
    tokenIn: 0,
    tokenOut: 0,
    model: null,
  };
}

// =============================================================================
// 모델
// =============================================================================

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

type Turn = { role: "user" | "assistant"; content: string | Block[] };

/** 지난 턴은 **본문만** 넘긴다. 툴 결과를 다시 실으면 이번 턴의 허용 목록이 흐려진다. */
function toTranscript(history: readonly StoredMessage[]): Turn[] {
  return history
    .filter((row) => (row.role === "user" || row.role === "assistant") && (row.content ?? "") !== "")
    .map((row) => ({ role: row.role as "user" | "assistant", content: row.content ?? "" }));
}

async function runWithModel(input: {
  ctx: ToolContext;
  message: string;
  history: readonly StoredMessage[];
  emit: PlannerEmit;
}): Promise<TurnOutcome> {
  // 키가 있을 때만 SDK 를 끌어온다 — 최상단에서 만들면 키 없는 환경의 import 가 깨진다(S7-02).
  const { anthropic, AI_MODEL } = await import("@/lib/ai/client");

  const tools = registeredTools();
  const system = plannerSystemPrompt();

  const messages: Turn[] = [...toTranscript(input.history), { role: "user", content: input.message }];

  // 이번 턴의 허용 목록. 배열을 그대로 게이트에 넘겨 **조회가 끝나는 대로 넓어진다.**
  const toolResults: unknown[] = [];
  const rankingBasis: { code: string; label: string }[] = [];
  const cards: ToolCard[] = [];
  const audits: ToolCallAudit[] = [];

  let tokenIn = 0;
  let tokenOut = 0;
  let emittedAnything = false;

  const gate = createSentenceGate({ toolResults, userText: input.message, rankingBasis });

  for (let step = 1; step <= MAX_TOOL_STEPS; step += 1) {
    const stream = anthropic.messages.stream(
      {
        model: AI_MODEL,
        max_tokens: MAX_TOKENS,
        system,
        tools: tools as never,
        messages: messages as never,
      },
      { timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 },
    );

    let violated = false;

    for await (const event of stream) {
      const raw = event as { type: string; delta?: { type?: string; text?: string } };

      if (raw.type !== "content_block_delta" || raw.delta?.type !== "text_delta") continue;

      for (const gateEvent of gate.push(raw.delta.text ?? "")) {
        if (gateEvent.kind === "emit") {
          emittedAnything = true;
          input.emit("delta", { text: gateEvent.text });
          continue;
        }

        violated = true;
      }

      if (violated) break;
    }

    const final = await stream.finalMessage();

    tokenIn += final.usage?.input_tokens ?? 0;
    tokenOut += final.usage?.output_tokens ?? 0;

    if (violated) {
      // **폐기하고 1회 재생성**(§5.6). 이미 내보낸 것이 있으면 화면에서 지운다.
      return regenerate({
        ...input,
        messages,
        system,
        tools,
        toolResults,
        rankingBasis,
        cards,
        audits,
        tokenIn,
        tokenOut,
        emittedAnything,
        violations: buildPostcheckFeedback(
          checkResponse({ text: gate.emitted(), toolResults, userText: input.message }).violations,
        ),
      });
    }

    const blocks = (final.content ?? []) as Block[];
    const toolUses = blocks.filter(
      (block): block is Extract<Block, { type: "tool_use" }> => block.type === "tool_use",
    );

    if (toolUses.length === 0 || step === MAX_TOOL_STEPS) break;

    messages.push({ role: "assistant", content: blocks });

    const results: Block[] = [];

    for (const use of toolUses) {
      const run = await runTool(use.name, use.input, input.ctx);

      toolResults.push(run.result);
      rankingBasis.push(...run.rankingBasis);
      audits.push(run.audit);

      const card = toolCard(use.name, run.result, run.rankingBasis);
      cards.push(card);
      input.emit("card", card);

      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: JSON.stringify(run.result),
      });
    }

    messages.push({ role: "user", content: results });
  }

  for (const gateEvent of gate.finish()) {
    if (gateEvent.kind === "emit") {
      emittedAnything = true;
      input.emit("delta", { text: gateEvent.text });
      continue;
    }

    // 전체 본문 검사에서 걸렸다 — 내보낸 것을 지우고 다시 쓴다.
    return regenerate({
      ...input,
      messages,
      system,
      tools,
      toolResults,
      rankingBasis,
      cards,
      audits,
      tokenIn,
      tokenOut,
      emittedAnything,
      violations: buildPostcheckFeedback(gateEvent.violations),
    });
  }

  return { mode: "model", text: gate.emitted().trim(), cards, audits, tokenIn, tokenOut, model: AI_MODEL };
}

/**
 * 재생성 — **한 번만**.
 *
 * 스트리밍하지 않는다. 두 번째 시도는 이미 규칙을 어긴 뒤라 **전체를 받아 한 번에
 * 검사**하는 편이 안전하고, 흔한 길도 아니다. 여기서도 걸리면 대체 문장으로 내려간다 —
 * **부분적으로 맞는 응답을 그대로 내보내지 않는다**(§5.1).
 */
async function regenerate(input: {
  emit: PlannerEmit;
  message: string;
  messages: Turn[];
  system: string;
  tools: unknown[];
  toolResults: unknown[];
  rankingBasis: { code: string; label: string }[];
  cards: ToolCard[];
  audits: ToolCallAudit[];
  tokenIn: number;
  tokenOut: number;
  emittedAnything: boolean;
  violations: string;
}): Promise<TurnOutcome> {
  if (input.emittedAnything) input.emit("discard", { reason: "postcheck" });

  const { anthropic, AI_MODEL } = await import("@/lib/ai/client");

  let text = "";
  let tokenIn = input.tokenIn;
  let tokenOut = input.tokenOut;

  try {
    const response = await anthropic.messages.create(
      {
        model: AI_MODEL,
        max_tokens: MAX_TOKENS,
        system: input.system,
        messages: [
          ...input.messages,
          { role: "user", content: buildRegenerateInstruction(input.violations) },
        ] as never,
      },
      { timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 },
    );

    tokenIn += response.usage?.input_tokens ?? 0;
    tokenOut += response.usage?.output_tokens ?? 0;

    text = (response.content ?? [])
      .filter((block) => (block as { type: string }).type === "text")
      .map((block) => (block as { text?: string }).text ?? "")
      .join("")
      .trim();
  } catch {
    text = "";
  }

  const verdict =
    text === ""
      ? { ok: false }
      : checkResponse({
          text,
          toolResults: input.toolResults,
          userText: input.message,
          rankingBasis: input.rankingBasis,
        });

  const finalText = verdict.ok ? text : POSTCHECK_FALLBACK;

  input.emit("delta", { text: finalText });

  return {
    mode: "model",
    text: finalText,
    cards: input.cards,
    audits: input.audits,
    tokenIn,
    tokenOut,
    model: AI_MODEL,
  };
}

// =============================================================================
// 감사
// =============================================================================

/** 툴 호출 기록. 메시지가 저장된 뒤에만 설 수 있다(`message_id` NOT NULL · S7-20). */
export async function saveToolAudits(
  messageId: string | null,
  audits: readonly ToolCallAudit[],
): Promise<void> {
  if (messageId === null) return;

  await recordToolCalls(messageId, audits);
}

export { PLANNER_PROMPT_VERSION };

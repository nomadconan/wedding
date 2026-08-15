import { mergeAiConditions, type MergeOutcome } from "@/lib/core/search/ai-merge";
import { hasMeaningfulLeftover, type RuleParseResult } from "@/lib/core/search/parse";
import {
  SEARCH_PARSE_MAX_TOKENS,
  SEARCH_PARSE_PROMPT_VERSION,
  SEARCH_PARSE_SYSTEM,
  buildSearchParseRetryMessage,
  buildSearchParseUserMessage,
} from "@/lib/core/search/prompt";
import type { AiParseSkipReason } from "@/lib/core/schemas/search";

/**
 * 조건 파싱 AI 보조 — **서버 전용** (S7-02 · 명세서 §5.5 1단계)
 *
 * **클라이언트에서 부르지 않는다**(CLAUDE.md §3.1·§5.4). 키는 서버 전용이며 이 모듈은
 * Route Handler·서버 컴포넌트에서만 import 된다.
 *
 * **키가 없으면 룰만으로 검색이 선다.** 이 판단(D-28 계열)이 필요한 첫 자리가 여기다 —
 * 조건 검색은 AI 가 없어도 성립해야 하는 기능이고(룰 파서가 결정적으로 읽는다), 모델은
 * "주차 넉넉한" 같은 **남은 말**을 조건으로 옮겨 주는 보조일 뿐이다. 그래서 실패는 전부
 * **조용한 축소**로 끝난다 — 검색은 되고, 무엇을 못 썼는지만 응답에 남는다.
 *
 * 실패 처리는 CLAUDE.md §8 그대로다: zod 검증 실패 → **1회 재시도**(스키마 오류 피드백
 * 포함) → 재실패 시 **룰 결과만**. 부분 결과를 조건으로 만들지 않는다.
 */

export type AiParseResult =
  | { used: false; reason: AiParseSkipReason; promptVersion: string }
  | { used: true; outcome: MergeOutcome; promptVersion: string; attempts: number };

/** 검색은 사람이 기다리는 화면이다. 모델이 느리면 룰 결과로 내려간다. */
const REQUEST_TIMEOUT_MS = 8_000;

function textOf(message: { content: { type: string; text?: string }[] }): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("")
    .trim();
}

/** 모델이 코드펜스를 붙이는 경우가 있다. JSON 본체만 남긴다. */
function readJson(raw: string): unknown {
  const unfenced = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

  try {
    return JSON.parse(unfenced);
  } catch {
    return null;
  }
}

export async function parseSearchWithAi(input: {
  text: string;
  rule: RuleParseResult;
  asOf: string;
}): Promise<AiParseResult> {
  const promptVersion = SEARCH_PARSE_PROMPT_VERSION;

  // 키가 없으면 SDK 생성 자체가 던진다. **그 전에** 막고 룰 결과로 돌아간다.
  if ((process.env.ANTHROPIC_API_KEY ?? "") === "") {
    return { used: false, reason: "no_key", promptVersion };
  }

  if (!hasMeaningfulLeftover(input.rule.leftover)) {
    return { used: false, reason: "nothing_left", promptVersion };
  }

  const userMessage = buildSearchParseUserMessage({
    text: input.text,
    leftover: input.rule.leftover,
    filledFields: input.rule.conditions.map((condition) => condition.field),
    asOf: input.asOf,
  });

  try {
    // 키가 있을 때만 SDK 를 끌어온다 — 모듈 최상단에서 만들면 키 없는 환경의 import 가 깨진다.
    const { anthropic, AI_MODEL } = await import("./client");

    const history: { role: "user" | "assistant"; content: string }[] = [
      { role: "user", content: userMessage },
    ];

    let outcome: MergeOutcome | null = null;

    // 최대 2회 — 첫 호출과 스키마 오류 피드백을 붙인 재시도 1회(CLAUDE.md §8).
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const response = await anthropic.messages.create(
        {
          model: AI_MODEL,
          max_tokens: SEARCH_PARSE_MAX_TOKENS,
          system: SEARCH_PARSE_SYSTEM,
          messages: history,
        },
        { timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 },
      );

      const raw = textOf(response as unknown as { content: { type: string; text?: string }[] });
      outcome = mergeAiConditions({ text: input.text, rule: input.rule, raw: readJson(raw) });

      if (outcome.schemaError === null) {
        return { used: true, outcome, promptVersion, attempts: attempt };
      }

      history.push({ role: "assistant", content: raw });
      history.push({ role: "user", content: buildSearchParseRetryMessage(outcome.schemaError) });
    }

    // 두 번 다 형식을 벗어났다. **부분 결과를 조건으로 만들지 않는다.**
    return { used: false, reason: "invalid_output", promptVersion };
  } catch {
    // 실패 원인에 사용자 입력이 실려 나가지 않도록 **에러를 그대로 흘리지 않는다**(§5.3).
    return { used: false, reason: "call_failed", promptVersion };
  }
}

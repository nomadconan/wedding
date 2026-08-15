import { summarizeResult, unavailableResult, type ToolResult } from "@/lib/core/ai/empty";
import { buildPlannerSystemPrompt } from "@/lib/core/ai/prompt";
import { TOOL_INPUTS, hasToolSchema, parseToolArgs } from "@/lib/core/ai/tool-schemas";
import { registrableTools, toolGaps, type ToolSpec } from "@/lib/core/ai/tools";

import type { ToolContext } from "./context";
import { TOOL_HANDLERS, hasToolHandler } from "./handlers";

/**
 * 툴 레지스트리 (S7-20 · 명세서 §5.6)
 *
 * **모델에 노출되는 목록을 여기서 한 번만 만든다.** 프롬프트에 적히는 목록과 실제
 * 부를 수 있는 목록이 다르면 둘 중 하나는 거짓말이 된다 — 같은 배열에서 둘 다 만든다.
 *
 * **실행 실패를 대화에 흘리지 않는다.** 인자 검증 실패는 모델에게 돌려주고(그래야
 * 다음 턴에 고친다), 조회 실패는 사용자에게 보일 문장으로 바꾼다. 예외 메시지에는
 * 쿼리·식별자가 실려 나갈 수 있으므로 **그대로 흘리지 않는다**(§5.3).
 */

export type RegisteredTool = {
  name: string;
  description: string;
  input_schema: (typeof TOOL_INPUTS)[string]["jsonSchema"];
};

export function registeredToolSpecs(): ToolSpec[] {
  return registrableTools({ hasSchema: hasToolSchema, hasHandler: hasToolHandler });
}

/** Anthropic Messages API 의 `tools` 배열 모양. */
export function registeredTools(): RegisteredTool[] {
  return registeredToolSpecs().map((spec) => ({
    name: spec.name,
    description: spec.summary,
    input_schema: TOOL_INPUTS[spec.name].jsonSchema,
  }));
}

/** 아직 열리지 않은 툴과 그 이유. 운영 화면(F-A-04)이 그대로 읽는다. */
export function registryGaps() {
  return toolGaps({ hasSchema: hasToolSchema, hasHandler: hasToolHandler });
}

export function plannerSystemPrompt(): string {
  return buildPlannerSystemPrompt(registeredToolSpecs());
}

/**
 * 한 번의 툴 호출 기록(`ai_tool_calls`).
 *
 * **인자와 요약만 남긴다.** 결과 본문을 남기면 감사 표가 조회 결과의 사본이 되고,
 * 그 표에는 파기 규칙도 마스킹도 걸려 있지 않다(§5.1·§5.3).
 */
export type ToolCallAudit = {
  toolName: string;
  argumentsJson: Record<string, unknown>;
  resultSummary: string;
  latencyMs: number;
  error: string | null;
};

export type ToolRun = {
  result: ToolResult;
  audit: ToolCallAudit;
  /** 이 호출이 순서를 정해 돌려줬다면 그 기준. 후처리가 응답에 그 코드가 있는지 본다. */
  rankingBasis: { code: string; label: string }[];
};

/**
 * 툴 하나를 실행한다.
 *
 * `startedAt`·`finishedAt` 을 **호출자가 넘긴다.** 이 모듈이 시계를 부르면 지연 시간이
 * 테스트에서 재현되지 않는다(다른 모듈들이 `asOf` 를 넘겨받는 것과 같은 이유).
 */
export async function runTool(
  name: string,
  rawArgs: unknown,
  ctx: ToolContext,
  clock: { now: () => number } = { now: () => Date.now() },
): Promise<ToolRun> {
  const startedAt = clock.now();

  const audit = (
    result: ToolResult,
    error: string | null,
    args: Record<string, unknown>,
    count?: number,
  ): ToolCallAudit => ({
    toolName: name,
    argumentsJson: args,
    resultSummary: summarizeResult(result, count),
    latencyMs: Math.max(0, clock.now() - startedAt),
    error,
  });

  const handler = TOOL_HANDLERS[name];

  // 등록되지 않은 툴을 부른 것 자체가 사건이다 — 프롬프트에 없는 이름을 모델이 지어냈다.
  if (handler === undefined || !hasToolSchema(name)) {
    const result = unavailableResult<never>("tool_failed");

    return {
      result,
      audit: audit(result, "unregistered_tool", {}),
      rankingBasis: [],
    };
  }

  const parsed = parseToolArgs(name, rawArgs);

  if (!parsed.ok) {
    const result = unavailableResult<never>("tool_failed");

    return {
      // **인자 검증 메시지는 모델에게만 간다**(감사 기록의 error). 사용자에게는
      // 고정 문장이 나간다 — zod 경로 이름이 대화에 뜨면 그것은 고장으로 읽힌다.
      result,
      audit: audit(result, `invalid_args: ${parsed.message}`, {}),
      rankingBasis: [],
    };
  }

  try {
    const outcome = await handler(parsed.args, ctx);

    return {
      result: outcome.result,
      audit: audit(outcome.result, null, parsed.args, outcome.count),
      rankingBasis: outcome.rankingBasis ?? [],
    };
  } catch {
    // **예외를 그대로 흘리지 않는다.** 스택·쿼리에 식별자가 실려 나갈 수 있다(§5.3).
    const result = unavailableResult<never>("tool_failed");

    return {
      result,
      audit: audit(result, "handler_failed", parsed.args),
      rankingBasis: [],
    };
  }
}

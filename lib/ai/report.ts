import {
  REPORT_MAX_TOKENS,
  REPORT_PROMPT_VERSION,
  REPORT_SYSTEM,
  buildReportRetryMessage,
  buildReportUserMessage,
} from "@/lib/core/report/prompt";
import type { RuleMatch } from "@/lib/core/rules/types";
import { ReportSchema, type Report } from "@/lib/core/schemas/report";

/**
 * 계약서 분석 LLM 호출 — **서버 전용** (S7-03 · 명세서 §5.2 5·6단계)
 *
 * **클라이언트에서 부르지 않는다**(CLAUDE.md §3.1·§5.4). 키는 서버 전용이며 이
 * 모듈은 파이프라인 실행기에서만 import 된다.
 *
 * **마스킹된 본문만 넘긴다.** 마스킹 완료 판정은 호출부가 이미 끝냈고(§5.2 3단계),
 * 실패하면 여기까지 오지 않는다 — 그 판단을 이 함수가 다시 하지 않는 이유는, 두 곳에
 * 두면 한쪽이 느슨해질 때 조용히 통과하기 때문이다. 호출부가 유일한 문이다.
 *
 * 실패 처리는 CLAUDE.md §8 그대로다: zod 검증 실패 → **1회 재시도**(스키마 오류
 * 피드백 포함) → 재실패 시 **룰 기반만** 노출. 부분 결과를 리포트로 만들지 않는다.
 */

export type ReportAiSkipReason = "no_key" | "invalid_output" | "call_failed";

export type ReportAiResult =
  | { used: false; reason: ReportAiSkipReason; promptVersion: string; model: string | null }
  | {
      used: true;
      report: Report;
      promptVersion: string;
      model: string;
      attempts: number;
      tokenIn: number;
      tokenOut: number;
    };

/** 리포트는 사람이 기다리는 작업이다(§5.8 p95 60초). 그 안에서 두 번 부를 수 있게 잡는다. */
const REQUEST_TIMEOUT_MS = 25_000;

function textOf(content: unknown): string {
  return (content as { type: string; text?: string }[])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("")
    .trim();
}

/** 모델이 코드펜스를 붙이는 경우가 있다. JSON 본체만 남긴다(S7-02 와 같은 처리). */
function readJson(raw: string): unknown {
  const unfenced = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

  try {
    return JSON.parse(unfenced);
  } catch {
    return null;
  }
}

export async function analyzeWithAi(input: {
  maskedText: string;
  matches: readonly RuleMatch[];
  fragments: Readonly<Record<string, string | null>>;
}): Promise<ReportAiResult> {
  const promptVersion = REPORT_PROMPT_VERSION;

  // 키가 없으면 SDK 생성 자체가 던진다. **그 전에** 막고 룰 결과로 돌아간다(D-28 계열).
  if ((process.env.ANTHROPIC_API_KEY ?? "") === "") {
    return { used: false, reason: "no_key", promptVersion, model: null };
  }

  try {
    // 키가 있을 때만 SDK 를 끌어온다 — 최상단에서 만들면 키 없는 환경의 import 가 깨진다.
    const { anthropic, AI_MODEL } = await import("./client");

    const history: { role: "user" | "assistant"; content: string }[] = [
      {
        role: "user",
        content: buildReportUserMessage({
          maskedText: input.maskedText,
          matches: input.matches,
          fragments: input.fragments,
        }),
      },
    ];

    let tokenIn = 0;
    let tokenOut = 0;

    // 최대 2회 — 첫 호출과 스키마 오류 피드백을 붙인 재시도 1회(CLAUDE.md §8).
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const response = await anthropic.messages.create(
        {
          model: AI_MODEL,
          max_tokens: REPORT_MAX_TOKENS,
          system: REPORT_SYSTEM,
          messages: history,
        },
        { timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 },
      );

      tokenIn += response.usage?.input_tokens ?? 0;
      tokenOut += response.usage?.output_tokens ?? 0;

      const raw = textOf(response.content);
      const parsed = readJson(raw);

      // 점수는 코드가 계산한다(§5.2 · 결정적 계산). 모델이 보내와도 여기서 덮는다.
      const candidate =
        typeof parsed === "object" && parsed !== null
          ? { ...(parsed as Record<string, unknown>), risk_score: 0 }
          : parsed;

      const checked = ReportSchema.safeParse(candidate);

      if (checked.success) {
        return {
          used: true,
          report: checked.data,
          promptVersion,
          model: AI_MODEL,
          attempts: attempt,
          tokenIn,
          tokenOut,
        };
      }

      history.push({ role: "assistant", content: raw });
      history.push({
        role: "user",
        content: buildReportRetryMessage(
          checked.error.issues
            .slice(0, 5)
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join(" / "),
        ),
      });
    }

    // 두 번 다 형식을 벗어났다. **부분 결과를 리포트로 만들지 않는다**(§5.1).
    return { used: false, reason: "invalid_output", promptVersion, model: null };
  } catch {
    // 실패 원인에 문서 내용이 실려 나가지 않도록 **에러를 그대로 흘리지 않는다**(§5.3).
    return { used: false, reason: "call_failed", promptVersion, model: null };
  }
}

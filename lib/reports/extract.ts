import { checkExtraction, type ExtractionFailure } from "@/lib/core/report/pipeline";

/**
 * 텍스트 추출 어댑터 (S7-03 · 명세서 §5.2 2단계)
 *
 * **없는 기능을 있는 척하지 않는다.** §5.2 2단계는 "PDF 텍스트 레이어 우선, 이미지·
 * 스캔본은 OCR" 을 적었지만 둘 다 **새 npm 의존성**을 요구한다(PDF 파서 · OCR 엔진).
 * 의존성 추가는 이 작업의 보고 대상이라 넣지 않았고, 대신 **어댑터로 갈라 두었다** —
 * 결제(S5-06)·알림(S4-13)·정산(S5-07)·에스크로(S5-09)가 전부 같은 모양이다.
 *
 * ── 무엇을 하고 무엇을 하지 않는가 ──────────────────────────────────────────
 * **한다** — `text/plain` 을 그대로 읽는다. 이건 흉내가 아니라 **진짜 추출**이며,
 * 그래서 3~8단계(마스킹·룰 스캔·검증·인용 대조·저장·파기)가 로컬에서 실제로 돈다.
 *
 * **하지 않는다** — PDF·이미지. `unsupported` 로 **명시적으로 실패**하고 사용자에게
 * 무엇을 하면 되는지 말한다. 조용히 빈 문자열을 돌려주면 그 문서는 "위험 없음" 처럼
 * 보이는 리포트가 되고, 그것이 이 파이프라인에서 가장 나쁜 실패다.
 *
 * ── 프로덕션에서 stub 을 거부한다 ───────────────────────────────────────────
 * `EXTRACT_ADAPTER=stub` 은 로컬 전용이다. 프로덕션에서 돌면 **사용자는 계약서를
 * 올렸는데 서비스는 아무것도 읽지 못한 채 리포트를 만든다.**
 */

export const EXTRACT_ADAPTERS = ["plain", "stub"] as const;
export type ExtractAdapterName = (typeof EXTRACT_ADAPTERS)[number];

export type ExtractResult =
  | { ok: true; text: string; adapter: ExtractAdapterName }
  | { ok: false; reason: ExtractionFailure; adapter: ExtractAdapterName };

export class ExtractAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractAdapterError";
  }
}

export function resolveExtractAdapter(): ExtractAdapterName {
  const configured = (process.env.EXTRACT_ADAPTER ?? "plain").trim();

  if (!(EXTRACT_ADAPTERS as readonly string[]).includes(configured)) {
    throw new ExtractAdapterError(
      `알 수 없는 EXTRACT_ADAPTER 입니다: ${configured}. plain 또는 stub 만 쓸 수 있습니다.`,
    );
  }

  if (configured === "stub" && process.env.NODE_ENV === "production") {
    throw new ExtractAdapterError(
      "EXTRACT_ADAPTER=stub 은 프로덕션에서 쓸 수 없습니다. 실제 추출기를 붙이거나 plain 으로 두세요.",
    );
  }

  return configured as ExtractAdapterName;
}

/** `text/plain` 만 실제로 읽는다. 나머지는 못 읽는다고 말한다. */
export function extractText(input: { bytes: Uint8Array; mime: string }): ExtractResult {
  const adapter = resolveExtractAdapter();

  if (input.mime !== "text/plain") {
    return { ok: false, reason: "unsupported", adapter };
  }

  // **stub 은 읽는 척하지 않는다.** 로컬에서 추출 실패 경로를 밟아 보기 위한 값이다.
  if (adapter === "stub") return { ok: false, reason: "unsupported", adapter };

  const text = new TextDecoder("utf-8", { fatal: false }).decode(input.bytes);
  const verdict = checkExtraction(text);

  if (!verdict.ok) return { ok: false, reason: verdict.reason, adapter };

  return { ok: true, text, adapter };
}

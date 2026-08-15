import {
  checkResponse,
  type PostcheckInput,
  type Violation,
} from "./postcheck";

/**
 * 문장 게이트 — 스트리밍과 후처리를 같이 세운다 (S7-06 · 명세서 §5.6 · §5.1)
 *
 * **문제.** §6.2 는 `/planner` 를 "스트리밍 대화" 로 적었고, §5.6 은 응답의 수치·고유명이
 * 툴 결과에 없으면 **폐기하고 1회 재생성**하라고 적었다. 그런데 델타를 받는 대로
 * 내보내면 검사할 기회가 없다 — 이미 화면에 있다. §5.1 의 "부분 결과를 노출하지
 * 않는다" 와 정면으로 부딪힌다.
 *
 * **판단.** 스트리밍의 값어치는 *글자가 흐르는 것* 이 아니라 **기다리는 동안 뭔가
 * 일어나고 있다는 사실이 보이는 것**이다. 그래서 델타를 **문장 단위로 모아** 검사하고,
 * 통과한 문장만 내보낸다. 사용자는 여전히 답이 자라나는 것을 보고, 우리는 **검사되지
 * 않은 문장을 단 하나도 내보내지 않는다.**
 *
 * **잡히지 않는 하나.** 정렬 기준 코드는 문장 하나로 판정할 수 없다(응답 어딘가에만
 * 있으면 된다). 그래서 그 검사만 `finish()` 에서 전체 본문으로 한다 — 그때 걸리면
 * 이미 내보낸 문장이 있으므로 **폐기 신호(`discard`)를 올린다.** 화면이 지우고 다시
 * 받는다. 조용히 두는 것보다 눈에 띄게 되돌리는 편이 낫다.
 */

/** 문장 끝으로 보는 문자. 마침표는 소수점과 겹치므로 뒤에 숫자가 오면 끝이 아니다. */
const SENTENCE_END = /[.!?。\n]/;

/**
 * 완성된 문장을 잘라 낸다. 남은 꼬리는 다음 델타를 기다린다.
 *
 * `12.5%` 의 점을 문장 끝으로 보면 수치 토큰이 두 조각으로 갈라져 대조가 깨진다.
 * 그래서 **마침표 뒤에 숫자가 붙어 있으면** 문장 끝으로 보지 않는다.
 */
export function takeSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0;

  for (let index = 0; index < buffer.length; index += 1) {
    const char = buffer[index];
    if (!SENTENCE_END.test(char)) continue;

    if (char === "." && /\d/.test(buffer[index + 1] ?? "")) continue;

    sentences.push(buffer.slice(start, index + 1));
    start = index + 1;
  }

  return { sentences, rest: buffer.slice(start) };
}

export type GateEvent =
  /** 검사를 통과했다. 화면에 내보내도 된다. */
  | { kind: "emit"; text: string }
  /** 이 문장이 툴 결과에 없는 값을 말했다. 여기서 스트림을 끊고 1회 재생성한다. */
  | { kind: "violation"; violations: Violation[] }
  /** 이미 내보낸 것을 지워야 한다(전체 본문 검사에서 걸렸다). */
  | { kind: "discard"; violations: Violation[] };

export type SentenceGate = {
  push: (delta: string) => GateEvent[];
  /** 스트림이 끝났다. 남은 꼬리를 검사하고 전체 본문 검사를 돌린다. */
  finish: () => GateEvent[];
  /** 지금까지 통과시킨 본문. 저장·재검사에 쓴다. */
  emitted: () => string;
};

export function createSentenceGate(input: Omit<PostcheckInput, "text">): SentenceGate {
  let buffer = "";
  let passed = "";
  let broken = false;

  const verify = (text: string): GateEvent[] => {
    // 공백뿐인 조각은 검사할 것도, 따로 내보낼 것도 없다. 통과분에만 이어 붙인다 —
    // 이벤트로 만들면 화면이 의미 없는 갱신을 하고 테스트도 공백에 흔들린다.
    if (text.trim() === "") {
      passed += text;

      return [];
    }

    // **문장 단위 검사에서는 기준 코드를 보지 않는다** — 전체 본문의 성질이라
    // 첫 문장에서 없다고 반려하면 정상 응답이 통째로 막힌다.
    const verdict = checkResponse({
      text,
      toolResults: input.toolResults,
      userText: input.userText,
    });

    if (!verdict.ok) {
      broken = true;

      return [{ kind: "violation", violations: verdict.violations }];
    }

    passed += text;

    return [{ kind: "emit", text }];
  };

  return {
    push(delta) {
      if (broken) return [];

      buffer += delta;
      const { sentences, rest } = takeSentences(buffer);
      buffer = rest;

      const events: GateEvent[] = [];
      for (const sentence of sentences) {
        events.push(...verify(sentence));
        if (broken) break;
      }

      return events;
    },

    finish() {
      if (broken) return [];

      const events: GateEvent[] = [];

      if (buffer !== "") {
        events.push(...verify(buffer));
        buffer = "";
      }

      if (broken) return events;

      // 전체 본문 검사 — 여기서만 정렬 기준 코드를 본다(D-25 · §2.2).
      const verdict = checkResponse({ ...input, text: passed });

      if (!verdict.ok) {
        broken = true;
        events.push({ kind: "discard", violations: verdict.violations });
      }

      return events;
    },

    emitted() {
      return passed;
    },
  };
}

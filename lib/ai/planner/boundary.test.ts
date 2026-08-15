import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 대화 경계 (S7-06)
 *
 * **소스를 글자로 읽는다.** 모듈을 import 하면 `next/headers`·SDK 가 딸려 오고 그러면
 * 이 검사가 서버 환경 때문에 깨진다(`lib/ai/tools/boundary.test.ts` 와 같은 방식).
 *
 * 지키려는 것 넷 —
 *  1. **키가 없어도 import 가 깨지지 않는다.** SDK 는 키가 있을 때만 동적으로 끌어온다.
 *  2. **상한을 저장보다 먼저 본다.** 막힌 턴이 사용량에 계산되면 상한이 하루 일찍 온다.
 *  3. **커플 경계를 조회마다 명시한다.** 이 모듈은 서비스롤을 쥐고 있어 RLS 가 비켜선다.
 *  4. **이전 턴의 툴 결과를 다시 싣지 않는다.** 후처리의 허용 목록이 흐려진다.
 */
const DIR = __dirname;
const read = (file: string) => readFileSync(join(DIR, file), "utf8");

describe("키가 없어도 선다 (D-28 계열)", () => {
  const run = read("run.ts");

  it("SDK 를 최상단에서 import 하지 않는다", () => {
    expect(run).not.toMatch(/^import .*@anthropic-ai\/sdk/m);
    expect(run).not.toMatch(/^import .*lib\/ai\/client/m);
  });

  it("키가 있을 때만 동적으로 끌어온다", () => {
    expect(run).toContain('await import("@/lib/ai/client")');
    expect(run).toContain("ANTHROPIC_API_KEY");
  });

  it("키가 없으면 룰 파서로 내려간다 — 대화를 닫지 않는다", () => {
    expect(run).toContain("parseSearchQuery");
    expect(run).toContain("rules_only");
  });
});

describe("상한을 저장보다 먼저 본다", () => {
  const route = readFileSync(
    join(DIR, "..", "..", "..", "app", "api", "ai", "planner", "route.ts"),
    "utf8",
  );

  it("게이트 판정이 메시지 저장보다 앞선다", () => {
    const gateAt = route.indexOf("conversationGate(");
    const appendAt = route.indexOf("appendMessage(");

    expect(gateAt).toBeGreaterThan(-1);
    expect(appendAt).toBeGreaterThan(gateAt);
  });

  it("막히면 429 로 끝내고 스트림을 열지 않는다", () => {
    const gateAt = route.indexOf("if (!gate.ok)");
    const streamAt = route.indexOf("new ReadableStream");

    expect(gateAt).toBeGreaterThan(-1);
    expect(streamAt).toBeGreaterThan(gateAt);
    expect(route).toContain("AI_TURN_LIMIT");
  });

  it("남의 대화에 이어 쓰지 못한다 — id 만 믿지 않는다", () => {
    expect(route).toContain("ownsConversation(");
    expect(route.indexOf("ownsConversation(")).toBeLessThan(route.indexOf("conversationGate("));
  });

  it("막힌 사실을 증적에 남긴다 (남용 탐지 근거 · §5.6)", () => {
    expect(route).toContain("ai_turn_blocked");
  });
});

describe("서비스롤을 쥔 만큼 경계를 명시한다", () => {
  const conversation = read("conversation.ts");

  it("대화 목록·소유 확인이 couple_id 를 건다", () => {
    const scoped = [...conversation.matchAll(/from\("ai_conversations"\)([\s\S]{0,400}?);/g)].map(
      (match) => match[1],
    );

    // 대화 표를 읽거나 고치는 곳은 넷이다 — 목록·소유 확인·생성·last_message_at 갱신.
    // 앞의 둘은 couple_id 로, 뒤의 둘은 이미 확인된 대화 id 로 좁힌다.
    expect(scoped.length).toBeGreaterThanOrEqual(3);
    expect(scoped.filter((body) => body.includes("couple_id")).length).toBeGreaterThanOrEqual(3);
  });

  it("메시지 조회는 대화 id 로 좁힌다", () => {
    expect(conversation).toMatch(/from\("ai_messages"\)[\s\S]{0,300}?eq\("conversation_id"/);
  });
});

describe("이번 턴의 툴 결과만 허용 목록이다", () => {
  const run = read("run.ts");

  it("지난 턴은 본문만 넘긴다", () => {
    expect(run).toContain("toTranscript");
    // 기록에서 꺼내는 것은 role·content 뿐이다.
    expect(run).toMatch(/toTranscript[\s\S]{0,600}?content: row\.content/);
  });

  it("후처리에 이번 턴 결과 배열을 넘긴다", () => {
    expect(run).toContain("createSentenceGate({ toolResults");
  });

  it("검사에 걸리면 1회만 재생성한다", () => {
    expect(run).toContain("POSTCHECK_FALLBACK");
    // 재생성 함수는 자기 자신을 부르지 않는다 — 부르면 상한 없는 되풀이가 된다.
    const declaration = "async function regenerate";
    const body = run.slice(run.indexOf(declaration) + declaration.length);
    expect(body.includes("regenerate(")).toBe(false);
  });
});

describe("화면은 Claude 를 직접 부르지 않는다 (CLAUDE.md §3.1)", () => {
  const view = readFileSync(
    join(DIR, "..", "..", "..", "app", "(consumer)", "planner", "PlannerView.tsx"),
    "utf8",
  );

  it("클라이언트 컴포넌트가 SDK·키를 모른다", () => {
    expect(view).not.toContain("@anthropic-ai/sdk");
    expect(view).not.toContain("ANTHROPIC");
    expect(view).toContain('"/api/ai/planner"');
  });

  it("법적 고지를 상시 노출한다 (§2.3)", () => {
    expect(view).toContain("<AiDisclaimer />");
  });
});

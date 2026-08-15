/**
 * 응답 후처리 — 수치·고유명 대조 (S7-20 · 명세서 §5.6 플래너 가드레일)
 *
 * §5.2 계약서 검토의 **인용 대조와 같은 기법**이다. 거기서는 finding 의 근거 문구가
 * 마스킹 원문에 실재하는지 보고, 여기서는 응답의 **금액·건수·백분율과 업체·플래너
 * 이름**이 그 턴의 툴 결과에 실재하는지 본다.
 *
 * **이 검사를 성립시키는 것은 "AI 는 산술을 하지 않는다" 는 규칙이다.** 합계·차액·
 * 비율은 전부 툴이 계산해 돌려주고 모델은 옮겨 적기만 한다. 모델이 스스로 더하기
 * 시작하면 응답의 숫자가 툴 결과에 없어도 정상이 되고, 그 순간 대조가 불가능해진다.
 *
 * **검사가 성립하는 범위를 프롬프트가 만든다.**
 *  · 숫자는 **아라비아 숫자**로 적게 한다 — "삼백만 원" 은 토큰으로 잡히지 않는다.
 *  · 업체·플래너 이름은 **작은따옴표로 감싸게** 한다 — 임의의 한국어 고유명을 문장에서
 *    안전하게 찾아내는 방법은 없고, 못 찾으면 검사가 아니라 기분이 된다.
 * 프롬프트가 요구하는 형태만 검사한다는 사실을 숨기지 않는다. 잡히지 않는 형태가
 * 남아 있고(한글 수사·따옴표 없는 이름), 그래서 이 검사는 **주 방어선이 아니라 마지막
 * 그물**이다. 앞단의 방어선은 "툴 결과 없이는 사실을 말하지 않는다" 는 프롬프트 제약과
 * 빈 결과 사유 코드다.
 *
 * 불일치가 있으면 **응답 전체를 폐기하고 1회 재생성**한다(무엇이 어긋났는지 피드백
 * 포함). 재실패 시 대체 문장으로 내려간다 — **부분적으로 맞는 응답을 그대로 내보내지
 * 않는다**(§5.1 부분 결과 비노출).
 */

// =============================================================================
// 수치 토큰
// =============================================================================

export const NUMERIC_KINDS = ["amount", "count", "percent"] as const;
export type NumericKind = (typeof NUMERIC_KINDS)[number];

export type NumericToken = {
  raw: string;
  kind: NumericKind;
  /** 대조 후보값. 표기가 달라도 같은 값이면 통과시키기 위해 여럿을 둔다. */
  candidates: number[];
  /** 응답 문자열 안의 위치. 문장을 되짚는 데 쓴다. */
  offset: number;
};

const AMOUNT_PATTERN = /(\d[\d,]*)\s*(억|만)?\s*원/g;
const BARE_UNIT_PATTERN = /(\d[\d,]*)\s*(억|만)(?!\s*원)/g;
const COUNT_PATTERN = /(\d[\d,]*)\s*(건|개|곳|명|인|회|일|가지|장|박)/g;
const PERCENT_PATTERN = /(\d+(?:\.\d+)?)\s*(%|퍼센트)/g;

function digitsOf(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

/**
 * 응답에서 금액·건수·백분율 토큰을 뽑는다.
 *
 * **맨 숫자는 잡지 않는다.** 단위가 붙은 것만 본다 — 목록 번호("1.")나 날짜 조각까지
 * 검사하면 사실 주장이 아닌 것을 반려하게 되고, 그러면 검사를 끄고 싶어진다.
 */
export function extractNumericTokens(text: string): NumericToken[] {
  const tokens: NumericToken[] = [];
  const seen = new Set<string>();

  const push = (raw: string, kind: NumericKind, candidates: number[], offset: number) => {
    const key = `${kind}:${raw}:${offset}`;
    if (seen.has(key)) return;

    seen.add(key);
    tokens.push({ raw: raw.trim(), kind, candidates, offset });
  };

  for (const match of text.matchAll(AMOUNT_PATTERN)) {
    const base = digitsOf(match[1]);
    const unit = match[2];
    const scaled = unit === "억" ? base * 100_000_000 : unit === "만" ? base * 10_000 : base;

    push(match[0], "amount", unit === undefined ? [base] : [scaled, base], match.index ?? 0);
  }

  for (const match of text.matchAll(BARE_UNIT_PATTERN)) {
    const base = digitsOf(match[1]);
    const scaled = match[2] === "억" ? base * 100_000_000 : base * 10_000;

    push(match[0], "amount", [scaled, base], match.index ?? 0);
  }

  for (const match of text.matchAll(COUNT_PATTERN)) {
    push(match[0], "count", [digitsOf(match[1])], match.index ?? 0);
  }

  for (const match of text.matchAll(PERCENT_PATTERN)) {
    const value = Number(match[1]);

    // 우리 데이터는 요율을 **basis point 정수**로 갖는다(5% = 500bp). 표기가 %인
    // 것만으로 반려하면 모델이 옳게 옮겨 적어도 걸린다.
    push(match[0], "percent", [value, Math.round(value * 100)], match.index ?? 0);
  }

  return tokens.sort((a, b) => a.offset - b.offset);
}

/**
 * 툴 결과에 실재하는 수치.
 *
 * 숫자 값과 **문자열 안의 숫자**를 모두 모은다 — 날짜('2027-03-14')·라벨('총 3건')
 * 처럼 값이 문자열에 박혀 나가는 자리가 있다.
 */
export function collectNumbers(value: unknown, into: Set<number> = new Set()): Set<number> {
  if (typeof value === "number" && Number.isFinite(value)) {
    into.add(value);

    return into;
  }

  if (typeof value === "string") {
    for (const match of value.matchAll(/\d+(?:\.\d+)?/g)) {
      const parsed = Number(match[0]);
      if (Number.isFinite(parsed)) into.add(parsed);
    }

    return into;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, into);

    return into;
  }

  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value as Record<string, unknown>)) collectNumbers(item, into);
  }

  return into;
}

// =============================================================================
// 고유명 토큰
// =============================================================================

/** 프롬프트가 요구하는 형태 — 이름은 작은따옴표 안에 있다. */
const QUOTED_NAME_PATTERN = /'([^'\n]{1,40})'/g;

export type NameToken = { raw: string; offset: number };

export function extractNameCandidates(text: string): NameToken[] {
  const tokens: NameToken[] = [];

  for (const match of text.matchAll(QUOTED_NAME_PATTERN)) {
    const raw = match[1].trim();

    // 따옴표를 강조로 쓴 짧은 조각은 이름이 아니다.
    if (raw.length === 0) continue;

    tokens.push({ raw, offset: match.index ?? 0 });
  }

  return tokens;
}

/** 툴 결과의 문자열을 한 덩어리로 잇는다. 이름 대조는 부분 문자열 포함으로 본다. */
export function collectText(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") {
    into.push(value);

    return into;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectText(item, into);

    return into;
  }

  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value as Record<string, unknown>)) collectText(item, into);
  }

  return into;
}

function normalize(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, "").toLowerCase();
}

// =============================================================================
// 판정
// =============================================================================

export type ViolationKind = "number" | "name" | "ranking_basis";

export type Violation = {
  kind: ViolationKind;
  /** 어긋난 토큰. 재생성 피드백에 그대로 실린다. */
  token: string;
  /** 그 토큰이 있던 문장. **폐기 대상은 응답 전체다** — 문장은 피드백용이다. */
  sentence: string;
};

export type PostcheckInput = {
  /** 모델 응답. */
  text: string;
  /** 그 턴에 실제로 부른 툴들의 결과. 빈 배열이면 조회 없이 답한 턴이다. */
  toolResults: readonly unknown[];
  /** 사용자가 이번 턴에 말한 문장. 사용자가 댄 숫자를 되읽는 것은 지어낸 값이 아니다. */
  userText?: string;
  /** 툴이 함께 돌려준 정렬·랭킹 기준. 있으면 응답에 반드시 함께 나와야 한다(D-25). */
  rankingBasis?: readonly { code: string; label: string }[];
};

export type PostcheckVerdict = {
  ok: boolean;
  violations: Violation[];
};

function sentenceOf(text: string, offset: number): string {
  const start = Math.max(
    text.lastIndexOf(".", offset - 1),
    text.lastIndexOf("\n", offset - 1),
    text.lastIndexOf("!", offset - 1),
    text.lastIndexOf("?", offset - 1),
  );

  const rest = text.slice(offset);
  const endRelative = rest.search(/[.\n!?]/);
  const end = endRelative === -1 ? text.length : offset + endRelative + 1;

  return text.slice(start + 1, end).trim();
}

/**
 * 응답이 툴 결과 위에 서 있는가.
 *
 * **조회하지 않은 턴에서 수치·이름을 말하면 그것만으로 위반이다.** 툴 결과가 비어
 * 있는데 금액이 나왔다면 출처가 모델의 사전 지식밖에 없다 — "보통 스드메는 300만 원쯤"
 * 이 정확히 그 모양이고, 그 문장이 나가는 순간 그것은 **우리가 한 주장**이 된다.
 */
export function checkResponse(input: PostcheckInput): PostcheckVerdict {
  const violations: Violation[] = [];

  const allowedNumbers = new Set<number>();
  for (const result of input.toolResults) collectNumbers(result, allowedNumbers);
  if (input.userText !== undefined) collectNumbers(input.userText, allowedNumbers);

  const allowedText = normalize(
    [...input.toolResults.flatMap((result) => collectText(result)), input.userText ?? ""].join(" "),
  );

  for (const token of extractNumericTokens(input.text)) {
    if (token.candidates.some((candidate) => allowedNumbers.has(candidate))) continue;

    violations.push({
      kind: "number",
      token: token.raw,
      sentence: sentenceOf(input.text, token.offset),
    });
  }

  const names = extractNameCandidates(input.text);

  for (const name of names) {
    if (allowedText.includes(normalize(name.raw))) continue;

    violations.push({
      kind: "name",
      token: name.raw,
      sentence: sentenceOf(input.text, name.offset),
    });
  }

  // ── 기준 코드 (D-25 · §2.2) ────────────────────────────────────────────────
  // **툴이 순서를 정해 돌려줬는데 응답이 이름을 부르면** 무엇으로 줄 세웠는지 함께
  // 말해야 한다. 광고·제휴가 없는 구조를 화면으로 증명하는 것이 이 서비스의 차별성이고,
  // 대화도 화면이다.
  const basis = input.rankingBasis ?? [];

  if (basis.length > 0 && names.length > 0) {
    const shown = basis.some(
      (item) =>
        input.text.includes(item.code) || normalize(input.text).includes(normalize(item.label)),
    );

    if (!shown) {
      violations.push({
        kind: "ranking_basis",
        token: basis.map((item) => item.code).join(","),
        sentence: "",
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * 재생성에 붙이는 피드백.
 *
 * **무엇이 어긋났는지 적는다.** "다시 써라" 만 주면 모델은 같은 숫자를 다른 문장에
 * 넣어 되돌려 준다.
 */
export function buildPostcheckFeedback(violations: readonly Violation[]): string {
  const lines = ["직전 응답을 내보낼 수 없다. 아래 항목이 툴 결과에 없다."];

  for (const violation of violations) {
    if (violation.kind === "number") {
      lines.push(`- 수치 '${violation.token}' 은(는) 이번 턴 툴 결과에 없다.`);
      continue;
    }

    if (violation.kind === "name") {
      lines.push(`- 이름 '${violation.token}' 은(는) 이번 턴 툴 결과에 없다.`);
      continue;
    }

    lines.push(
      `- 업체·플래너를 말하면서 정렬 기준 코드(${violation.token})를 함께 적지 않았다.`,
    );
  }

  lines.push(
    "툴 결과에 있는 값만 옮겨 적는다. 없는 값은 말하지 말고, 조회가 필요하면 툴을 부른다.",
  );

  return lines.join("\n");
}

/** 재생성도 실패했을 때 내보내는 문장. 부분적으로 맞는 응답 대신 이것을 쓴다. */
export const POSTCHECK_FALLBACK =
  "지금 조회한 값으로는 답할 수 없어요. 조건을 조금 더 알려 주시면 다시 찾아볼게요.";

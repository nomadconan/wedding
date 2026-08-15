import { STYLE_TAG_LABEL, type StyleTag } from "../schemas/onboarding";
import type { RejectedCondition, SearchCondition, SearchField } from "../schemas/search";
import { VENDOR_CATEGORY_LABEL, type VendorCategory } from "../schemas/vendor";

/**
 * 자연어+조건 파서 — **룰** (S7-02 · 명세서 §5.5 1단계)
 *
 * **룰이 진실이고 모델은 보조다.** 명세는 이 단계에 Claude 를 쓴다고 적었지만, 그것을
 * 곧이곧대로 "모델이 먼저 읽는다" 로 구현하면 세 가지가 깨진다.
 *  · **재현성** — 같은 문장이 같은 결과를 내지 않으면 사용자가 공유한 링크가 다른 화면을 연다.
 *  · **가용성** — `ANTHROPIC_API_KEY` 가 없거나 API 가 죽으면 검색 자체가 서지 않는다.
 *  · **검증** — "3월 14일 강남 300인" 처럼 **형태가 정해진 것**은 대조할 정답이 있어서
 *    단위 테스트로 고정할 수 있다. 모델에 맡기면 회귀를 눈으로만 확인하게 된다.
 * 그래서 여기서 읽을 수 있는 것은 여기서 읽고, **남은 조각만** 모델에게 넘긴다
 * (`lib/core/search/ai-merge.ts` · `lib/ai/search-parse.ts`).
 *
 * **프레임워크도 DB 도 모른다.** 조건 검색(`/search`)과 AI 플래너 대화(F-C-03)가
 * **같은 파서를 공유**해야 하기 때문이다(§5.5) — 입구가 둘이고 뒤가 하나다. 파서를 두 벌
 * 두면 같은 문장이 두 화면에서 다르게 해석되고, 그건 사용자가 재현할 수 없는 차이다.
 *
 * **'오늘' 을 스스로 정하지 않는다.** 기준일(`asOf`)은 호출자가 넘긴다 — "3월 14일" 의
 * 연도를 서버 시계로 정하면 같은 입력이 날짜가 바뀌는 순간 다른 조건이 된다(S2-06 원칙).
 */

export type RuleParseResult = {
  conditions: SearchCondition[];
  /** 조건으로 바꾸지 못하고 남은 텍스트. AI 보조와 '직접 고르기' 안내가 이걸 본다. */
  leftover: string;
  rejected: RejectedCondition[];
};

// =============================================================================
// 사전
// =============================================================================

/**
 * 지역 토큰.
 *
 * `vendors.region_code` 는 자유 입력("서울 강남")이라 조회는 부분 일치로 한다(S3-03).
 * 그래서 여기서는 **행정구역 이름을 알아보는 일**만 하고, 무엇과 맞출지는 조회가 정한다.
 * 자유 텍스트를 그대로 지역으로 넘기지 않는 이유는 "예쁜 홀" 같은 조각이 지역 필터로
 * 들어가면 **결과가 0건인데 이유는 화면에 없기** 때문이다.
 */
const REGION_TOKENS = [
  // 광역
  "서울", "경기", "인천", "부산", "대구", "대전", "광주", "울산", "세종",
  "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주",
  // 서울 자치구
  "강남", "서초", "송파", "강동", "광진", "성동", "종로", "용산", "마포", "서대문",
  "은평", "노원", "도봉", "강북", "성북", "동대문", "중랑", "강서", "양천", "구로",
  "금천", "영등포", "동작", "관악",
  // 예식 수요가 몰리는 생활권 이름
  "청담", "압구정", "삼성동", "역삼", "논현", "잠실", "여의도", "명동", "을지로",
  "판교", "분당", "일산", "수원", "성남", "용인", "고양", "부천", "안양", "광명", "김포",
] as const;

/** 카테고리 별칭. `VENDOR_CATEGORY_LABEL` 의 표기도 함께 받는다. */
const CATEGORY_SYNONYMS: Record<string, VendorCategory> = {
  웨딩홀: "hall",
  예식장: "hall",
  호텔웨딩: "hall",
  하우스웨딩: "hall",
  컨벤션: "hall",
  홀: "hall",
  스튜디오: "studio",
  웨딩촬영: "studio",
  촬영: "studio",
  스냅: "studio",
  드레스: "dress",
  웨딩드레스: "dress",
  메이크업: "makeup",
  헤어메이크업: "makeup",
  헤메: "makeup",
  본식영상: "video",
  영상: "video",
  비디오: "video",
  에이전시: "agency",
  웨딩에이전시: "agency",
};

/**
 * 하나로 좁힐 수 없는 말.
 *
 * "스드메" 는 스튜디오·드레스·메이크업 셋이고 카테고리 필터는 하나만 받는다. 임의로
 * 하나를 고르면 **사용자가 말하지 않은 조건**이 걸리고, 결과가 왜 그런지 화면에서
 * 알 수 없다. 그래서 조건으로 만들지 않고 **왜 안 걸었는지 적는다.**
 */
const AMBIGUOUS_TERMS: { term: string; reason: string }[] = [
  {
    term: "스드메",
    reason: "스튜디오·드레스·메이크업 세 가지라 카테고리 하나로 좁히지 않았어요. 직접 골라 주세요.",
  },
  {
    term: "올인원",
    reason: "업체마다 묶음 구성이 달라 조건으로 옮기지 않았어요.",
  },
];

/** 스타일 별칭. `STYLE_TAG_LABEL` 표기도 함께 받는다. */
const STYLE_SYNONYMS: Record<string, StyleTag> = {
  모던: "modern",
  심플: "minimal",
  미니멀: "minimal",
  클래식: "classic",
  전통: "classic",
  내추럴: "natural",
  자연: "natural",
  로맨틱: "romantic",
  화사: "romantic",
  럭셔리: "luxury",
  고급: "luxury",
  하이엔드: "luxury",
  야외: "outdoor",
  가든: "outdoor",
  아웃도어: "outdoor",
  스몰웨딩: "small_wedding",
  스몰: "small_wedding",
  작은결혼식: "small_wedding",
};

function dictionaryOf<T extends string>(
  base: Record<string, T>,
  labels: Record<T, string>,
): [string, T][] {
  const merged = new Map<string, T>(Object.entries(base));

  for (const [code, label] of Object.entries(labels) as [T, string][]) {
    merged.set(label.replace(/[·\s]/g, ""), code);
  }

  // 긴 것부터 본다. "웨딩드레스" 를 "드레스" 로 먼저 먹으면 앞의 '웨딩' 이 찌꺼기로 남는다.
  return [...merged.entries()].sort((a, b) => b[0].length - a[0].length);
}

const CATEGORY_DICT = dictionaryOf(CATEGORY_SYNONYMS, VENDOR_CATEGORY_LABEL);
const STYLE_DICT = dictionaryOf(STYLE_SYNONYMS, STYLE_TAG_LABEL);
const REGION_DICT = [...REGION_TOKENS].sort((a, b) => b.length - a.length);

// =============================================================================
// 스캐너 — 한 번 쓴 자리는 다시 쓰지 않는다
// =============================================================================

type Taken = boolean[];

function isFree(taken: Taken, start: number, end: number): boolean {
  for (let i = start; i < end; i += 1) {
    if (taken[i]) return false;
  }

  return true;
}

function take(taken: Taken, start: number, end: number): void {
  for (let i = start; i < end; i += 1) taken[i] = true;
}

/** 아직 쓰지 않은 자리에서만 찾는다. 찾기만 하고 표시는 호출자가 한다. */
function findFree(text: string, taken: Taken, pattern: RegExp): RegExpExecArray[] {
  const found: RegExpExecArray[] = [];
  const scanner = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);

  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null) {
    if (match[0].length === 0) {
      scanner.lastIndex += 1;
      continue;
    }

    if (isFree(taken, match.index, match.index + match[0].length)) found.push(match);
  }

  return found;
}

// =============================================================================
// 날짜
// =============================================================================

const PAD = (value: number) => String(value).padStart(2, "0");

/** 실재하는 날짜인가. 2월 30일·4월 31일·윤년 2월 29일을 여기서 가른다. */
export function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  return day <= days[month - 1];
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function parseAsOf(asOf: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asOf);
  if (!match) throw new RangeError("기준일은 YYYY-MM-DD 형식이어야 합니다.");

  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/**
 * 연도를 적지 않은 날짜의 연도.
 *
 * **지나간 날짜를 내년으로 읽는다.** 예식일을 과거로 잡는 사람은 없고, 올해로 읽으면
 * 12월에 "3월 14일" 을 넣은 사용자에게 이미 지난 날짜로 0건을 돌려주게 된다.
 * 기준일 당일은 **올해**다 — 오늘 예식을 찾는 것이 불가능한 일은 아니다.
 */
function inferYear(asOf: string, month: number, day: number): number {
  const today = parseAsOf(asOf);

  const passed =
    month < today.month || (month === today.month && day < today.day);

  return passed ? today.year + 1 : today.year;
}

function readDates(text: string, taken: Taken, asOf: string) {
  const conditions: SearchCondition[] = [];
  const rejected: RejectedCondition[] = [];

  const push = (year: number, month: number, day: number, match: RegExpExecArray) => {
    const sourceText = match[0].trim();

    if (!isRealDate(year, month, day)) {
      rejected.push({ sourceText, reason: "없는 날짜예요. 달력에서 직접 골라 주세요." });
      take(taken, match.index, match.index + match[0].length);

      return;
    }

    conditions.push({
      field: "date",
      value: `${year}-${PAD(month)}-${PAD(day)}`,
      sourceText,
      origin: "rule",
    });
    take(taken, match.index, match.index + match[0].length);
  };

  // 1) 연도까지 적은 것 — 2027-03-14 · 2027.3.14 · 2027년 3월 14일
  for (const match of findFree(text, taken, /(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?/g)) {
    push(Number(match[1]), Number(match[2]), Number(match[3]), match);
  }

  // 2) 내년/올해를 말로 적은 것
  for (const match of findFree(text, taken, /(내년|올해|금년)\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일?/g)) {
    const today = parseAsOf(asOf);
    const year = match[1] === "내년" ? today.year + 1 : today.year;

    push(year, Number(match[2]), Number(match[3]), match);
  }

  // 3) 연도를 뺀 것 — 3월 14일
  for (const match of findFree(text, taken, /(\d{1,2})\s*월\s*(\d{1,2})\s*일?/g)) {
    const month = Number(match[1]);
    const day = Number(match[2]);

    push(isRealDate(2000, month, day) ? inferYear(asOf, month, day) : 0, month, day, match);
  }

  return { conditions, rejected };
}

// =============================================================================
// 하객 수
// =============================================================================

function readGuestCount(text: string, taken: Taken) {
  const conditions: SearchCondition[] = [];
  const rejected: RejectedCondition[] = [];

  // '1인당' 은 가격 표현이지 규모가 아니다.
  for (const match of findFree(text, taken, /(?:하객\s*)?(\d[\d,]*)\s*(?:명|인)(?!당)/g)) {
    const value = Number(match[1].replace(/,/g, ""));
    const sourceText = match[0].trim();

    take(taken, match.index, match.index + match[0].length);

    if (!Number.isInteger(value) || value < 1 || value > 100_000) {
      rejected.push({ sourceText, reason: "하객 수를 다시 확인해 주세요." });
      continue;
    }

    conditions.push({ field: "guestCount", value, sourceText, origin: "rule" });
    break; // 하객 수는 하나다. 뒤에 또 나오면 그건 다른 뜻이므로 남겨 둔다.
  }

  return { conditions, rejected };
}

// =============================================================================
// 예산
// =============================================================================

const UNIT_MULTIPLIER: Record<string, number> = {
  억: 100_000_000,
  천만: 10_000_000,
  백만: 1_000_000,
  만: 10_000,
};

type AmountToken = { start: number; end: number; amount: number; text: string };

/** 금액 토큰. "1억 5천만원" 처럼 **붙어 있는 단위는 합친다.** */
function readAmounts(text: string, taken: Taken): AmountToken[] {
  const raw: AmountToken[] = [];

  for (const match of findFree(text, taken, /(\d+(?:\.\d+)?)\s*(억|천만|백만|만)\s*원?/g)) {
    raw.push({
      start: match.index,
      end: match.index + match[0].length,
      amount: Math.round(Number(match[1]) * UNIT_MULTIPLIER[match[2]]),
      text: match[0].trim(),
    });
  }

  // 단위 없이 적은 금액(30000000원). 6자리 미만은 예산으로 보지 않는다 — "300원" 은 예산이 아니다.
  for (const match of findFree(text, taken, /(\d[\d,]{5,})\s*원/g)) {
    const start = match.index;
    if (raw.some((token) => start < token.end && token.start < start + match[0].length)) continue;

    raw.push({
      start,
      end: start + match[0].length,
      amount: Number(match[1].replace(/,/g, "")),
      text: match[0].trim(),
    });
  }

  raw.sort((a, b) => a.start - b.start);

  const merged: AmountToken[] = [];
  for (const token of raw) {
    const previous = merged[merged.length - 1];
    // 사이에 아무것도 없이 이어졌고 뒤가 더 작은 단위면 한 금액이다(1억5천만).
    const adjacent = previous !== undefined && text.slice(previous.end, token.start).trim() === "";

    if (adjacent && previous.amount > token.amount) {
      merged[merged.length - 1] = {
        start: previous.start,
        end: token.end,
        amount: previous.amount + token.amount,
        text: text.slice(previous.start, token.end).trim(),
      };
      continue;
    }

    merged.push(token);
  }

  return merged;
}

const MAX_QUALIFIER = /^\s*(이하|이내|까지|미만|안쪽|안에서)/;
const MIN_QUALIFIER = /^\s*(이상|넘는|넘게|초과|부터)/;
const RANGE_SEPARATOR = /^\s*(?:[~\-–—]|에서|부터)\s*$/;

function readBudget(text: string, taken: Taken) {
  const conditions: SearchCondition[] = [];
  const tokens = readAmounts(text, taken);
  if (tokens.length === 0) return { conditions, rejected: [] as RejectedCondition[] };

  const [first, second] = tokens;

  // 1) 구간 — "2천만~3천만"
  if (
    second !== undefined &&
    RANGE_SEPARATOR.test(text.slice(first.end, second.start)) &&
    first.amount <= second.amount
  ) {
    const sourceText = text.slice(first.start, second.end).trim();

    take(taken, first.start, second.end);
    conditions.push({ field: "budgetMin", value: first.amount, sourceText, origin: "rule" });
    conditions.push({ field: "budgetMax", value: second.amount, sourceText, origin: "rule" });

    return { conditions, rejected: [] as RejectedCondition[] };
  }

  const tail = text.slice(first.end, first.end + 8);
  take(taken, first.start, first.end);

  // 2) 꼬리말이 방향을 정한다.
  if (MIN_QUALIFIER.test(tail)) {
    conditions.push({ field: "budgetMin", value: first.amount, sourceText: first.text, origin: "rule" });

    return { conditions, rejected: [] as RejectedCondition[] };
  }

  /**
   * 3) 꼬리말이 없으면 **상한으로 읽는다.**
   *
   * "예산 3천만원" 은 대개 "그 안에서" 라는 뜻이다. 다만 이건 해석이지 사실이 아니므로
   * 칩에 '이하' 라고 적어 되돌려 보여주고, 아니면 사용자가 고칠 수 있게 한다(§5.5).
   */
  conditions.push({ field: "budgetMax", value: first.amount, sourceText: first.text, origin: "rule" });

  return { conditions, rejected: [] as RejectedCondition[] };
}

// =============================================================================
// 사전 대조 (카테고리·스타일·지역·모호한 말)
// =============================================================================

function readAmbiguous(text: string, taken: Taken): RejectedCondition[] {
  const rejected: RejectedCondition[] = [];

  for (const { term, reason } of AMBIGUOUS_TERMS) {
    for (const match of findFree(text, taken, new RegExp(escapeRegExp(term), "g"))) {
      take(taken, match.index, match.index + match[0].length);
      rejected.push({ sourceText: match[0], reason });
      break;
    }
  }

  return rejected;
}

function readCategory(text: string, taken: Taken): SearchCondition[] {
  for (const [term, code] of CATEGORY_DICT) {
    const [match] = findFree(text, taken, new RegExp(escapeRegExp(term), "g"));
    if (match === undefined) continue;

    take(taken, match.index, match.index + match[0].length);

    // 카테고리는 하나만 건다. 둘째부터는 남겨 두고 사용자가 고르게 한다.
    return [{ field: "category", value: code, sourceText: match[0], origin: "rule" }];
  }

  return [];
}

function readStyleTags(text: string, taken: Taken): SearchCondition[] {
  const tags: StyleTag[] = [];
  const sources: string[] = [];

  for (const [term, code] of STYLE_DICT) {
    if (tags.includes(code)) continue;

    const [match] = findFree(text, taken, new RegExp(escapeRegExp(term), "g"));
    if (match === undefined) continue;

    take(taken, match.index, match.index + match[0].length);
    tags.push(code);
    sources.push(match[0]);
  }

  if (tags.length === 0) return [];

  return [{ field: "styleTags", value: tags, sourceText: sources.join(" "), origin: "rule" }];
}

function readRegion(text: string, taken: Taken): SearchCondition[] {
  for (const token of REGION_DICT) {
    // 행정 접미사는 함께 먹는다. "강남구" 를 "강남" 만 읽으면 '구' 가 찌꺼기로 남는다.
    const [match] = findFree(text, taken, new RegExp(`${escapeRegExp(token)}(?:특별시|광역시|시|군|구|동)?`, "g"));
    if (match === undefined) continue;

    take(taken, match.index, match.index + match[0].length);

    return [{ field: "region", value: token, sourceText: match[0], origin: "rule" }];
  }

  return [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// =============================================================================
// 진입점
// =============================================================================

/** 필드 우선순위 — 화면의 칩 순서이자 조건 표시 순서다. */
const FIELD_ORDER: SearchField[] = [
  "region",
  "category",
  "date",
  "guestCount",
  "budgetMin",
  "budgetMax",
  "styleTags",
];

export function sortConditions(conditions: SearchCondition[]): SearchCondition[] {
  return [...conditions].sort(
    (a, b) => FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field),
  );
}

/**
 * 자연어+조건 혼합 입력 → 구조화 조건.
 *
 * 읽는 순서가 곧 우선순위다. **좁은 것부터 읽는다** — 날짜의 숫자를 하객 수가 먼저
 * 먹거나, "웨딩드레스" 의 '드레스' 를 스타일이 가져가면 뒤의 해석이 전부 어긋난다.
 */
export function parseSearchQuery(input: string, options: { asOf: string }): RuleParseResult {
  const text = input.normalize("NFC");
  const taken: Taken = new Array(text.length).fill(false);

  const conditions: SearchCondition[] = [];
  const rejected: RejectedCondition[] = [];

  const collect = (result: { conditions: SearchCondition[]; rejected: RejectedCondition[] }) => {
    conditions.push(...result.conditions);
    rejected.push(...result.rejected);
  };

  rejected.push(...readAmbiguous(text, taken));
  collect(readDates(text, taken, options.asOf));
  collect(readGuestCount(text, taken));
  collect(readBudget(text, taken));
  conditions.push(...readCategory(text, taken));
  conditions.push(...readStyleTags(text, taken));
  conditions.push(...readRegion(text, taken));

  return { conditions: sortConditions(conditions), leftover: leftoverOf(text, taken), rejected };
}

/** 쓰지 않고 남은 조각. 조사·문장부호만 남은 자리는 의미가 없으므로 걷어낸다. */
function leftoverOf(text: string, taken: Taken): string {
  let buffer = "";
  for (let i = 0; i < text.length; i += 1) buffer += taken[i] ? " " : text[i];

  return buffer.replace(/\s+/g, " ").trim();
}

/**
 * AI 보조를 부를 만한 나머지가 있는가.
 *
 * 조사·접속사·문장부호만 남았으면 부르지 않는다. **호출은 비용이자 지연**이고, 남은 것이
 * "에서" 뿐인데 모델을 부르면 없는 조건을 만들어 낼 자리만 준다.
 */
export function hasMeaningfulLeftover(leftover: string): boolean {
  // 한글에는 `\b`(ASCII 낱말 경계)가 걸리지 않는다. 경계 없이 조사·상용어만 걷어낸다.
  const stripped = leftover
    .replace(/[,.!?~·\-–—/()[\]{}'"]/g, " ")
    .replace(
      /(?:에서|에게|으로|의|은|는|이|가|을|를|와|과|랑|하고|그리고|정도|쯤|좀|근처|같은|찾아|찾고|있는|해서|주세요|알려|추천|결혼|웨딩|예식)/g,
      " ",
    )
    .replace(/\s+/g, "");

  return stripped.length >= 2;
}

import { STYLE_TAGS, STYLE_TAG_LABEL } from "../schemas/onboarding";
import { SEARCH_FIELDS } from "../schemas/search";
import { VENDOR_CATEGORIES, VENDOR_CATEGORY_LABEL } from "../schemas/vendor";

/**
 * 조건 파싱 프롬프트 (S7-02 · 명세서 §5.5 1단계 · CLAUDE.md §8)
 *
 * **프롬프트는 코드로 관리하고 판본을 붙인다.** 붙이지 않으면 결과가 달라졌을 때 모델이
 * 바뀐 것인지 문구가 바뀐 것인지 알 수 없다. 이 판본은 분석 기록에 함께 남는다.
 *
 * **모델에게 추천을 시키지 않는다.** 여기서 모델이 하는 일은 오직 하나 — 룰이 못 읽은
 * 문장 조각을 **이미 정해진 필드**로 옮기는 것이다. 업체·가격·순위는 DB 조회와 랭킹이
 * 정하며 모델은 그 근처에도 가지 않는다(§5.5 — 추천 결과 자체를 LLM 이 지어내지 않는다).
 */

export const SEARCH_PARSE_PROMPT_VERSION = "search-parse@1";

/** 응답은 JSON 한 덩어리다. 길 필요가 없다. */
export const SEARCH_PARSE_MAX_TOKENS = 512;

export const SEARCH_PARSE_SYSTEM = [
  "당신은 한국어 웨딩 검색어에서 **구조화 조건만** 뽑아내는 파서다.",
  "추천하지 않고, 설명하지 않고, 업체나 가격을 언급하지 않는다.",
  "",
  "규칙:",
  "1. 결과는 JSON 객체 하나만 출력한다. 코드펜스·머리말·꼬리말을 붙이지 않는다.",
  '2. 모양은 {"conditions":[{"field":"...","value":...,"sourceText":"..."}]} 이다.',
  `3. field 는 다음 중 하나다: ${SEARCH_FIELDS.join(", ")}`,
  "4. sourceText 는 **입력 문장에서 그대로 잘라 온 부분 문자열**이어야 한다. 요약하거나 다듬지 않는다.",
  "   입력에 없는 문구를 sourceText 로 적으면 그 조건은 폐기된다.",
  "5. 입력이 말하지 않은 조건을 만들지 않는다. 확신이 없으면 그 조건을 빼고 빈 배열을 낸다.",
  "6. 이미 채워진 필드는 다시 내지 않는다.",
  "7. 값의 형식:",
  `   - region: 지역 이름 문자열(입력에 있는 표기 그대로)`,
  `   - category: ${VENDOR_CATEGORIES.map((code) => `${code}(${VENDOR_CATEGORY_LABEL[code]})`).join(", ")}`,
  "   - budgetMin / budgetMax: 원 단위 정수 (3천만원 → 30000000)",
  "   - guestCount: 정수",
  "   - date: YYYY-MM-DD",
  `   - styleTags: 배열. 값은 ${STYLE_TAGS.map((tag) => `${tag}(${STYLE_TAG_LABEL[tag]})`).join(", ")}`,
].join("\n");

/**
 * 사용자 메시지.
 *
 * **원문 전체와 남은 조각을 함께 준다.** 남은 조각만 주면 "강남" 이 빠진 문장에서 지역을
 * 지어낼 자리가 생기고, 원문만 주면 이미 읽은 것을 다시 읽어 룰과 충돌한다.
 * 기준일도 넘긴다 — 모델이 자기 시계로 상대 날짜를 풀면 재현되지 않는다.
 */
export function buildSearchParseUserMessage(input: {
  text: string;
  leftover: string;
  filledFields: string[];
  asOf: string;
}): string {
  return [
    `입력: ${input.text}`,
    `아직 해석되지 않은 부분: ${input.leftover}`,
    `이미 채워진 필드(내지 말 것): ${input.filledFields.length === 0 ? "없음" : input.filledFields.join(", ")}`,
    `오늘 날짜(상대 날짜 계산 기준): ${input.asOf}`,
  ].join("\n");
}

/** 스키마 검증 실패 시 1회 재시도에 붙이는 피드백(CLAUDE.md §8). */
export function buildSearchParseRetryMessage(error: string): string {
  return [
    "직전 응답이 형식을 벗어났다.",
    `오류: ${error}`,
    "JSON 객체 하나만, 위 규칙 그대로 다시 출력한다.",
  ].join("\n");
}

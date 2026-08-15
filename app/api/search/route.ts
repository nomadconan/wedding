import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { BUDGET_FILTER_NOTICE, LIST_PRICE_NOTICE } from "@/lib/core/schemas/explore";
import { AI_DISCLAIMER } from "@/lib/core/legal";
import { createPublicClient } from "@/lib/explore/query";
import { bodyToParams, conditionSearch, toSearchInput } from "@/lib/search/query";

/**
 * GET/POST /api/search — 조건 검색 (F-C-30, 명세서 §4.2 · §5.5)
 *
 * **랭킹 기준 코드를 응답에 반드시 싣는다**(§5.5 4단계 · D-03 · CLAUDE.md §2.2).
 * 기준 코드 없는 응답은 만들지 않는다 — 무엇으로 줄 세웠는지 말할 수 없는 추천은
 * 유료 노출과 구분되지 않는다.
 *
 * **GET 과 POST 가 같은 입력 해석을 쓴다.** POST 는 본문을 쿼리 스트링으로 옮겨 같은
 * 함수에 넣는다. 해석이 둘이면 같은 조건이 메서드에 따라 다르게 읽힌다.
 * POST 를 두는 이유는 자연어 입력이 길어질 수 있고(최대 200자) URL 로 나르면 로그·리퍼러에
 * 검색어가 남기 때문이다.
 *
 * **비로그인도 호출할 수 있다**(§1.4 guest — 조건 검색 체험). 익명 클라이언트로 조회하므로
 * 누가 부르든 같은 공개 카탈로그가 나온다.
 *
 * 쓰기가 없으므로 `Idempotency-Key` 대상이 아니다(CLAUDE.md §6).
 */
async function run(params: URLSearchParams) {
  const parsed = toSearchInput(params);
  if (!parsed.ok) return failValidation(parsed.issues);

  let outcome;
  try {
    outcome = await conditionSearch(createPublicClient(), parsed.input);
  } catch {
    // 실패 원인(쿼리·검색어)을 응답이나 로그에 싣지 않는다(CLAUDE.md §5.3).
    return fail(500, "SEARCH_FAILED", "검색하지 못했습니다.");
  }

  if (!outcome.ok) return failValidation(outcome.issues);

  return ok({
    ...outcome.result,
    notices: {
      budget: BUDGET_FILTER_NOTICE,
      listPrice: LIST_PRICE_NOTICE,
      // 조건 해석에 AI 가 관여할 수 있는 응답이다. 고지 문구를 응답에도 싣는다(CLAUDE.md §2.3).
      ai: AI_DISCLAIMER,
    },
  });
}

export async function GET(request: NextRequest) {
  return run(request.nextUrl.searchParams);
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "SEARCH_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  return run(bodyToParams(body));
}

import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { BUDGET_FILTER_NOTICE, LIST_PRICE_NOTICE } from "@/lib/core/schemas/explore";
import { createPublicClient, searchVendors, toFilterInput } from "@/lib/explore/query";

/**
 * GET /api/vendors — 업체 탐색·필터·정렬 (F-C-10, 명세서 §4.2)
 *
 * **정렬 기준 코드를 응답에 반드시 싣는다**(§4.2 · D-03 · CLAUDE.md §2.2).
 * 화면은 이 값을 `SortCriteriaBadge` 에 그대로 넣는다 — 유료 노출이 없다는 사실을
 * 문장이 아니라 응답과 화면 양쪽으로 증명한다.
 *
 * **비로그인도 호출할 수 있다**(§1.4 guest). 인증을 요구하지 않으며, 익명 클라이언트로
 * 조회하므로 누가 부르든 같은 공개 카탈로그가 나온다. 업체 멤버가 불러도 자기
 * 작성 중(draft) 상품이 섞이지 않는다.
 */
export async function GET(request: NextRequest) {
  const input = toFilterInput(request.nextUrl.searchParams);

  let outcome;
  try {
    outcome = await searchVendors(createPublicClient(), input);
  } catch {
    // 조회 실패의 원인(쿼리·행 내용)을 응답이나 로그에 싣지 않는다(CLAUDE.md §5.3).
    return fail(500, "VENDOR_SEARCH_FAILED", "업체를 불러오지 못했습니다.");
  }

  if (!outcome.ok) return failValidation(outcome.issues);

  const { result } = outcome;

  return ok({
    ...result,
    notices: {
      budget: BUDGET_FILTER_NOTICE,
      listPrice: LIST_PRICE_NOTICE,
    },
  });
}

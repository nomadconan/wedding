import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, failValidation, ok } from "@/lib/api/response";
import {
  INSUFFICIENT_SAMPLE_NOTICE,
  PRICE_INDEX_ALL,
  PRICE_INDEX_MIN_SAMPLE,
} from "@/lib/core/pricing/price-index";
import { VendorCategorySchema } from "@/lib/core/schemas/vendor";
import { createPublicClient } from "@/lib/explore/query";
import { findPriceIndex } from "@/lib/pricing/price-index-query";

/**
 * GET /api/prices — 참가격 인덱스 조회 (F-C-09, 명세서 §4.2)
 *
 * **비로그인도 부른다.** `price_index` 는 공개 데이터라 anon SELECT 가 열려 있고(§3.9),
 * 익명 클라이언트로 읽으므로 누가 부르든 같은 값이 나온다.
 *
 * **출처·표본수·수집일을 응답에 반드시 싣는다**(F-C-09). 그것 없는 지수는 신뢰의
 * 근거가 아니라 또 하나의 불투명한 숫자다. 없으면 `null` 로 내보내고 화면이 그대로
 * "출처를 모른다" 고 적는다 — 빈 문자열로 채워 있는 것처럼 보이게 하지 않는다.
 *
 * 하객수·시즌 구간은 아직 나누지 않는다(`all`). 등록 판매가에는 예식일도 하객수도
 * 없어서 구간을 만들면 없는 구분을 지어내는 일이 된다. 실거래가 적재(5단계) 때
 * 실제 값으로 나눈다.
 */
const QuerySchema = z.object({
  region: z.string().trim().min(1, "지역을 지정해 주세요.").max(40),
  category: VendorCategorySchema,
});

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  const parsed = QuerySchema.safeParse({
    region: params.get("region") ?? "",
    category: params.get("category") ?? "",
  });

  if (!parsed.success) return failValidation(parsed.error.issues);

  let row;
  try {
    row = await findPriceIndex(createPublicClient(), {
      regionCode: parsed.data.region,
      category: parsed.data.category,
    });
  } catch {
    return fail(500, "PRICE_INDEX_LOAD_FAILED", "참가격을 불러오지 못했습니다.");
  }

  // **없는 것과 부족한 것을 구분해 내보낸다.**
  // 지수가 없다는 사실 자체가 답이며, 그것을 404 로 만들면 "그런 지역은 없다"가 된다.
  return ok({
    region: parsed.data.region,
    category: parsed.data.category,
    guestBucket: PRICE_INDEX_ALL,
    season: PRICE_INDEX_ALL,
    index: row,
    available: row !== null,
    minSample: PRICE_INDEX_MIN_SAMPLE,
    notice: row === null ? INSUFFICIENT_SAMPLE_NOTICE : row.sourceNote,
  });
}

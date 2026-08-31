import type { NextRequest } from "next/server";

import { ok } from "@/lib/api/response";
import { MARKET_SORT_BASIS_NOTICE } from "@/lib/core/planner/profile";
import { rankingDisclosure } from "@/lib/core/planner/ranking";
import { loadMarket } from "@/lib/planners/loader";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/planners — 플래너 마켓 목록 (F-C-18 · §6.2 · D-03 · D-25)
 *
 * ── 비로그인도 본다 ─────────────────────────────────────────────────────────
 * `planners_select_public`(0005)이 `active` 를 anon 에게도 연다 — 마켓은 **고르기
 * 전에 둘러보는 화면**이라 로그인을 요구하면 비교 자체를 막는다. 업체 탐색
 * (`/explore`)이 같은 판단을 했다.
 *
 * ── 정렬 기준을 응답에 함께 넣는다 (§2.2 · CLAUDE.md §2.2) ──────────────────
 * "유료 노출 없음" 은 말로 주장할 것이 아니라 **정렬 기준을 보여주는 것**으로
 * 증명한다. `sortBasis` 와 고지 문구가 항상 함께 나간다.
 *
 * ── 실적은 함수로 읽는다 ────────────────────────────────────────────────────
 * 계약 건수는 `planner_contract_count`(0037)가 **개수만** 돌려준다 — 뷰로 만들면
 * `planner_settlements` 가 조인 경로로 노출되고, 그것은 FIX-13·14 가 지적한
 * "소유자 필터 없는 뷰" 와 같은 사고다.
 *
 * ── 순서의 **근거 전체**를 결과와 함께 낸다 (S6-06 · D-25) ──────────────────
 * 정렬 코드 하나만으로는 "왜 그 지표뿐인가" 를 답하지 못한다. `ranking` 이 다섯 지표를
 * **하나도 빼지 않고** 싣고, 못 세는 것은 이유를 두 종류로 갈라 적으며
 * (`pending` — 담당 태스크가 있다 / `not_distinct` — 같은 행을 센다),
 * **종합 점수를 만들지 않았다는 사실**(`compositeScore: false`)도 값으로 나간다.
 * 화면에서만 적으면 이 API 를 쓰는 다음 사람은 만들어도 되는 줄 안다(함정 3).
 *
 * **목록을 두 번 계산하지 않는다** — 순서는 `loadMarket` 하나가 만들고 여기서는
 * 그 근거만 덧붙인다.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  const payload = await loadMarket(await createClient(), {
    sort: params.get("sort"),
    category: params.get("category"),
    region: params.get("region"),
  });

  return ok({
    ...payload,
    sortBasisNotice: MARKET_SORT_BASIS_NOTICE,
    ranking: rankingDisclosure(),
  });
}

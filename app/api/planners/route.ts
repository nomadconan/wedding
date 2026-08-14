import type { NextRequest } from "next/server";

import { ok } from "@/lib/api/response";
import { MARKET_SORT_BASIS_NOTICE } from "@/lib/core/planner/profile";
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
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  const payload = await loadMarket(await createClient(), {
    sort: params.get("sort"),
    category: params.get("category"),
    region: params.get("region"),
  });

  return ok({ ...payload, sortBasisNotice: MARKET_SORT_BASIS_NOTICE });
}

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/response";
import { loadSettlements, toTaxCsv } from "@/lib/settlements/loader";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/vendor/settlements — 정산 명세 조회·자료 다운로드 (F-V-09 · §4.3)
 *
 * ── 인가는 RLS 가 한다 ──────────────────────────────────────────────────────
 * **세션 클라이언트로 읽는다.** `settlements` SELECT 정책은 **업체 대표 전용**이며
 * (0028 이 S2-08 의 앱 레벨 판정을 DB 로 내렸다) staff 에게는 빈 목록이 온다 —
 * 403 이 아니라 **안 보이는 것**이 경계다(§5.5).
 *
 * ── `?format=csv` 는 자료까지다 ─────────────────────────────────────────────
 * F-V-09 의 "세금계산서 자료 다운로드" 는 **자료**이지 발행이 아니다. 발행에는 국세청
 * 연동 또는 대행사 계약(D-28)과 사업자 정보 평문이 필요한데 후자는 우리가 갖고 있지
 * 않다(§7.2 — `biz_no_enc` 는 해시). 그 상태에서 발행을 흉내 내면 **세금계산서처럼
 * 보이는 문서**가 생기고 회계에서 실제로 쓰이게 된다.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const payload = await loadSettlements(await createClient());

  if (request.nextUrl.searchParams.get("format") === "csv") {
    return new Response(toTaxCsv(payload.settlements), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="settlements.csv"',
        // 정산 자료는 캐시하지 않는다 — 상계·확정으로 값이 바뀐다.
        "Cache-Control": "no-store",
      },
    });
  }

  return ok(payload);
}

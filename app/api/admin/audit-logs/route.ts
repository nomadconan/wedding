import type { NextRequest } from "next/server";

import { loadAuditTimeline } from "@/lib/admin/audit";
import { fail, ok } from "@/lib/api/response";
import {
  AUDIT_EXPORT_LIMIT,
  exportFilename,
  parseAuditQuery,
  toCsv,
} from "@/lib/core/audit/audit";
import { getSessionUser, isOperator } from "@/lib/supabase/auth";

/**
 * GET /api/admin/audit-logs — 감사 로그 검색·내보내기 (F-A-09, §4.3)
 *
 * `?format=csv` 로 내보낸다. 나머지 조건은 화면과 **같은 파서**를 쓴다
 * (`parseAuditQuery`) — 화면과 API 가 조건을 다르게 읽으면 "화면에 보이는 것" 과
 * "내보낸 것" 이 달라지고, 그 둘이 다른 감사 로그는 증거로 못 쓴다.
 *
 * **`force-dynamic` 을 못 박는다**(FIX-22 계열). 세션에 따라 내용이 갈리는 응답이
 * 정적으로 굳으면 권한을 잃은 사람에게 캐시된 감사 로그가 계속 나간다.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  const asCsv = params.format === "csv";

  // 내보내기는 한 번에 많이 가져간다. 화면 페이지 크기와 같으면 50줄짜리 파일이 나온다.
  const query = parseAuditQuery({
    ...params,
    limit: params.limit ?? (asCsv ? String(AUDIT_EXPORT_LIMIT) : undefined),
  });

  try {
    const payload = await loadAuditTimeline(query);

    if (asCsv) {
      return new Response(toCsv(payload.entries), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${exportFilename(new Date())}"`,
          // 감사 로그를 중간 캐시에 남기지 않는다.
          "Cache-Control": "no-store",
        },
      });
    }

    return ok({
      entries: payload.entries,
      actors: payload.actors,
      facets: payload.facets,
      hasMore: payload.hasMore,
      nextBefore: payload.nextBefore,
      /** 어떤 조건으로 조회했는지 되돌려 준다 — 버려진 조건이 있으면 여기서 드러난다. */
      appliedQuery: query,
    });
  } catch {
    return fail(500, "AUDIT_LOAD_FAILED", "감사 로그를 불러오지 못했습니다.");
  }
}

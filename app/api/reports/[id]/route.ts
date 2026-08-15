import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/response";
import { AI_DISCLAIMER } from "@/lib/core/legal";
import { REPORT_SOURCE_NOTICE, isResumable, isTerminal } from "@/lib/core/report/pipeline";
import { runAnalysis } from "@/lib/reports/analyze";
import { loadReport } from "@/lib/reports/loader";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/reports/[id] — 리포트 조회·폴링 (F-C-07, 명세서 §4.2)
 *
 * **폴링이 재개의 계기다.** 202 로 시작한 분석이 실행 도중 잘리면(서버리스에서 응답
 * 후 작업은 보장되지 않는다) `running` 인 채로 남는다. 오래 멈춘 분석을 보면 여기서
 * 다시 집는다 — 중복은 `status` 조건부 갱신이 막는다.
 *
 * **재개는 기다리지 않는다.** 폴링 요청 하나를 60초 붙들면 화면이 멈춘 것처럼 보인다.
 * 다시 집었다는 사실만 알리고, 다음 폴링이 결과를 가져간다.
 *
 * **AI 결과가 포함된 응답이라 고지를 함께 싣는다**(CLAUDE.md §2.3).
 */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const supabase = await createClient();

  // 남의 리포트는 RLS 가 막는다 — 안 보이면 **존재 여부도 알리지 않는다.**
  const report = await loadReport(supabase, params.id);
  if (report === null) return fail(404, "DOC_REPORT_NOT_FOUND", "리포트를 찾을 수 없습니다.");

  if (
    !isTerminal(report.status) &&
    isResumable({ status: report.status, updatedAt: report.updatedAt, now: Date.now() })
  ) {
    void runAnalysis({ analysisId: params.id, actorId: user.id, resume: true }).catch(() => {
      // 실패는 상태와 증적에 남는다(§5.3 — 예외를 응답·로그로 흘리지 않는다).
    });
  }

  return ok({
    ...report,
    disclaimer: AI_DISCLAIMER,
    // 룰만으로 만든 리포트인지 화면이 말할 수 있게 문구를 함께 싣는다.
    sourceNotice: REPORT_SOURCE_NOTICE,
  });
}

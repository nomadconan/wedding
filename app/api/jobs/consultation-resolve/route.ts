import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/response";
import { runResolve } from "@/lib/consultation/batch";

/**
 * POST /api/jobs/consultation-resolve — 이행 확인 자동 판정 배치 (§3.11, S4-09)
 *
 * 확인 기한이 지난 건을 §3.11 규칙대로 마무리한다 — 양측 일치면 자동 환불·몰취,
 * 불일치·한쪽 무응답이면 `disputed`, **양측 무응답이면 환불**(기본값).
 *
 * **판정은 `lib/core/consultation` 의 순수 함수 하나가 한다.** 이 배치는 대상을
 * 골라 넘길 뿐이다 — 배치가 자체 규칙을 갖는 순간 화면·API 와 답이 갈린다.
 *
 * 실행 등록은 **S8-13**. 1시간마다 부르면 된다.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  if (!secret || provided !== secret) {
    return fail(401, "JOB_UNAUTHORIZED", "실행 권한이 없습니다.");
  }

  const raw = request.nextUrl.searchParams.get("now");
  const now = raw && !Number.isNaN(Date.parse(raw)) ? raw : new Date().toISOString();

  try {
    return ok({ now, ...(await runResolve(now)) });
  } catch {
    return fail(500, "JOB_FAILED", "배치를 끝내지 못했습니다.");
  }
}

import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { FindingReportSchema } from "@/lib/core/quality/review";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/findings/[id]/report — 오탐 신고 접수 (S8-07 · F-A-04 · §4.2 신설 제안)
 *
 * **세션 롤로 쓴다.** `finding_reports_insert` 정책이 "그 finding 이 내 문서의
 * 것인가" 를 검사하고 그것이 경계다(CLAUDE.md §5.5). 서비스롤로 쓰면 앱이 그
 * 조건을 다시 구현해야 하고, 다시 구현한 조건은 언젠가 정책과 갈린다.
 *
 * **처리 상태를 입력으로 받지 않는다** — 스키마에 칸이 없고 DB 도 신고자에게
 * `status`·`resolved_*` 의 쓰기 권한을 주지 않는다(0059). 신고자가 자기 신고를
 * 닫으면 그 신고는 **운영자 큐에 아예 뜨지 않는다**(FIX-36 과 같은 모양).
 *
 * **`rule_code` 를 서버가 채운다.** 클라이언트가 보낸 값을 믿으면 신고가 엉뚱한
 * 룰에 쌓이고, 그 집계가 곧 "어떤 룰을 고칠 것인가" 의 근거다.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "AI_QUALITY_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = FindingReportSchema.safeParse({
    ...(typeof body === "object" && body !== null ? body : {}),
    // 대상은 **경로가 정한다.** 본문의 id 를 신뢰하면 화면이 가리키는 항목과 다른
    // 항목을 신고하는 요청을 만들 수 있다.
    findingId: params.id,
  });
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();

  // **세션으로 읽는다** — `findings_select` 가 남의 finding 을 이미 가린다.
  // 여기서 값을 못 읽으면 신고할 수 있는 대상이 아니라는 뜻이다.
  const { data: finding } = await supabase
    .from("findings")
    .select("id, analysis_id, rule_code")
    .eq("id", params.id)
    .maybeSingle();

  if (!finding) {
    return fail(404, "FINDING_NOT_FOUND", "해당 항목을 찾을 수 없습니다.");
  }

  // 같은 사람이 같은 항목을 같은 사유로 두 번 넣지 않는다. 사유가 다르면 받는다 —
  // 한 항목이 여러 이유로 틀릴 수 있다.
  const { data: existing } = await supabase
    .from("finding_reports")
    .select("id")
    .eq("finding_id", params.id)
    .eq("reporter_id", user.id)
    .eq("reason_code", parsed.data.reason)
    .eq("status", "open")
    .maybeSingle();

  if (existing) return ok({ findingId: params.id, duplicated: true }, { status: 200 });

  const { error } = await supabase.from("finding_reports").insert({
    finding_id: finding.id,
    analysis_id: finding.analysis_id,
    rule_code: finding.rule_code,
    reporter_id: user.id,
    reason_code: parsed.data.reason,
  });

  if (error) {
    return fail(403, "FINDING_REPORT_DENIED", "신고를 접수하지 못했습니다.");
  }

  return ok({ findingId: params.id, duplicated: false }, { status: 201 });
}

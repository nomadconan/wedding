import type { NextRequest } from "next/server";

import { recordEvent } from "@/lib/audit/record";
import { fail, failValidation, ok } from "@/lib/api/response";
import { ReportCreateSchema } from "@/lib/core/schemas/community";
import { COMMUNITY_FLAG, communityClosedNotice, isFeatureEnabled } from "@/lib/flags";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/community/reports — 신고 접수 (F-C-34, §4.2)
 *
 * **신고자와 운영자만 본다.** 피신고자에게 열면 보복이 신고를 막는다(0038 정책).
 * 그래서 이 라우트는 접수만 하고 조회를 제공하지 않는다 — 신고 목록 화면은
 * 운영자 콘솔(S7-17)이며, 신고자에게도 목록을 주지 않는다(같은 대상을 두 번 신고할 수
 * 없으므로 "이미 신고함" 만 알면 된다).
 *
 * **처리 경로는 아직 없다.** 그 사실이 커뮤니티 플래그를 끈 채로 두는 이유이며
 * (T-00f), S7-17 이 큐를 만들면 플래그를 켠다.
 */
export async function POST(request: NextRequest) {
  if (!(await isFeatureEnabled(COMMUNITY_FLAG))) {
    return fail(404, "COMMUNITY_CLOSED", communityClosedNotice());
  }

  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "COMMUNITY_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = ReportCreateSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();

  const { data: created, error } = await supabase
    .from("community_reports")
    .insert({
      target_type: parsed.data.targetType,
      target_id: parsed.data.targetId,
      reason_code: parsed.data.reasonCode,
    })
    .select("id")
    .maybeSingle();

  // 같은 대상을 두 번 신고하면 유니크가 막는다. **접수됨으로 답한다** — 이미 접수된
  // 것이 사실이고, "중복입니다" 는 신고자에게 아무 쓸모가 없다.
  if (error && String(error.code).startsWith("23")) {
    return ok({ accepted: true, duplicate: true });
  }

  const reportId = (created as { id: string } | null)?.id ?? null;
  if (error || reportId === null) {
    return fail(500, "COMMUNITY_REPORT_FAILED", "신고를 접수하지 못했어요.");
  }

  await recordEvent({
    entityType: "community_report",
    entityId: reportId,
    eventType: "community_report_created",
    actor: { id: user.id },
    afterState: "open",
    // **사유 코드만.** 신고 대상의 본문·제목을 넣지 않는다(§7.3).
    memo: `target:${parsed.data.targetType} reason:${parsed.data.reasonCode}`,
  });

  return ok({ accepted: true, duplicate: false, reportId }, { status: 201 });
}

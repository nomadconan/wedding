import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, failValidation, ok } from "@/lib/api/response";
import {
  ABUSE_SIGNAL_NOTE,
  HARD_DELETE_NOTE,
  MODERATION_ACTIONS,
} from "@/lib/core/community/moderation";
import { applyModeration, loadQueue } from "@/lib/community/moderation";
import { getSessionUser, isOperator } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * GET/PATCH /api/admin/community-reports — 신고 큐와 처리 (F-A-18, §4.2)
 *
 * **조회는 RLS 가, 변경은 서버가 막는다.** GET 은 세션 클라이언트로 읽어
 * `is_operator()` 정책이 경계이고, PATCH 는 **운영자 확인 뒤 서비스롤**로 상태를
 * 바꾼다(D-62 — 모더레이션 권한을 클라이언트가 닿는 자리에 두지 않는다).
 *
 * **사유는 세 층이 모두 요구한다** — 화면(`moderationProblem`) · 이 라우트 · DB CHECK.
 * 한 층만 두면 다른 경로로 들어온 요청이 사유 없이 지나간다.
 */
const PatchSchema = z
  .object({
    reportId: z.string().uuid(),
    action: z.enum(MODERATION_ACTIONS),
    resolution: z.string().trim().min(1, "처리 사유를 적어 주세요.").max(1_000),
  })
  .strict();

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "MOD_FORBIDDEN", "권한이 없습니다.");

  const closed = request.nextUrl.searchParams.get("state") === "closed";

  const queue = await loadQueue(await createClient(), { closed, now: Date.now() });

  return ok({
    reports: queue,
    // 신호 옆에 붙일 문장을 응답에도 싣는다 — 숫자만 보이면 기준처럼 읽힌다(O-14).
    signalNote: ABUSE_SIGNAL_NOTE,
    hardDeleteNote: HARD_DELETE_NOTE,
  });
}

export async function PATCH(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "MOD_FORBIDDEN", "권한이 없습니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "MOD_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await applyModeration({
    reportId: parsed.data.reportId,
    action: parsed.data.action,
    resolution: parsed.data.resolution,
    operatorId: user.id,
    now: new Date().toISOString(),
  });

  if (!result.ok) return fail(result.status, result.code, result.message);

  return ok({ reportStatus: result.reportStatus, postStatus: result.postStatus });
}

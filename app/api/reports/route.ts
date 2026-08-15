import type { NextRequest } from "next/server";
import { z } from "zod";

import { recordEvent } from "@/lib/audit/record";
import { fail, failValidation, ok } from "@/lib/api/response";
import { AI_DISCLAIMER } from "@/lib/core/legal";
import { runAnalysis } from "@/lib/reports/analyze";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/reports — 분석 시작 (F-C-07, 명세서 §4.2 · §5.2)
 *
 * **202 + job id 를 돌려준다**(CLAUDE.md §6 — 장시간 작업). 화면은 `GET /api/reports/[id]`
 * 를 폴링한다.
 *
 * ── 실행이 잘릴 수 있다는 사실을 설계에 넣었다 ──────────────────────────────
 * 응답을 보낸 뒤에도 계속 도는 작업은 서버리스에서 **보장되지 않는다.** 그래서
 * 두 겹으로 둔다 —
 *  (가) 여기서 실행을 시작하고,
 *  (나) 폴링(`GET`)이 오래 멈춰 있는 분석을 발견하면 **다시 집는다**(`isResumable`).
 * 중복 실행은 `status` 조건부 갱신으로 막는다(`claim`). 한 겹만 두면 잘린 분석이
 * `running` 인 채로 영영 남는다.
 *
 * **문서 소유는 RLS 가 판정한다.** 세션 클라이언트로 문서를 읽어 보이지 않으면 남의
 * 것이고, 그때는 404 다 — 존재 여부도 알리지 않는다.
 */
const BodySchema = z.object({ documentId: z.string().uuid("문서 id 형식이 아닙니다.") }).strict();

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "DOC_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();

  const { data: document } = await supabase
    .from("documents")
    .select("id, purged_at")
    .eq("id", parsed.data.documentId)
    .maybeSingle();

  if (!document) return fail(404, "DOC_NOT_FOUND", "문서를 찾을 수 없습니다.");

  // 원문이 이미 파기됐으면 다시 분석할 수 없다. **그것이 약속한 동작이다.**
  if ((document as { purged_at: string | null }).purged_at !== null) {
    return fail(409, "DOC_ALREADY_PURGED", "원문이 이미 파기되어 다시 분석할 수 없어요.");
  }

  // **분석 행은 서비스롤이 만든다.** `document_analyses` 에는 INSERT 정책이 없고
  // (0005 [41] — "실행·갱신은 서버"), 그래야 "분석이 이렇게 나왔다" 는 기록을
  // 당사자가 만들 수 없다. 소유 판정은 바로 위에서 **세션 클라이언트가 RLS 에게**
  // 물어 이미 끝냈다 — 서비스롤은 그 판정 뒤에만 쓴다.
  const { data: created } = await createAdminClient()
    .from("document_analyses")
    .insert({ document_id: parsed.data.documentId, status: "queued" })
    .select("id")
    .maybeSingle();

  const analysisId = (created as { id: string } | null)?.id ?? null;
  if (analysisId === null) {
    return fail(500, "DOC_ANALYSIS_CREATE_FAILED", "분석을 시작하지 못했습니다.");
  }

  await recordEvent({
    entityType: "document_analysis",
    entityId: analysisId,
    eventType: "analysis_queued",
    actor: { id: user.id },
    afterState: "queued",
  });

  // 실행을 시작하되 **응답을 붙들지 않는다.** 잘리면 폴링이 재개한다(위 주석).
  void runAnalysis({ analysisId, actorId: user.id }).catch(() => {
    // 실패는 `document_analyses.status` 와 증적에 남는다. 여기서 다시 던지면
    // 잡을 사람이 없고 스택에 경로가 실린다(§5.3).
  });

  return ok({ analysisId, status: "queued", disclaimer: AI_DISCLAIMER }, { status: 202 });
}

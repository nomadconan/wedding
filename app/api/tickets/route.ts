import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { TicketCreateSchema } from "@/lib/core/support/ticket";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * GET/POST /api/tickets — 문의·신고 접수 (S8-09 · F-A-06 접수 면 · §4.2 신설 제안)
 *
 * **세션 롤로 쓴다.** `tickets_insert` 정책이 `reporter_id = auth.uid()` 를 강제하고
 * **컬럼 권한이 `status`·`assignee_id`·`resolution` 을 아예 못 쓰게 한다**(0062) —
 * 신고자가 `status='resolved'` 로 접수하면 그 티켓은 **운영자 큐에 뜨지 않는다**
 * (FIX-43 · FIX-36 과 같은 모양).
 *
 * **접수 경로가 없으면 운영자 큐가 영원히 빈다.** 빈 큐는 "신고가 없다" 로 읽힌다 —
 * 화면(`/support`)과 이 라우트가 함께 있어야 F-A-06 이 성립한다(FIX-25 계열).
 *
 * **GET 은 자기 티켓만** 돌려준다. `tickets_select` 가 경계이고, 접수만 받고 결과를
 * 안 보여주면 그것은 처리가 아니다.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const supabase = await createClient();

  const { data, error } = await supabase
    .from("tickets")
    .select("id, category, subject, status, resolution, resolved_at, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) return fail(500, "TICKET_LOAD_FAILED", "문의를 불러오지 못했습니다.");

  return ok({ tickets: data ?? [] });
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "TICKET_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = TicketCreateSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();

  const { data, error } = await supabase
    .from("tickets")
    .insert({
      reporter_id: user.id,
      category: parsed.data.category,
      subject: parsed.data.subject,
      body: parsed.data.body,
    })
    .select("id")
    .maybeSingle();

  if (error || !data) {
    return fail(403, "TICKET_CREATE_DENIED", "접수하지 못했습니다.");
  }

  return ok({ ticketId: data.id }, { status: 201 });
}

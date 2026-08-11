import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { recordEvent } from "@/lib/audit/record";
import { QnaActionSchema } from "@/lib/core/schemas/qna";
import { loadQnaPosts, loadSimilarQuestions, loadVendorName } from "@/lib/qna/loader";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * GET/POST /api/qna — 업체별 문의게시판 (F-C-28, §4.2)
 *
 * **읽기는 로그인 없이도 된다.** 공개글은 anon SELECT 가 열려 있고(0021), 비공개글은
 * 작성자·해당 업체만 본다. 그 판정을 여기서 다시 하지 않는다 — RLS 가 이미 한다.
 *
 * `similar` 질의로 **유사 질문**을 먼저 보여준다(F-C-28 "중복 문의를 줄인다").
 * 공개글만 후보로 삼는다 — 비공개 질문을 "비슷한 질문" 으로 노출하면 그 자체가 유출이다.
 */
export async function GET(request: NextRequest) {
  const vendorId = request.nextUrl.searchParams.get("vendorId");
  if (!vendorId) return fail(400, "QNA_VENDOR_REQUIRED", "업체를 지정해 주세요.");

  const supabase = await createClient();
  const user = await getSessionUser();

  const vendor = await loadVendorName(supabase, vendorId);
  // 없는 것과 못 보는 것을 구분해 알려 주지 않는다(업체 상세와 같은 판단).
  if (!vendor) return fail(404, "QNA_VENDOR_NOT_FOUND", "업체를 찾을 수 없습니다.");

  const similarTo = request.nextUrl.searchParams.get("similar");

  try {
    if (similarTo) {
      return ok({
        similar: await loadSimilarQuestions(supabase, { vendorId, text: similarTo }),
      });
    }

    return ok({
      vendor,
      posts: await loadQnaPosts(supabase, { vendorId, viewerId: user?.id ?? null }),
    });
  } catch {
    return fail(500, "QNA_LOAD_FAILED", "문의를 불러오지 못했습니다.");
  }
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "QNA_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = QnaActionSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();
  const action = parsed.data;

  if (action.action === "create") {
    // author_id 는 RLS 가 auth.uid() 와 일치하도록 강제한다(0021) — 남의 이름으로
    // 질문할 수 없다. 여기서 다시 검사하지 않는 이유다.
    const { data, error } = await supabase
      .from("qna_posts")
      .insert({
        vendor_id: action.vendorId,
        author_id: user.id,
        title: action.title,
        body: action.body,
        is_public: action.isPublic,
      })
      .select("id")
      .maybeSingle();

    if (error || !data) {
      return fail(403, "QNA_CREATE_FAILED", "질문을 등록하지 못했어요. 승인된 업체인지 확인해 주세요.");
    }

    const postId = (data as { id: string }).id;

    await recordEvent({
      entityType: "qna_post",
      entityId: postId,
      eventType: "qna_post_created",
      actor: { id: user.id, role: "couple" },
      afterState: action.isPublic ? "public" : "private",
      // 제목·본문을 넣지 않는다(§7.3). 남길 사실은 공개 여부다.
      memo: null,
    });

    return ok({ postId }, { status: 201 });
  }

  if (action.action === "withdraw") {
    // **지우지 않는다.** 업체 답변이 달린 질문은 공개 기록이므로 상태로 내린다(0021).
    const { data, error } = await supabase
      .from("qna_posts")
      .update({ status: "withdrawn" })
      .eq("id", action.postId)
      .select("id")
      .maybeSingle();

    if (error) return fail(403, "QNA_FORBIDDEN", "이 질문을 바꿀 권한이 없어요.");
    if (!data) return fail(404, "QNA_NOT_FOUND", "질문을 찾을 수 없어요.");

    await recordEvent({
      entityType: "qna_post",
      entityId: action.postId,
      eventType: "qna_post_withdrawn",
      actor: { id: user.id, role: "couple" },
      afterState: "withdrawn",
      memo: null,
    });

    return ok({ postId: action.postId });
  }

  // ── 수정 (작성자만) ───────────────────────────────────────────────────────
  // 공개 전환도 여기로만 가능하다 — 0021 트리거가 "비공개 → 공개는 작성자만" 을
  // 강제하므로, 업체가 이 경로로 들어와도 DB 가 거절한다.
  const patch: Record<string, unknown> = {};
  if (action.title !== undefined) patch.title = action.title;
  if (action.body !== undefined) patch.body = action.body;
  if (action.isPublic !== undefined) patch.is_public = action.isPublic;

  if (Object.keys(patch).length === 0) {
    return fail(422, "QNA_NOTHING_TO_UPDATE", "바꿀 내용이 없어요.");
  }

  const { data, error } = await supabase
    .from("qna_posts")
    .update(patch)
    .eq("id", action.postId)
    .select("id, is_public")
    .maybeSingle();

  if (error) {
    // 트리거 메시지를 그대로 흘리지 않는다 — DB 예외문이 화면에 나가면 안 된다.
    return fail(403, "QNA_UPDATE_FORBIDDEN", "질문 본문과 공개 설정은 작성자만 바꿀 수 있어요.");
  }

  if (!data) return fail(404, "QNA_NOT_FOUND", "질문을 찾을 수 없어요.");

  await recordEvent({
    entityType: "qna_post",
    entityId: action.postId,
    eventType: "qna_post_updated",
    actor: { id: user.id, role: "couple" },
    afterState: (data as { is_public: boolean }).is_public ? "public" : "private",
    memo: null,
  });

  return ok({ postId: action.postId });
}

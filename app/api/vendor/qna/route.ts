import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { recordEvent } from "@/lib/audit/record";
import { VendorQnaActionSchema } from "@/lib/core/schemas/qna";
import { loadVendorQna } from "@/lib/qna/loader";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { findMemberVendor } from "@/lib/vendor/products";

/**
 * GET/POST /api/vendor/qna — 문의게시판 관리 (F-V-16, §4.3)
 *
 * ── 업체가 할 수 있는 일과 없는 일 ──────────────────────────────────────────
 *  · **답변 작성·수정** — 답변은 게시된 문서라 고칠 수 있다. 대화 기록(채팅)과
 *    갈리는 지점이며, 삭제는 어느 쪽도 못 한다(S4-01).
 *  · **공개 설정 변경** — 스키마에는 `boolean` 을 받지만, **비공개 → 공개는 DB
 *    트리거가 작성자에게만 허용한다**(0021). 남의 비공개 질문을 공개로 올리는 것은
 *    설정 변경이 아니라 유출이기 때문이다. 업체가 자기가 내렸던 공개글을 되돌리는
 *    것은 통과한다 — 원래 공개였던 글이라 유출이 아니다. 판정은 DB 가 한다.
 *  · **질문 본문 수정은 못 한다** — 트리거가 막는다. 업체가 고객 질문을 고쳐 쓸 수
 *    있으면 게시판이 업체의 홍보물이 된다.
 *
 * `vendor_id` 를 입력으로 받지 않는다 — 세션에서 찾는다.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const vendor = await findMemberVendor(user.id);
  if (!vendor) return fail(403, "VENDOR_NOT_FOUND", "등록된 업체가 없습니다.");

  const supabase = await createClient();

  try {
    return ok(await loadVendorQna(supabase, vendor.id));
  } catch {
    return fail(500, "QNA_LOAD_FAILED", "문의를 불러오지 못했습니다.");
  }
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const vendor = await findMemberVendor(user.id);
  if (!vendor) return fail(403, "VENDOR_NOT_FOUND", "등록된 업체가 없습니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "QNA_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = VendorQnaActionSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();
  const action = parsed.data;

  if (action.action === "answer") {
    // responder_id 는 RLS 가 auth.uid() 와 일치하도록 강제한다 — 남의 이름으로
    // 답할 수 없다. 질문 상태를 answered 로 옮기는 것은 0021 트리거의 일이라
    // 여기서 따로 쓰지 않는다(앱이 두 번 쓰면 한쪽이 빠지는 날이 온다).
    const { data, error } = await supabase
      .from("qna_answers")
      .insert({ post_id: action.postId, responder_id: user.id, body: action.body })
      .select("id")
      .maybeSingle();

    if (error || !data) {
      return fail(403, "QNA_ANSWER_FORBIDDEN", "이 질문에 답할 권한이 없어요.");
    }

    const answerId = (data as { id: string }).id;

    await recordEvent({
      entityType: "qna_answer",
      entityId: answerId,
      eventType: "qna_answered",
      actor: { id: user.id, role: "vendor" },
      afterState: "answered",
      // 답변 본문을 넣지 않는다(§7.3). 본문은 qna_answers 가 이미 들고 있다.
      memo: null,
    });

    return ok({ answerId }, { status: 201 });
  }

  if (action.action === "update_answer") {
    const { data, error } = await supabase
      .from("qna_answers")
      .update({ body: action.body })
      .eq("id", action.answerId)
      .select("id")
      .maybeSingle();

    if (error) return fail(403, "QNA_ANSWER_FORBIDDEN", "이 답변을 바꿀 권한이 없어요.");
    if (!data) return fail(404, "QNA_ANSWER_NOT_FOUND", "답변을 찾을 수 없어요.");

    await recordEvent({
      entityType: "qna_answer",
      entityId: action.answerId,
      eventType: "qna_answer_updated",
      actor: { id: user.id, role: "vendor" },
      memo: null,
    });

    return ok({ answerId: action.answerId });
  }

  // ── 공개 설정 변경 ────────────────────────────────────────────────────────
  const { data, error } = await supabase
    .from("qna_posts")
    .update({ is_public: action.isPublic })
    .eq("id", action.postId)
    .select("id, is_public")
    .maybeSingle();

  if (error) {
    // 트리거가 "비공개 → 공개는 작성자만" 으로 거절한 경우다. DB 예외문을 그대로
    // 흘리지 않고 우리 문장으로 바꾼다.
    return fail(
      403,
      "QNA_VISIBILITY_FORBIDDEN",
      "비공개 질문을 공개로 바꾸는 것은 작성자만 할 수 있어요.",
    );
  }

  if (!data) return fail(404, "QNA_NOT_FOUND", "질문을 찾을 수 없어요.");

  await recordEvent({
    entityType: "qna_post",
    entityId: action.postId,
    eventType: "qna_visibility_changed",
    actor: { id: user.id, role: "vendor" },
    afterState: (data as { is_public: boolean }).is_public ? "public" : "private",
    memo: null,
  });

  return ok({ postId: action.postId, isPublic: (data as { is_public: boolean }).is_public });
}

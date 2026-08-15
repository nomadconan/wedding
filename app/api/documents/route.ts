import type { NextRequest } from "next/server";
import { z } from "zod";

import { recordEvent } from "@/lib/audit/record";
import { fail, failValidation, ok } from "@/lib/api/response";
import {
  DOCUMENT_ACCEPTED_MIMES,
  DOCUMENT_MAX_BYTES,
  purgeScheduledAt,
  validateUpload,
} from "@/lib/core/report/pipeline";
import { findMyCouple } from "@/lib/couple/membership";
import { createDocumentUploadUrl, documentPath } from "@/lib/reports/storage";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/documents — 계약서 업로드 자리 만들기 (F-C-07, 명세서 §4.2 · §5.2 1단계)
 *
 * **파일을 받지 않는다.** 이 라우트가 만드는 것은 `documents` 행과 **서명 업로드
 * 주소**뿐이고, 파일은 클라이언트가 Storage 로 직접 올린다(§5.3 · S4-01 과 같은 판단).
 *
 * **`purge_scheduled_at` 을 여기서 반드시 넣는다**(CLAUDE.md §5.1 — 누락 불가).
 * 컬럼이 NOT NULL 이라 빠뜨리면 DB 가 막지만, 그 전에 **행을 만드는 유일한 자리**가
 * 여기이므로 값도 여기서 정한다.
 *
 * **동의 없으면 만들지 않는다**(§5.2 1단계). 판정은 `validateUpload` 가 하고 동의를
 * 가장 먼저 본다 — 파일 검사부터 하면 동의 없는 업로드가 서버까지 왔다는 뜻이 된다.
 */
const BodySchema = z
  .object({
    mime: z.string().trim().min(1),
    size: z.number().int().min(1),
    consented: z.boolean(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const membership = await findMyCouple(user.id);
  if (!membership) return fail(404, "DOC_COUPLE_NOT_FOUND", "먼저 온보딩을 마쳐 주세요.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "DOC_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const rejection = validateUpload(parsed.data);
  if (rejection !== null) {
    return fail(422, `DOC_${rejection.reason.toUpperCase()}`, rejection.message, {
      acceptedMimes: DOCUMENT_ACCEPTED_MIMES,
      maxBytes: DOCUMENT_MAX_BYTES,
    });
  }

  const supabase = await createClient();

  // **커플 데이터라 세션으로 만든다.** 서비스롤로 넣으면 RLS 가 비켜서고, 남의
  // 커플 id 를 적어 넣는 실수를 DB 가 잡아 주지 못한다.
  const { data: created } = await supabase
    .from("documents")
    .insert({
      couple_id: membership.coupleId,
      doc_type: "contract",
      // 경로는 id 가 있어야 정해지므로 자리만 잡고 아래에서 채운다.
      storage_path: "",
      mime: parsed.data.mime,
      purge_scheduled_at: purgeScheduledAt(Date.now()),
    })
    .select("id")
    .maybeSingle();

  const documentId = (created as { id: string } | null)?.id ?? null;
  if (documentId === null) {
    return fail(500, "DOC_CREATE_FAILED", "업로드 자리를 만들지 못했습니다.");
  }

  const path = documentPath(membership.coupleId, documentId);
  const ticket = await createDocumentUploadUrl(path);

  if (ticket === null) {
    await supabase.from("documents").delete().eq("id", documentId);

    return fail(500, "DOC_UPLOAD_URL_FAILED", "업로드 주소를 만들지 못했습니다.");
  }

  await supabase.from("documents").update({ storage_path: path }).eq("id", documentId);

  await recordEvent({
    entityType: "document",
    entityId: documentId,
    eventType: "document_uploaded",
    actor: { id: user.id },
    afterState: "stored",
    // 경로·파일명을 넣지 않는다(§5.3). 남길 사실은 형식과 크기뿐이다.
    memo: `mime:${parsed.data.mime} bytes:${parsed.data.size}`,
  });

  return ok(
    {
      documentId,
      upload: { signedUrl: ticket.signedUrl, token: ticket.token, path: ticket.path },
    },
    { status: 201 },
  );
}

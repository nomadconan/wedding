import type { NextRequest } from "next/server";
import { z } from "zod";

import { recordAudit } from "@/lib/audit/record";
import { fail, failValidation, ok } from "@/lib/api/response";
import {
  PRODUCT_MEDIA_ALT_TEXT_MAX,
  PRODUCT_MEDIA_TYPE,
  isPathOfProduct,
  isProductImageMime,
  productMediaPath,
  productMediaProblem,
} from "@/lib/core/product/media";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import {
  MEDIA_BUCKET,
  PRODUCT_MEDIA_COLUMNS,
  loadProductPhotos,
  readProductMediaLimit,
} from "@/lib/vendor/product-media";

/**
 * POST/PATCH/DELETE /api/vendor/products/[id]/media — 상품 사진 (C-2b · F-V-03 · §4.3)
 *
 * ── 파일이 이 서버를 지나지 않는다 ──────────────────────────────────────────
 * POST 는 **서명 업로드 주소만** 발급하고 행을 미리 만든다. 브라우저가 그 주소로
 * Storage 에 직행한다(§4.3). 파일을 Route Handler 로 받으면 본문 크기 제한·메모리·
 * 타임아웃을 전부 우리가 떠안게 되고, 얻는 것이 없다.
 *
 * ── 최종 경계는 RLS 와 Storage 다 ───────────────────────────────────────────
 * 여기서 하는 판정은 **UX 보조**다(CLAUDE.md §5.5). 실제로 막는 것은
 *  · 누가 쓰는가 → `vendor_media` 정책(상품 사진은 owner 전용 · 0076)
 *  · 남의 상품인가 → 복합 FK `vendor_media_product_same_vendor_fk`
 *  · 무엇을 올리는가 → 버킷의 `allowed_mime_types`·`file_size_limit`
 * 그래서 세션 클라이언트로 쓴다 — 서비스롤로 쓰면 이 셋 중 첫째가 꺼진다.
 */

const AddSchema = z.object({
  mimeType: z.string().trim().min(1).max(100),
  byteSize: z.number().int().positive().nullable().optional(),
  altText: z.string().trim().max(PRODUCT_MEDIA_ALT_TEXT_MAX).nullable().default(null),
});

const PatchSchema = z
  .object({
    /** id 순서가 곧 sort_order 다. 첫 장이 대표 사진이 된다. */
    order: z.array(z.string().uuid()).max(100).optional(),
    updateAlt: z
      .array(
        z.object({
          id: z.string().uuid(),
          altText: z.string().trim().max(PRODUCT_MEDIA_ALT_TEXT_MAX).nullable(),
        }),
      )
      .max(100)
      .optional(),
  })
  .refine((input) => input.order !== undefined || input.updateAlt !== undefined, {
    message: "변경할 내용이 없습니다.",
  });

const DeleteSchema = z.object({ id: z.string().uuid() });

/** 무작위 경로 조각. 업체가 보낸 파일명을 경로에 쓰지 않는다. */
function randomSlug(): string {
  return Math.random().toString(36).slice(2, 12);
}

/**
 * 이 상품이 내게 보이고 내 업체 것인가.
 *
 * **RLS 에게 묻는다** — 세션 클라이언트로 조회하므로 남의 상품이면 0행이다.
 * `vendor_id` 를 클라이언트에게 받지 않는다(받으면 그것을 검증하는 코드가 또 필요하다).
 */
async function loadOwnedProduct(
  supabase: Awaited<ReturnType<typeof createClient>>,
  productId: string,
): Promise<{ id: string; vendor_id: string; name: string } | null> {
  const { data } = await supabase
    .from("products")
    .select("id, vendor_id, name")
    .eq("id", productId)
    .maybeSingle();

  return (data as { id: string; vendor_id: string; name: string } | null) ?? null;
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "VENDOR_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = AddSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();
  const product = await loadOwnedProduct(supabase, id);
  if (!product) return fail(404, "VENDOR_PRODUCT_NOT_FOUND", "상품을 찾을 수 없습니다.");

  const photos = await loadProductPhotos(supabase, id);
  const limit = await readProductMediaLimit();

  const problem = productMediaProblem({
    mimeType: parsed.data.mimeType,
    byteSize: parsed.data.byteSize ?? null,
    altText: parsed.data.altText,
    currentCount: photos.length,
    limit,
  });

  if (problem) return fail(422, `VENDOR_MEDIA_${problem.code}`, problem.message);

  // 위 판정이 통과했으므로 형식은 허용 목록 안이다. 타입을 좁힌다.
  if (!isProductImageMime(parsed.data.mimeType)) {
    return fail(422, "VENDOR_MEDIA_MIME_NOT_ALLOWED", "지원하지 않는 형식이에요.");
  }

  const path = productMediaPath({
    vendorId: product.vendor_id,
    productId: product.id,
    mimeType: parsed.data.mimeType,
    slug: randomSlug(),
  });

  // 행을 먼저 만든다. **RLS 가 여기서 판정한다** — staff 면 이 줄에서 막히고
  // 업로드 주소는 발급되지 않는다(주소부터 주면 못 쓸 주소를 쥐여 주는 셈이다).
  const { data: row, error: insertError } = await supabase
    .from("vendor_media")
    .insert({
      vendor_id: product.vendor_id,
      product_id: product.id,
      type: PRODUCT_MEDIA_TYPE,
      storage_path: path,
      sort_order: photos.length,
      alt_text: parsed.data.altText,
    })
    .select(PRODUCT_MEDIA_COLUMNS)
    .maybeSingle();

  if (insertError || !row) {
    return fail(403, "VENDOR_MEDIA_FORBIDDEN", "이 상품의 사진을 등록할 권한이 없습니다.");
  }

  const { data: signed, error: signError } = await createAdminClient()
    .storage.from(MEDIA_BUCKET)
    .createSignedUploadUrl(path);

  if (signError || !signed) {
    // 주소를 못 만들면 **행을 남기지 않는다** — 파일 없는 사진이 목록에 뜬다.
    await supabase.from("vendor_media").delete().eq("id", row.id);

    return fail(500, "VENDOR_MEDIA_URL_FAILED", "업로드 주소를 만들지 못했습니다.");
  }

  await recordAudit({
    actorId: user.id,
    actorRole: user.role,
    action: "vendor_product_media_add",
    targetType: "product",
    targetId: product.id,
    before: null,
    after: { media_id: row.id, sort_order: row.sort_order },
  });

  return ok({
    media: { id: row.id, path, sortOrder: row.sort_order, altText: row.alt_text },
    upload: { signedUrl: signed.signedUrl, token: signed.token, path },
  });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "VENDOR_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();
  const product = await loadOwnedProduct(supabase, id);
  if (!product) return fail(404, "VENDOR_PRODUCT_NOT_FOUND", "상품을 찾을 수 없습니다.");

  const photos = await loadProductPhotos(supabase, id);
  const known = new Set(photos.map((photo) => photo.id));

  // **이 상품의 사진만 다룬다.** 남의 id 가 섞여 오면 조용히 넘기지 않고 거절한다 —
  // 넘기면 "순서를 바꿨다" 는 응답을 받고도 안 바뀐 화면을 보게 된다.
  const touched = [
    ...(parsed.data.order ?? []),
    ...(parsed.data.updateAlt ?? []).map((item) => item.id),
  ];

  if (touched.some((mediaId) => !known.has(mediaId))) {
    return fail(422, "VENDOR_MEDIA_UNKNOWN_ID", "이 상품의 사진이 아닌 항목이 있습니다.");
  }

  for (const [index, mediaId] of (parsed.data.order ?? []).entries()) {
    await supabase
      .from("vendor_media")
      .update({ sort_order: index })
      .eq("id", mediaId)
      .eq("product_id", id);
  }

  for (const item of parsed.data.updateAlt ?? []) {
    await supabase
      .from("vendor_media")
      .update({ alt_text: item.altText })
      .eq("id", item.id)
      .eq("product_id", id);
  }

  return ok({ photos: await loadProductPhotos(supabase, id) });
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "VENDOR_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = DeleteSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();
  const product = await loadOwnedProduct(supabase, id);
  if (!product) return fail(404, "VENDOR_PRODUCT_NOT_FOUND", "상품을 찾을 수 없습니다.");

  const target = photoOf(await loadProductPhotos(supabase, id), parsed.data.id);
  if (!target) return fail(404, "VENDOR_MEDIA_NOT_FOUND", "사진을 찾을 수 없습니다.");

  const { error, count } = await supabase
    .from("vendor_media")
    .delete({ count: "exact" })
    .eq("id", parsed.data.id)
    .eq("product_id", id);

  if (error) return fail(500, "VENDOR_MEDIA_DELETE_FAILED", "사진을 지우지 못했습니다.");
  if (!count) return fail(403, "VENDOR_MEDIA_FORBIDDEN", "이 사진을 지울 권한이 없습니다.");

  // **파일도 지운다.** 행만 지우면 공개 버킷의 그 주소는 계속 열린다 — 업체는
  // 내렸다고 생각하는데 링크를 아는 사람에게는 그대로 보인다.
  // 경로가 이 상품 아래인지 먼저 본다(남의 경로를 넘겨받아 지우지 않게).
  if (isPathOfProduct(target.path, { vendorId: product.vendor_id, productId: product.id })) {
    await createAdminClient().storage.from(MEDIA_BUCKET).remove([target.path]);
  }

  await recordAudit({
    actorId: user.id,
    actorRole: user.role,
    action: "vendor_product_media_remove",
    targetType: "product",
    targetId: product.id,
    before: { media_id: parsed.data.id },
    after: null,
  });

  return ok({ photos: await loadProductPhotos(supabase, id) });
}

function photoOf(photos: Awaited<ReturnType<typeof loadProductPhotos>>, id: string) {
  return photos.find((photo) => photo.id === id) ?? null;
}

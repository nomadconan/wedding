import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { ProductOptionPatchSchema } from "@/lib/core/schemas/product-option";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { OPTION_COLUMNS } from "@/lib/vendor/product-options";

/**
 * PATCH/DELETE /api/vendor/products/[id]/options/[optionId] (F-V-04, §4.3)
 *
 * 항목이 달라지면 확정이 **낡은 것**이 된다(`needsRedeclaration`). 확정을 지우지는 않는다 —
 * 게시 중 상품의 확정을 지우면 게시 조건 CHECK 와 충돌한다. 재게시 시점에 막는다.
 *
 * 조건부 추가금의 발생 조건 필수 규칙은 DB CHECK 가 최종적으로 막는다 —
 * PATCH 는 일부 필드만 오므로 병합 결과를 여기서 만들어 같은 규칙으로 검사한다.
 */
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string; optionId: string }> },
) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const { id, optionId } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "VENDOR_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = ProductOptionPatchSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const input = parsed.data;
  const supabase = await createClient();

  const { data: before } = await supabase
    .from("product_options")
    .select(OPTION_COLUMNS)
    .eq("id", optionId)
    .eq("product_id", id)
    .maybeSingle();

  if (!before) return fail(404, "VENDOR_OPTION_NOT_FOUND", "추가금 항목을 찾을 수 없습니다.");

  const isMandatory = input.isMandatory ?? before.is_mandatory;
  const conditionDescription =
    input.conditionDescription !== undefined
      ? input.conditionDescription
      : ((before.trigger_condition as { description?: string | null } | null)?.description ?? null);

  if (!isMandatory && !conditionDescription) {
    return failValidation([
      {
        path: ["conditionDescription"],
        message: "조건부 추가금은 언제 발생하는지 적어야 합니다. 항상 발생하면 '필수'로 표시하세요.",
      },
    ]);
  }

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.price !== undefined) patch.price = input.price;
  if (input.isMandatory !== undefined) patch.is_mandatory = input.isMandatory;
  if (input.isMandatory !== undefined || input.conditionDescription !== undefined) {
    patch.trigger_condition = isMandatory ? {} : { description: conditionDescription };
  }

  const { data: updated, error } = await supabase
    .from("product_options")
    .update(patch)
    .eq("id", optionId)
    .eq("product_id", id)
    .select(OPTION_COLUMNS)
    .maybeSingle();

  if (error) return fail(500, "VENDOR_OPTION_SAVE_FAILED", "추가금을 저장하지 못했습니다.");
  if (!updated) {
    return fail(403, "VENDOR_OPTION_FORBIDDEN", "추가금은 업체 대표 계정만 수정할 수 있습니다.");
  }

  const admin = createAdminClient();
  await admin.from("audit_logs").insert({
    actor_id: user.id,
    actor_role: user.role,
    action: "vendor_product_option_update",
    target_type: "product",
    target_id: id,
    before_json: { name: before.name, price: before.price },
    after_json: { name: updated.name, price: updated.price },
  });

  return ok({ option: updated });
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string; optionId: string }> },
) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const { id, optionId } = await context.params;
  const supabase = await createClient();

  const { data: deleted, error } = await supabase
    .from("product_options")
    .delete()
    .eq("id", optionId)
    .eq("product_id", id)
    .select("id, name, price")
    .maybeSingle();

  if (error) return fail(500, "VENDOR_OPTION_DELETE_FAILED", "추가금을 삭제하지 못했습니다.");
  if (!deleted) {
    return fail(403, "VENDOR_OPTION_FORBIDDEN", "추가금은 업체 대표 계정만 삭제할 수 있습니다.");
  }

  const admin = createAdminClient();
  await admin.from("audit_logs").insert({
    actor_id: user.id,
    actor_role: user.role,
    action: "vendor_product_option_delete",
    target_type: "product",
    target_id: id,
    before_json: { name: deleted.name, price: deleted.price },
  });

  return ok({ id: optionId });
}

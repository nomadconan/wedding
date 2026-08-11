import { recordEvent } from "@/lib/audit/record";
import type { VendorTemplateView } from "@/lib/core/schemas/vendor-settings";
import { validateTemplatePayload } from "@/lib/core/schemas/vendor-settings";
import type { TemplateKind } from "@/lib/core/vendor/vendor-settings";

/**
 * 업체 템플릿 (S4-04 빠른 답변 · S4-12 견적 이월)
 *
 * 한 표에 둔 이유는 0026 주석 4번에 있다 — 모양은 다르지만 수명주기·권한·화면이
 * 같다. 종류별 payload 검증은 zod 가 하고(`validateTemplatePayload`), DB 는
 * "객체인가" 까지만 본다.
 *
 * **staff 도 만든다.** 문안을 저장하는 것은 응대의 일부이고(staff 가 채팅·문의를
 * 응대한다), 잘못 만들어도 조직의 수신 경로가 바뀌지 않는다 — 0026 정책 참조.
 */
type Client = Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>;

export type TemplateFailure = { status: number; code: string; message: string };

export async function loadTemplates(
  supabase: Client,
  vendorId: string,
): Promise<VendorTemplateView[]> {
  const { data } = await supabase
    .from("vendor_templates")
    .select("id, kind, title, payload_json, sort_order")
    .eq("vendor_id", vendorId)
    .order("kind")
    .order("sort_order")
    .order("created_at");

  return ((data ?? []) as {
    id: string;
    kind: TemplateKind;
    title: string;
    payload_json: Record<string, unknown>;
    sort_order: number;
  }[]).map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    payload: row.payload_json ?? {},
    sortOrder: row.sort_order,
  }));
}

export async function createTemplate(
  supabase: Client,
  input: {
    vendorId: string;
    actorId: string;
    kind: TemplateKind;
    title: string;
    payload: unknown;
  },
): Promise<{ id: string } | TemplateFailure> {
  const validated = validateTemplatePayload(input.kind, input.payload);
  if (!validated.ok) {
    return { status: 422, code: "VENDOR_TEMPLATE_INVALID", message: validated.message };
  }

  const { data, error } = await supabase
    .from("vendor_templates")
    .insert({
      vendor_id: input.vendorId,
      kind: input.kind,
      title: input.title,
      payload_json: validated.value,
    })
    .select("id")
    .maybeSingle();

  if (error || !data) {
    // 같은 종류에 같은 이름이면 유니크가 거절한다(0026).
    return {
      status: 422,
      code: "VENDOR_TEMPLATE_FAILED",
      message: "저장하지 못했어요. 같은 이름의 템플릿이 이미 있는지 확인해 주세요.",
    };
  }

  const id = (data as { id: string }).id;

  await recordEvent({
    entityType: "vendor_settings",
    entityId: input.vendorId,
    eventType: "vendor_template_created",
    actor: { id: input.actorId, role: "vendor" },
    // 본문을 넣지 않는다(§7.3). 종류만으로 무슨 일이 있었는지 충분하다.
    memo: input.kind,
  });

  return { id };
}

export async function deleteTemplate(
  supabase: Client,
  input: { vendorId: string; actorId: string; id: string },
): Promise<{ id: string } | TemplateFailure> {
  const { data, error } = await supabase
    .from("vendor_templates")
    .delete()
    .eq("id", input.id)
    .select("id")
    .maybeSingle();

  if (error) {
    return { status: 403, code: "VENDOR_TEMPLATE_FORBIDDEN", message: "지우지 못했어요." };
  }

  if (!data) {
    return { status: 404, code: "VENDOR_TEMPLATE_NOT_FOUND", message: "템플릿을 찾을 수 없어요." };
  }

  await recordEvent({
    entityType: "vendor_settings",
    entityId: input.vendorId,
    eventType: "vendor_template_deleted",
    actor: { id: input.actorId, role: "vendor" },
    memo: null,
  });

  return { id: input.id };
}

import type { NextRequest } from "next/server";
import { z } from "zod";

import { recordEvent } from "@/lib/audit/record";
import { fail, failValidation, ok } from "@/lib/api/response";
import { COMPARE_MAX, COMPARE_MIN } from "@/lib/core/estimate/normalize";
import { findMyCouple } from "@/lib/couple/membership";
import { buildComparison } from "@/lib/estimates/loader";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * POST/DELETE /api/estimates/normalize — 비교표 스냅샷 (F-C-06 · 명세서 §4.2 · §5.4)
 *
 * ── 왜 이 경로가 '저장' 인가 ────────────────────────────────────────────────
 * §4.2 는 이 이름을 "견적 파싱·정규화" 로 적었다. 그런데 **파싱 단계가 없다** — 업체는
 * 표준 폼으로만 응답하고(F-V-07 · S4-12) 항목/금액 쌍은 이미 구조화돼 들어온다.
 * 남는 일은 **정규화 결과를 산출물로 남기는 것**이며, 그것이 `estimate_comparisons`
 * 행이다. 조회·계산은 `GET /api/estimates/compare` 가 한다.
 *
 * ── 누를 때만 남긴다 ────────────────────────────────────────────────────────
 * 비교표는 계산할 수 있는 값이라 **상시 저장하지 않는다.** 화면을 열 때마다 행이
 * 쌓이면 `estimate_comparisons` 는 기록이 아니라 로그가 된다(D-87 과 같은 판단).
 * 남기는 이유는 둘이다 — **공유하려면 행이 있어야 하고**(S7-12 의 `resource_id` 는
 * uuid 하나다), **그때 무엇을 견줬는지**를 나중에 답해야 한다(D-16·D-23).
 *
 * **저장한 표는 다시 계산하지 않는다.** 견적이 만료·변경되면 지금 계산과 달라지고
 * 그 차이 자체가 남겨 둘 사실이다. UPDATE 권한도 회수했다(0047).
 */
const SaveSchema = z
  .object({
    quoteIds: z.array(z.string().uuid()).min(COMPARE_MIN).max(COMPARE_MAX),
  })
  .strict();

async function context() {
  const user = await getSessionUser();
  if (!user) return { error: fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.") } as const;

  const membership = await findMyCouple(user.id);
  if (!membership) {
    return { error: fail(404, "ESTIMATE_COUPLE_NOT_FOUND", "먼저 온보딩을 마쳐 주세요.") } as const;
  }

  return { user, membership, supabase: await createClient() } as const;
}

export async function POST(request: NextRequest) {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "ESTIMATE_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = SaveSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const built = await buildComparison(ctx.supabase, {
    coupleId: ctx.membership.coupleId,
    quoteIds: parsed.data.quoteIds,
  });

  if ("status" in built) return fail(built.status, built.code, built.message);

  const { data, error } = await ctx.supabase
    .from("estimate_comparisons")
    .insert({
      couple_id: ctx.membership.coupleId,
      // 컬럼 이름은 업로드 경로를 전제하고 지어졌으나 들어가는 것은 **견적 id** 다(0047).
      upload_ids: parsed.data.quoteIds,
      // **그때의 환산 결과 스냅샷.** 견적이 바뀌어도 이 표는 그대로다.
      normalized_json: { estimates: built.estimates, comparison: built.comparison },
    })
    .select("id, created_at")
    .maybeSingle();

  const row = (data as { id: string; created_at: string } | null) ?? null;
  if (error || row === null) {
    return fail(500, "ESTIMATE_SAVE_FAILED", "비교표를 저장하지 못했어요.");
  }

  await recordEvent({
    entityType: "estimate_comparison",
    entityId: row.id,
    eventType: "estimate_comparison_saved",
    actor: { id: ctx.user.id },
    // **금액·업체명을 남기지 않는다**(§7.3). 행이 이미 갖고 있고 옮겨 적으면 갈린다.
    memo: `quotes:${parsed.data.quoteIds.length}`,
  });

  return ok({ id: row.id, createdAt: row.created_at }, { status: 201 });
}

/**
 * 저장한 비교표를 치운다.
 *
 * **쿼리로 받는다**(`?id=`) — DELETE 본문은 표준에 뜻이 정의돼 있지 않아 사라질 수 있고,
 * 그러면 치우는 요청이 조용히 아무것도 안 치운 채 성공으로 끝난다(D-80 과 같은 판단).
 * **없는 것을 치워도 실패가 아니다** — 결과가 요청한 대로다.
 */
export async function DELETE(request: NextRequest) {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;

  const parsed = z.string().uuid().safeParse(request.nextUrl.searchParams.get("id"));
  if (!parsed.success) return failValidation(parsed.error.issues);

  const { data } = await ctx.supabase
    .from("estimate_comparisons")
    .delete()
    .eq("id", parsed.data)
    // **소유자 필터를 넣는다.** RLS 가 경계이지만 조건을 빼면 화면이 정책에
    // 기대게 된다.
    .eq("couple_id", ctx.membership.coupleId)
    .select("id");

  const deleted = (data ?? []).length > 0;

  if (deleted) {
    await recordEvent({
      entityType: "estimate_comparison",
      entityId: parsed.data,
      eventType: "estimate_comparison_removed",
      actor: { id: ctx.user.id },
      memo: null,
    });
  }

  return ok({ id: parsed.data, deleted });
}

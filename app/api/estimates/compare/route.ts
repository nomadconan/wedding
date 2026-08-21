import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, failValidation, ok } from "@/lib/api/response";
import { COMPARE_MAX, COMPARE_MIN, NO_UPLOAD_NOTE } from "@/lib/core/estimate/normalize";
import { findMyCouple } from "@/lib/couple/membership";
import { buildComparison, listEstimateCandidates } from "@/lib/estimates/loader";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/estimates/compare — 비교표 (F-C-06 · 명세서 §4.2 · §5.4)
 *
 * **저장하지 않는다.** 비교표는 견적들에서 **계산할 수 있는 값**이므로 조회 시점에
 * 만든다(공통 제약). 남기는 것은 `POST /api/estimates/normalize` 이며 **공유하려고
 * 누를 때만** 행이 생긴다(S7-04 의 `penalty_simulations` 와 같은 규칙 · D-87).
 *
 * `quoteIds` 를 주지 않으면 **고를 수 있는 견적 목록**을 돌려준다 — 화면이 첫 진입에서
 * 쓰는 자리다.
 */
const ListSchema = z.object({
  quoteIds: z.array(z.string().uuid()).max(COMPARE_MAX).default([]),
});

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const membership = await findMyCouple(user.id);
  if (!membership) {
    return fail(404, "ESTIMATE_COUPLE_NOT_FOUND", "먼저 온보딩을 마쳐 주세요.");
  }

  const raw = request.nextUrl.searchParams.get("quoteIds");
  const parsed = ListSchema.safeParse({
    quoteIds: raw === null || raw === "" ? [] : raw.split(","),
  });
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();
  const candidates = await listEstimateCandidates(supabase, {
    coupleId: membership.coupleId,
  });

  if (parsed.data.quoteIds.length === 0) {
    return ok({
      candidates,
      comparison: null,
      estimates: [],
      // **업로드 슬롯이 왜 없는지**를 응답이 갖는다 — 화면이 문구를 다시 쓰지 않는다.
      noUploadNote: NO_UPLOAD_NOTE,
      range: { min: COMPARE_MIN, max: COMPARE_MAX },
    });
  }

  const built = await buildComparison(supabase, {
    coupleId: membership.coupleId,
    quoteIds: parsed.data.quoteIds,
  });

  if ("status" in built) return fail(built.status, built.code, built.message);

  return ok({
    candidates,
    ...built,
    noUploadNote: NO_UPLOAD_NOTE,
    range: { min: COMPARE_MIN, max: COMPARE_MAX },
  });
}

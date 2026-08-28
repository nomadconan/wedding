import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, failValidation, ok } from "@/lib/api/response";
import { loadFlagConsole, setFlag } from "@/lib/flags/admin";
import { getSessionUser, isOperator } from "@/lib/supabase/auth";

/**
 * GET/PUT /api/admin/flags/[key] — 피처 플래그 (S8-12 · F-A-10 · §4.3)
 *
 * **GET 은 키를 무시하고 전부 돌려준다.** 목록이 곧 콘솔의 내용이고, 키별 조회를
 * 따로 두면 화면이 N 번 부른다. 경로의 키는 PUT 이 쓴다.
 *
 * **조건 미충족 상태로 켜는 것을 막지 않는다**(D-145) — 긴급 롤백이 정의된 용도이고
 * 조건은 기계가 판정할 수 있는 형태가 아니다. 대신 **사유가 필수**다.
 *
 * **`updated_by` 를 입력으로 받지 않는다.** 세션이 정한다(D-144 와 같은 자리).
 *
 * **지역·세그먼트 부분 공개가 없다는 사실이 응답 본문에 실린다**(함정 3) — 화면이
 * 안 그리는 것만으로는 부족하다.
 */
export const dynamic = "force-dynamic";

const FlagUpdateSchema = z.object({
  enabled: z.boolean(),
  // 선언되지 않은 키는 서버가 버린다 — 여기서는 모양만 본다.
  partials: z.record(z.boolean()).nullable(),
  reason: z.string().trim().min(1, "왜 바꾸는지 적어 주세요.").max(500),
});

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  try {
    const payload = await loadFlagConsole();

    return ok({
      ...payload,
      segmentRolloutAvailable: payload.segmentRollout.available,
    });
  } catch {
    return fail(500, "FLAG_LOAD_FAILED", "플래그를 불러오지 못했습니다.");
  }
}

export async function PUT(request: NextRequest, { params }: { params: { key: string } }) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "FLAG_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = FlagUpdateSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await setFlag({
    ...parsed.data,
    // **대상은 경로가 정한다.** 본문의 키를 신뢰하면 화면이 가리키는 플래그와 다른
    // 플래그를 켜는 요청을 만들 수 있다.
    key: params.key,
    operatorId: user.id,
    operatorRole: user.role,
  });

  if (!result.ok) return fail(result.status, result.code, result.message);

  return ok({ key: result.key, enabled: parsed.data.enabled });
}

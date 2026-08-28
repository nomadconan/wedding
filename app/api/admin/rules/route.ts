import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, failValidation, ok } from "@/lib/api/response";
import { loadRuleConsole, updateRule } from "@/lib/rules/admin";
import { getSessionUser, isOperator } from "@/lib/supabase/auth";

/**
 * GET/PATCH /api/admin/rules — 룰·프롬프트 콘솔 (S8-06 · F-A-03 · §4.3)
 *
 * **명세는 CRUD 라고 적지만 여기에는 C 와 D 가 없다**(D-140 · 07 §2.3 반영 제안).
 * 정규식은 코드가 갖고(S7-01) DB 에만 있는 룰은 정규식이 없어 **실행되지 않는다** —
 * 만들 수 있게 하면 화면은 "추가했다" 고 말하는데 스캔은 그 룰을 모른다. 지우는 것도
 * 같다: 코드에 남아 있는 한 다음 스캔에서 되살아난다.
 *
 * **PATCH 가 만지는 칸은 셋뿐이다** — 켬/끔·지시문·근거. 목록은 `lib/rules/admin.ts`
 * 가 코드로 갖는다(서비스롤이라 DB 컬럼 권한이 적용되지 않아 **그 함수가 유일한
 * 경계**다).
 *
 * **배포 게이트가 `blocked` 로 응답 본문에 실린다**(§7.5 · FIX-42). 골든셋이 없어
 * 배포 전 회귀를 돌릴 수 없다는 사실을 화면만이 아니라 API 도 말한다 — 없는 검사를
 * 통과로 적는 것이 이 콘솔에서 가장 나쁜 실패다.
 */
export const dynamic = "force-dynamic";

const RuleUpdateSchema = z.object({
  code: z.string().regex(/^R-\d{2}$/, "룰 코드 형식이 아닙니다."),
  isActive: z.boolean(),
  // 빈 문자열은 "지웠다" 가 아니라 대개 사고다 — null 로 보내면 코드 값이 산다.
  promptFragment: z.string().trim().max(2_000).nullable(),
  basisRef: z.string().trim().max(500).nullable(),
  reason: z.string().trim().min(1, "왜 바꾸는지 적어 주세요.").max(500),
});

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  try {
    const payload = await loadRuleConsole();

    return ok({
      ...payload,
      gateBlocked: payload.gate.status === "blocked",
      ledgerEmpty: payload.ledger.status === "empty",
    });
  } catch {
    return fail(500, "RULE_CONSOLE_LOAD_FAILED", "룰 목록을 불러오지 못했습니다.");
  }
}

export async function PATCH(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "RULE_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = RuleUpdateSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await updateRule({
    ...parsed.data,
    operatorId: user.id,
    operatorRole: user.role,
  });

  if (!result.ok) return fail(result.status, result.code, result.message);

  return ok({ code: parsed.data.code, isActive: parsed.data.isActive });
}

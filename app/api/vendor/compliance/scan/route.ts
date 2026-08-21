import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { runScan } from "@/lib/compliance/scan";
import {
  COMPLIANCE_DISCLAIMER,
  SELF_SCAN_NOTICE,
  TERMS_ISSUE_NOTE,
  termsIssue,
} from "@/lib/core/compliance/compliance";
import { ComplianceScanSchema } from "@/lib/core/schemas/compliance";
import { getSessionUser } from "@/lib/supabase/auth";
import { findMemberVendor } from "@/lib/vendor/products";

/**
 * POST /api/vendor/compliance/scan — 약관 자가 진단 (F-V-10 · 명세서 §4.2)
 *
 * ── 원문이 이 경로를 지나가지만 남지 않는다 ────────────────────────────────
 * 요청 본문의 약관은 **메모리에서 마스킹·스캔**되고 구조화 결과만 저장된다
 * (CLAUDE.md §5.1 — 저장하지 않으면 파기할 것도 없다). **본문을 로그에 남기지
 * 않는다**(§5.3): 실패해도 코드와 사유만 답한다.
 *
 * ── 배지가 걸려 있다 ────────────────────────────────────────────────────────
 * 진단 결과가 `vendors.badge_flags` 를 움직인다(0050 트리거). 그래서 **행을 넣는 것은
 * 서버뿐**이고 클라이언트에 쓰기 정책이 없다 — 있으면 스캔하지 않고 통과 결과만 넣어
 * 배지를 받을 수 있다.
 *
 * `Idempotency-Key` 를 요구하지 않는다. 같은 약관을 두 번 진단하는 것은 정상 행위이고
 * (고치고 다시 돌린다) **결과가 같으므로 배지도 같다** — 막을 것이 없다.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const vendor = await findMemberVendor(user.id);
  if (!vendor) return fail(403, "VENDOR_NOT_FOUND", "등록된 업체가 없습니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "COMPLIANCE_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = ComplianceScanSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  // 길이 판정은 순수 함수가 갖는다 — 화면과 API 가 같은 문장을 쓴다.
  const issue = termsIssue(parsed.data.terms);
  if (issue !== null) {
    return fail(422, "COMPLIANCE_TERMS_INVALID", TERMS_ISSUE_NOTE[issue], { reason: issue });
  }

  const result = await runScan({
    vendorId: vendor.id,
    userId: user.id,
    terms: parsed.data.terms,
  });

  if ("status" in result) return fail(result.status, result.code, result.message);

  return ok(
    { ...result, selfScanNotice: SELF_SCAN_NOTICE, disclaimer: COMPLIANCE_DISCLAIMER },
    { status: 201 },
  );
}

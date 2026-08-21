import { fail, ok } from "@/lib/api/response";
import { badgeMaxHigh, loadLatestScan } from "@/lib/compliance/scan";
import {
  BADGE_CRITERIA_NOTICE,
  BADGE_LABEL,
  BADGE_REASON_NOTE,
  BADGE_SCOPE_NOTICE,
  COMPLIANCE_DISCLAIMER,
  SELF_SCAN_NOTICE,
  activeRuleCount,
  cleanScanNote,
  decideBadge,
} from "@/lib/core/compliance/compliance";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { findMemberVendor } from "@/lib/vendor/products";

/**
 * GET /api/vendor/compliance — 최신 자가 진단·배지 상태 (F-V-10 · §4.3)
 *
 * **`vendor_id` 를 입력으로 받지 않는다** — 세션에서 찾는다. 경계는 RLS 다(0050 [2]).
 *
 * **진단한 적이 없는 것과 0건을 응답에서 구분한다.** `scan: null` 과
 * `counts.high: 0` 은 다른 사실이고, 화면이 그 둘을 겹쳐 읽으면 "통과했다" 로 보인다.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const vendor = await findMemberVendor(user.id);
  if (!vendor) return fail(403, "VENDOR_NOT_FOUND", "등록된 업체가 없습니다.");

  const supabase = await createClient();
  const scan = await loadLatestScan(supabase, { vendorId: vendor.id });
  const ruleCount = activeRuleCount();

  return ok({
    // **진단한 적이 없으면 null 이다.** 빈 결과로 채우지 않는다.
    scan,
    badge:
      scan?.badge ?? decideBadge({ highCount: null, maxHigh: await badgeMaxHigh() }),
    badgeLabel: BADGE_LABEL,
    badgeReasonNote: BADGE_REASON_NOTE,
    badgeScopeNotice: BADGE_SCOPE_NOTICE,
    badgeCriteriaNotice: BADGE_CRITERIA_NOTICE,
    ruleCount,
    cleanNote: cleanScanNote(ruleCount),
    selfScanNotice: SELF_SCAN_NOTICE,
    disclaimer: COMPLIANCE_DISCLAIMER,
  });
}

import { fail, ok } from "@/lib/api/response";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { loadVendorStats } from "@/lib/vendor/stats";

/**
 * GET /api/vendor/stats — 성과 통계 (F-V-12, 명세서 §4.3)
 *
 * 자기 업체 데이터는 세션 클라이언트로 읽는다(RLS 가 경계다).
 * 지역 시세만 서비스롤을 쓰되 **익명 집계 결과만** 나간다(§7.7).
 *
 * **staff 도 통계를 본다.** 다만 정산 금액은 owner 전용이라 가려서 내려보낸다(§3.9).
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const supabase = await createClient();

  // RLS 가 자기 업체만 보여준다. vendor_id 를 신뢰할 필요가 없다.
  const { data: vendor, error } = await supabase
    .from("vendors")
    .select("id, name, category, region_code, status")
    .limit(1)
    .maybeSingle();

  if (error) return fail(500, "VENDOR_STATS_LOAD_FAILED", "통계를 불러오지 못했습니다.");
  if (!vendor) return fail(404, "VENDOR_NOT_FOUND", "등록된 업체가 없습니다.");

  const { data: membership } = await supabase
    .from("vendor_members")
    .select("vendor_role")
    .eq("vendor_id", vendor.id)
    .eq("user_id", user.id)
    .maybeSingle();

  const stats = await loadVendorStats(
    supabase,
    {
      id: vendor.id,
      category: vendor.category,
      regionCode: vendor.region_code,
      status: vendor.status,
    },
    { canSeeFinancials: membership?.vendor_role === "owner" },
  );

  return ok({ vendor: { id: vendor.id, name: vendor.name }, stats });
}

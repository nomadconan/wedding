import type { Metadata } from "next";
import Link from "next/link";

import { AdminShell } from "@/components/layout/AdminShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import type { AdjustType, PriceRuleType } from "@/lib/core/schemas/price-rule";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { PRICE_RULE_COLUMNS } from "@/lib/vendor/price-rules";
import { findMemberVendor } from "@/lib/vendor/products";

import { PricingManager, type PriceRuleView } from "./PricingManager";

export const metadata: Metadata = {
  title: "다이내믹 프라이싱 — 웨딩클리어",
};

/**
 * /vendor/pricing (F-V-06, §6.3)
 *
 * 조회는 사용자 세션 클라이언트로 한다 — RLS 가 자기 업체 룰만 보여준다.
 * 편집 권한은 owner 뿐이며(§3.9 가격 테이블) 화면 체크는 UX 보조다.
 *
 * **고객 노출가 계산은 이번 범위가 아니다**(3단계). 여기서는 업체가 자기 룰을
 * 시험해 보는 시뮬레이션까지만 한다.
 */
export default async function VendorPricingPage() {
  const user = await requireUser("/vendor/pricing");
  const supabase = await createClient();
  const vendor = await findMemberVendor(user.id);

  if (!vendor) {
    return (
      <AdminShell role="vendor" title="다이내믹 프라이싱">
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              assetId="vendor.dashboard.empty"
              title="아직 등록된 업체가 없어요"
              description="입점 신청을 마치면 가격 룰을 설정할 수 있습니다."
              action={
                <Button size="touch" asChild>
                  <Link href="/vendor/apply">입점 신청하러 가기</Link>
                </Button>
              }
            />
          </CardContent>
        </Card>
      </AdminShell>
    );
  }

  const { data: rows, error } = await supabase
    .from("price_rules")
    .select(PRICE_RULE_COLUMNS)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) {
    return (
      <AdminShell role="vendor" title="다이내믹 프라이싱">
        <ErrorState
          code="VENDOR_PRICE_RULE_LOAD_FAILED"
          title="가격 룰을 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }

  const { data: membership } = await supabase
    .from("vendor_members")
    .select("vendor_role")
    .eq("vendor_id", vendor.id)
    .eq("user_id", user.id)
    .maybeSingle();

  const canEdit = membership?.vendor_role === "owner";

  // 시뮬레이션 기본값. 등록된 상품이 있으면 그 총액에서 시작한다.
  const { data: product } = await supabase
    .from("products")
    .select("base_price_total")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const rules: PriceRuleView[] = (rows ?? []).map((row) => ({
    id: row.id,
    ruleType: row.rule_type as PriceRuleType,
    condition: (row.condition_json ?? {}) as Record<string, unknown>,
    adjustType: row.adjust_type as AdjustType,
    adjustValue: Math.trunc(Number(row.adjust_value)),
    floorPrice: row.floor_price,
    capPrice: row.cap_price,
    priority: row.priority,
    isActive: row.is_active,
  }));

  const active = rules.filter((rule) => rule.isActive).length;

  return (
    <AdminShell
      role="vendor"
      title="다이내믹 프라이싱"
      description={`룰 ${rules.length}개 · 켜짐 ${active}개`}
    >
      <Card>
        <CardHeader>
          <CardTitle className="text-base">가격 룰</CardTitle>
          <CardDescription>
            시즌·요일·리드타임·잔여율 조건으로 총액을 조정합니다. 고객 화면 노출은 3단계에서
            연결되며, 지금은 시뮬레이션으로 결과를 확인합니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PricingManager
            rules={rules}
            canEdit={canEdit}
            defaultBasePrice={product?.base_price_total ?? 10_000_000}
          />
        </CardContent>
      </Card>
    </AdminShell>
  );
}

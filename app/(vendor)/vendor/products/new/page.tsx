import type { Metadata } from "next";
import Link from "next/link";

import { AdminShell } from "@/components/layout/AdminShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { resolveVendorCommission } from "@/lib/pricing/vendor-rate";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { findMemberVendor } from "@/lib/vendor/products";

import { ProductForm, type RateInfo } from "../ProductForm";

export const metadata: Metadata = {
  title: "상품 등록 — 웨딩클리어",
};

/** /vendor/products/new (F-V-03) — 등록 화면. */
export default async function NewProductPage() {
  const user = await requireUser("/vendor/products/new");
  const supabase = await createClient();
  const vendor = await findMemberVendor(user.id);

  if (!vendor) {
    return (
      <AdminShell role="vendor" title="상품 등록">
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              assetId="vendor.dashboard.empty"
              title="아직 등록된 업체가 없어요"
              description="입점 신청을 마치면 상품을 등록할 수 있습니다."
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

  const { data: membership } = await supabase
    .from("vendor_members")
    .select("vendor_role")
    .eq("vendor_id", vendor.id)
    .eq("user_id", user.id)
    .maybeSingle();

  // 가격 테이블이라 쓰기는 owner 전용이다(§3.9). 화면 체크는 UX 보조이고 경계는 RLS 다.
  const canEdit = membership?.vendor_role === "owner";

  const resolved = await resolveVendorCommission(supabase, {
    vendorId: vendor.id,
    category: vendor.category,
  });

  const rate: RateInfo = resolved.available
    ? { available: true, feeRateBp: resolved.feeRateBp, scopeType: resolved.scopeType }
    : { available: false, reason: resolved.reason, detail: resolved.detail };

  return (
    <AdminShell
      role="vendor"
      title="상품 등록"
      description="총액과 포함 항목을 등록합니다. 게시 조건을 채우면 고객에게 노출할 수 있습니다."
      action={
        <Button variant="outline" asChild>
          <Link href="/vendor/products">목록으로</Link>
        </Button>
      }
    >
      <Card>
        <CardHeader>
          <CardTitle className="text-base">새 상품</CardTitle>
          <CardDescription>
            등록 직후에는 &apos;작성 중&apos; 상태입니다. 고객에게는 게시한 뒤에 보입니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ProductForm rate={rate} defaultCategory={vendor.category} canEdit={canEdit} />
        </CardContent>
      </Card>
    </AdminShell>
  );
}

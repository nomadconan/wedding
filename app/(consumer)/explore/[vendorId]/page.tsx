import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { BrokerNotice } from "@/components/domain/BrokerNotice";
import { ContactPathGuide } from "@/components/domain/ContactPathGuide";
import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/LoadingState";
import { STYLE_TAG_LABEL, type StyleTag } from "@/lib/core/schemas/onboarding";
import { VENDOR_CATEGORY_LABEL, type VendorCategory } from "@/lib/core/schemas/vendor";
import { VENDOR_FACILITY_LABEL, type VendorFacility } from "@/lib/core/schemas/vendor-profile";
import { createPublicClient } from "@/lib/explore/query";

import { AvailabilityPanel } from "./AvailabilityPanel";
import { BookConsultation } from "./BookConsultation";
import { StartChatButton } from "./StartChatButton";
import { VendorProducts } from "./VendorProducts";

export const metadata: Metadata = {
  title: "업체 상세 — 웨딩클리어",
};

/**
 * /explore/[vendorId] (F-C-10 · F-C-11 · F-C-12, §6.2)
 *
 * **미승인 업체는 접근 자체가 막힌다.** 익명 클라이언트로 조회하므로
 * `vendors_select_public`(status='active') 이 그대로 경계이며, 없는 것과 못 보는 것을
 * 구분해 알려 주지 않고 **404 로 통일한다** — "심사 중인 업체가 있다"는 사실 자체가
 * 정보이기 때문이다.
 *
 * 업체 조회는 **Suspense 밖**에 둔다. 응답이 한 번 흘러나가면 상태 코드가 200 으로
 * 굳어 `notFound()` 가 404 를 못 만든다. 무거운 나머지(상품·추가금·장바구니 상태)만
 * Suspense 안으로 넣어 로딩 상태를 준다(§6 3종 상태).
 */
export default async function VendorDetailPage({ params }: { params: { vendorId: string } }) {
  const client = createPublicClient();

  const { data: vendor } = await client
    .from("vendors")
    .select("id, name, category, region_code, intro, facilities, style_tags")
    .eq("id", params.vendorId)
    .eq("status", "active")
    .maybeSingle();

  if (!vendor) notFound();

  const styleTags = (vendor.style_tags ?? []) as string[];
  const facilities = (vendor.facilities ?? []) as string[];

  return (
    <ConsumerShell title={vendor.name}>
      <div className="space-y-4">
        <section className="space-y-2">
          <p className="text-caption text-muted-foreground">
            {VENDOR_CATEGORY_LABEL[vendor.category as VendorCategory] ?? vendor.category}
            {vendor.region_code ? ` · ${vendor.region_code}` : ""}
          </p>

          {styleTags.length > 0 ? (
            <div className="flex flex-wrap gap-1.5" data-testid="vendor-style-tags">
              {styleTags.map((tag) => (
                <Badge key={tag} variant="secondary">
                  {STYLE_TAG_LABEL[tag as StyleTag] ?? tag}
                </Badge>
              ))}
            </div>
          ) : null}

          {vendor.intro ? (
            <p className="whitespace-pre-line text-sm text-foreground">{vendor.intro}</p>
          ) : null}

          {facilities.length > 0 ? (
            <p className="text-caption text-muted-foreground">
              {facilities
                .map((code) => VENDOR_FACILITY_LABEL[code as VendorFacility] ?? code)
                .join(" · ")}
            </p>
          ) : null}
        </section>

        <Suspense fallback={<LoadingState label="상품을 불러오는 중" rows={3} variant="block" />}>
          <VendorProducts vendorId={vendor.id} />
        </Suspense>

        {/* 날짜별 잔여 슬롯 + 그날 가격(F-C-11 · F-C-12). */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">날짜별 자리와 가격</CardTitle>
            <CardDescription>
              예식일을 고르면 그날 남은 자리와 그 조건의 최종가를 보여드려요.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AvailabilityPanel vendorId={vendor.id} />
          </CardContent>
        </Card>

        {/* 상담·탐방 예약(F-C-29). 업체가 등록한 시간대에서만 고른다. */}
        <BookConsultation vendorId={vendor.id} />

        {/* 대화 시작(F-C-27). 방을 여는 것은 고객뿐이므로 여기가 유일한 진입점이다. */}
        <StartChatButton vendorId={vendor.id} />

        {/* 업체에 말을 거는 길이 셋이라 무엇이 무엇인지 화면이 설명한다(S4-12). */}
        <ContactPathGuide current="chat" vendorId={vendor.id} />

        {/* 거래로 이어지는 화면이므로 중개자 지위를 고지한다(D-24 · §6). */}
        <BrokerNotice variant="inline" />
      </div>
    </ConsumerShell>
  );
}

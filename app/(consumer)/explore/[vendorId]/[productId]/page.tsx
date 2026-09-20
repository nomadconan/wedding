import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { BrokerNotice } from "@/components/domain/BrokerNotice";
import { ContentBody } from "@/components/domain/ContentBody";
import { PriceDisplay, formatKrw } from "@/components/domain/PriceDisplay";
import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/LoadingState";
import { bpToPercentText } from "@/lib/core/pricing/dynamic";
import { STYLE_TAG_SOURCE_NOTE } from "@/lib/core/product/concept";
import { descriptionBlocks } from "@/lib/core/product/content";
import {
  NO_PRODUCT_BODY_NOTE,
  PENDING_SECTION_NOTE,
  photoSection,
} from "@/lib/core/product/detail";
import { STYLE_TAG_LABEL, type StyleTag } from "@/lib/core/schemas/onboarding";
import { ADD_ONS_POLICY_NOTICE } from "@/lib/core/schemas/product-option";
import { VENDOR_CATEGORY_LABEL, type VendorCategory } from "@/lib/core/schemas/vendor";
import { loadProductDetail } from "@/lib/products/detail-query";

import { ProductCartActions } from "./ProductCartActions";

export const metadata: Metadata = {
  title: "상품 상세 — 웨딩클리어",
};

/**
 * /explore/[vendorId]/[productId] — 상품 상세 (C-2c · F-C-38 · §6.2)
 *
 * ── 상품이 처음으로 제 주소를 갖는다 ────────────────────────────────────────
 * 그전까지 상품은 업체 상세 안의 **카드 한 장**이었다. 찜·장바구니·추가금 사전표는
 * 이미 **상품 단위**인데 보여 주는 자리가 업체 단위였다(B-1 §1-4).
 *
 * ── 가격은 업체 상세와 **같은 함수**다 ─────────────────────────────────────
 * 총액은 `PriceDisplay`, 추가금 요약은 `summarizeAddOns`(로더 안) — `VendorProducts`
 * 가 쓰는 것과 같다. 두 화면이 같은 상품에 다른 값을 말하면 정찰제가 무너진다.
 *
 * ── 404 를 만들 수 있게 조회를 페이지에 둔다 ────────────────────────────────
 * 응답이 한 번 흘러나가면 상태 코드가 200 으로 굳어 `notFound()` 가 404 를 못
 * 만든다(업체 상세가 같은 이유로 같은 모양이다). 세션이 필요한 조각
 * (찜·장바구니 상태)만 Suspense 안으로 내린다.
 *
 * **정렬 기준 배지가 없다** — 이 화면에는 정렬도 추천도 없다(§2.2 의 배지는
 * 목록의 몫이며 여기 붙이면 없는 정렬이 있는 것처럼 보인다).
 */
export default async function ProductDetailPage(props: {
  params: Promise<{ vendorId: string; productId: string }>;
}) {
  const { vendorId, productId } = await props.params;

  // 익명으로 읽는다 — RLS 가 경계다. 초안·심사 중 업체의 상품은 여기서 null 이고,
  // 경로의 업체와 상품의 업체가 다른 짝도 null 이다(로더가 본다).
  const product = await loadProductDetail({ vendorId, productId });
  if (!product) notFound();

  const photos = photoSection(product.photos);
  const blocks = descriptionBlocks(
    product.descriptionSource === null ? null : { v: 1, source: product.descriptionSource },
  );

  return (
    <ConsumerShell title={product.name}>
      <div className="space-y-4">
        {/* 어느 업체의 상품인지 먼저 말하고, 업체 상세로 돌아갈 길을 준다. */}
        <section className="space-y-1">
          <p className="text-caption text-muted-foreground">
            <Link href={`/explore/${product.vendorId}`} className="underline" data-testid="back-to-vendor">
              {product.vendorName}
            </Link>
            {" · "}
            {VENDOR_CATEGORY_LABEL[product.category as VendorCategory] ?? product.category}
            {product.vendorRegionCode ? ` · ${product.vendorRegionCode}` : ""}
          </p>
          {product.summary ? (
            <p className="text-sm text-foreground" data-testid="product-summary">
              {product.summary}
            </p>
          ) : null}

          {/* 컨셉(C-2d). **출처를 함께 적는다** — 상품이 비어 업체 태그를 상속한
              것이라면 그 사실을 말해야 한다. 업체 컨셉을 상품 컨셉처럼 그리면
              같은 업체의 두 패키지가 같은 성격인 것처럼 읽힌다. */}
          {product.styleTags.tags.length > 0 ? (
            <div className="space-y-1" data-testid="product-style-tags" data-source={product.styleTags.source}>
              <div className="flex flex-wrap gap-1.5">
                {product.styleTags.tags.map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {STYLE_TAG_LABEL[tag as StyleTag] ?? tag}
                  </Badge>
                ))}
              </div>
              {STYLE_TAG_SOURCE_NOTE[product.styleTags.source] ? (
                <p className="text-caption text-muted-foreground">
                  {STYLE_TAG_SOURCE_NOTE[product.styleTags.source]}
                </p>
              ) : null}
            </div>
          ) : null}
        </section>

        {/* ── 사진 ─────────────────────────────────────────────────────────
            게시된 상품의 사진만 공개 정책이 준다(C-2b). 없으면 **가짜 이미지를
            그리지 않고** 없다고 적는다. */}
        <section data-testid="product-photos">
          {photos.kind === "photos" ? (
            <ul className="flex snap-x gap-2 overflow-x-auto pb-1">
              {photos.photos.map((photo) => (
                <li key={photo.id} className="shrink-0 snap-start">
                  {/* eslint-disable-next-line @next/next/no-img-element -- 업체가 올린 임의 경로다. next/image 의 도메인 설정 대상이 아니다. */}
                  <img
                    src={photo.url}
                    alt={photo.altText ?? `${product.name} 사진`}
                    className="h-48 w-64 rounded-lg object-cover"
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              {photos.note}
            </p>
          )}
        </section>

        {/* ── 총액이 화면의 주인공이다(D-18) ───────────────────────────────
            추가금은 **같은 블록 안**에 있다 — 스크롤해야 발견하는 구조는 §6 위반이다. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">판매가</CardTitle>
            <CardDescription>
              등록된 판매가가 그대로 보이는 금액이에요. 추가금은 아래 사전표가 전부입니다.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <PriceDisplay
              amount={product.basePrice}
              basePrice={product.basePrice}
              taxIncluded={product.priceIncludesVat}
              addOns={product.addOns}
              // 탐색 단계에서는 아직 플래너를 고르지 않았다. 행은 숨기지 않는다(D-17).
              plannerFee={{ kind: "not_selected" }}
              size="lg"
              label="판매가"
            />

            {/* 참가격 대비(F-C-09 · S3-08). **기준이 없으면 0이 아니라 '기준 없음'** 이다. */}
            <p
              className="text-caption"
              data-testid="index-gap"
              data-state={product.baseline.kind === "measured" ? "measured" : "no-baseline"}
            >
              {product.baseline.kind === "no-baseline" ? (
                <span className="text-muted-foreground">{product.baseline.note}</span>
              ) : (
                <span
                  className={product.baseline.gapBp < 0 ? "text-success" : "text-muted-foreground"}
                >
                  참가격 중앙값({formatKrw(product.baseline.p50)}원)보다{" "}
                  {bpToPercentText(Math.abs(product.baseline.gapBp))}{" "}
                  {product.baseline.gapBp < 0
                    ? "낮아요"
                    : product.baseline.gapBp > 0
                      ? "높아요"
                      : "같아요"}
                  {" · "}표본 {product.baseline.sampleSize}곳 · {product.baseline.sourceNote}
                </span>
              )}
            </p>

            {product.capacityMin !== null || product.capacityMax !== null ? (
              <p className="text-caption text-muted-foreground">
                수용 인원 {product.capacityMin ?? "-"} ~ {product.capacityMax ?? "-"}명
              </p>
            ) : null}
          </CardContent>
        </Card>

        {/* ── 포함 항목 ───────────────────────────────────────────────────── */}
        {product.includedItems.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">포함 항목</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1" data-testid="included-items">
                {product.includedItems.map((item, index) => (
                  <li key={index} className="text-sm text-foreground">
                    · {item.label ?? item.name ?? "항목"}
                    {item.note ? (
                      <span className="ml-1 text-caption text-muted-foreground">{item.note}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}

        {/* ── 추가금 사전표 ────────────────────────────────────────────────
            등록하지 않은 항목은 계약 이후 청구할 수 없다(F-V-04). 게시 자체가
            추가금 확정을 요구하므로 여기서 `unknown` 이 보일 일은 없지만,
            **없는 상태를 화면이 지어내지 않도록** 세 갈래를 그대로 둔다. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">추가금 사전표</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2" data-testid="add-on-table">
            {product.addOns.kind === "none" ? (
              <p className="text-sm text-success">등록된 추가금이 없습니다.</p>
            ) : product.addOns.kind === "unknown" ? (
              <p className="text-sm text-warning">업체가 추가금을 등록하지 않았습니다.</p>
            ) : (
              <ul className="space-y-1">
                {product.options.map((option) => (
                  <li key={option.id} className="flex justify-between gap-2 text-sm">
                    <span className="min-w-0 text-foreground">
                      {option.name}
                      <span className="ml-1 text-caption text-muted-foreground">
                        {option.isMandatory ? "필수" : (option.condition ?? "조건부")}
                      </span>
                    </span>
                    <span data-amount="" className="shrink-0 text-unit font-medium">
                      {formatKrw(option.price)}원
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-caption text-muted-foreground">{ADD_ONS_POLICY_NOTICE}</p>
          </CardContent>
        </Card>

        {/* ── 상세 소개 (C-2b 가 채운 자리) ────────────────────────────────
            **블록으로 그린다.** 원문은 마크다운이고 `ContentBody` 가 React 요소로
            만든다 — HTML 문자열을 만들지 않으므로 본문에 `<script>` 가 있어도
            글자로 보일 뿐이다(D-97). */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">상세 소개</CardTitle>
          </CardHeader>
          <CardContent>
            {blocks.length > 0 ? (
              <div data-testid="product-body">
                <ContentBody blocks={blocks} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{NO_PRODUCT_BODY_NOTE}</p>
            )}
          </CardContent>
        </Card>

        {/* ── 찜·장바구니 (이미 상품 단위였다 — 여기서 잇는다) ──────────────
            세션이 필요하므로 Suspense 안으로 내린다. 페이지의 404 는 이미 확정됐다. */}
        <Suspense fallback={<LoadingState label="담기 상태를 불러오는 중" rows={1} variant="block" />}>
          <ProductCartActions vendorId={product.vendorId} productId={product.id} />
        </Suspense>

        {/* 견적 요청(F-C-13 · FIX-66). 업체 상세와 **같은 길**로 보낸다 —
            여기서 1:1 문의를 새로 만들면 채팅과 구분이 사라진다(S4-12 · CONTACT_PATHS). */}
        <Button variant="outline" size="touch" className="w-full" asChild>
          <Link
            href={`/inquiries/new?vendor=${product.vendorId}`}
            data-testid="product-inquiry-link"
          >
            이 업체에 견적 요청하기
          </Link>
        </Button>

        {/* ── 아직 열지 않은 자리 ──────────────────────────────────────────
            **빈 칸으로 두지 않는다.** 빈 칸은 *이 상품에는 해당이 없다* 로도 읽힌다.
            컨셉 태그·상품 후기·주문 기한은 다른 태스크가 채운다. */}
        <Card data-testid="pending-sections">
          <CardHeader>
            <CardTitle className="text-base">아직 준비 중인 것</CardTitle>
            <CardDescription>
              이 상품에 없는 것이 아니라, 아직 우리가 만들지 못한 자리예요.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1.5">
              {Object.entries(PENDING_SECTION_NOTE).map(([key, note]) => (
                <li key={key} className="text-sm text-muted-foreground">
                  {note}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        {/* 거래로 이어지는 화면이므로 중개자 지위를 고지한다(D-24 · §6). */}
        <BrokerNotice variant="inline" />
      </div>
    </ConsumerShell>
  );
}

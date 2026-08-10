import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import {
  INSUFFICIENT_SAMPLE_NOTICE,
  PRICE_INDEX_ALL,
  PRICE_INDEX_MIN_SAMPLE,
} from "@/lib/core/pricing/price-index";
import { VENDOR_CATEGORIES, VENDOR_CATEGORY_LABEL, type VendorCategory } from "@/lib/core/schemas/vendor";
import { createPublicClient } from "@/lib/explore/query";
import { findPriceIndex } from "@/lib/pricing/price-index-query";

import { PriceDistribution } from "./PriceDistribution";

type Params = { region: string; category: string };

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const region = decodeURIComponent(params.region);
  const label = VENDOR_CATEGORY_LABEL[params.category as VendorCategory] ?? params.category;

  return {
    title: `${region} ${label} 가격 — 웨딩클리어`,
    description: `${region} ${label}의 등록 판매가 분포를 표본수·출처와 함께 공개합니다.`,
  };
}

/**
 * /prices/[region]/[category] (F-C-09, §6.1)
 *
 * **비로그인도 열린다**(§1.4 guest). SEO 대상 페이지이고, 가격을 공개하는 것이
 * 이 제품의 주장이므로 로그인 뒤에 숨기지 않는다.
 *
 * 로딩 상태는 `loading.tsx` 가 아니라 **페이지 안쪽 Suspense** 다. 라우트 파일로 두면
 * 그 경계가 아래의 `notFound()` 를 삼켜 200 이 된다(S3-03 에서 확인). 없는 카테고리에
 * 소프트 404 를 내보내면 검색엔진에 빈 페이지가 쌓인다.
 */
export default function PriceReportPage({ params }: { params: Params }) {
  // **카테고리는 값 집합이 정해져 있다.** 없는 코드는 페이지가 성립하지 않으므로 404 다.
  // 지역은 자유 입력이라 같은 판정을 할 수 없다 — 아래에서 '표본 없음'으로 다룬다.
  if (!(VENDOR_CATEGORIES as readonly string[]).includes(params.category)) notFound();

  const region = decodeURIComponent(params.region);
  const category = params.category as VendorCategory;

  return (
    <ConsumerShell title={`${region} ${VENDOR_CATEGORY_LABEL[category]} 가격`}>
      <Suspense fallback={<LoadingState label="가격 분포를 불러오는 중" rows={3} variant="block" />}>
        <ReportSection region={region} category={category} />
      </Suspense>
    </ConsumerShell>
  );
}

async function ReportSection({ region, category }: { region: string; category: VendorCategory }) {
  let index;
  try {
    index = await findPriceIndex(createPublicClient(), { regionCode: region, category });
  } catch {
    return (
      <ErrorState
        code="PRICE_INDEX_LOAD_FAILED"
        title="가격 분포를 불러오지 못했어요"
        description="잠시 후 다시 시도해 주세요."
      />
    );
  }

  const exploreHref = `/explore?region=${encodeURIComponent(region)}&category=${category}`;

  if (index === null) {
    // **404 가 아니라 빈 상태다.** 지역은 자유 입력이라 "없는 지역" 을 판정할 수 없고,
    // 표본이 아직 모이지 않았다는 사실 자체가 이 페이지가 말할 내용이다.
    // 404 를 내면 "그런 지역은 없다" 는 틀린 신호가 된다.
    return (
      <div className="space-y-4">
        <EmptyState
          assetId="explore.empty"
          title="아직 가격 분포를 만들 만큼 모이지 않았어요"
          description={INSUFFICIENT_SAMPLE_NOTICE}
          action={
            <Link href={exploreHref} className="text-sm font-medium text-brand-600">
              {region} {VENDOR_CATEGORY_LABEL[category]} 업체 보기
            </Link>
          }
        />
        <p className="text-caption text-muted-foreground" data-testid="min-sample">
          표본 하한 {PRICE_INDEX_MIN_SAMPLE}곳
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="price-report">
      {/*
        **가장 먼저 말하는 것이 출처다.** 무엇으로 만든 숫자인지 모르면 사분위는
        신뢰의 근거가 아니라 또 하나의 불투명한 값이다(F-C-09).
      */}
      <Card>
        <CardContent className="space-y-1 pt-5">
          <p className="text-sm font-medium text-foreground" data-testid="source-label">
            {index.sourceLabel ?? "출처를 알 수 없는 값"}
          </p>
          <p className="text-caption text-muted-foreground" data-testid="source-note">
            {index.sourceNote ?? "이 지수가 어떤 표본으로 만들어졌는지 기록이 없습니다."}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-5">
          <PriceDistribution index={index} />
        </CardContent>
      </Card>

      {/* 표본수·수집일은 상시 표기다(F-C-09). 접거나 숨기지 않는다. */}
      <dl className="space-y-1 rounded-lg border border-border p-4" data-testid="index-meta">
        <div className="flex justify-between gap-2">
          <dt className="text-unit text-muted-foreground">표본</dt>
          <dd className="text-unit font-medium text-foreground">업체 {index.sampleSize}곳</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-unit text-muted-foreground">수집 시점</dt>
          <dd className="text-unit font-medium text-foreground">
            {index.collectedAt ? index.collectedAt.slice(0, 10) : "기록 없음"}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-unit text-muted-foreground">구간</dt>
          <dd className="text-unit font-medium text-foreground">
            {index.guestBucket === PRICE_INDEX_ALL && index.season === PRICE_INDEX_ALL
              ? "하객수·시즌 구분 없음"
              : `${index.guestBucket} · ${index.season}`}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-unit text-muted-foreground">버전</dt>
          <dd className="text-unit font-medium text-foreground">{index.version}</dd>
        </div>
      </dl>

      <p className="text-caption text-muted-foreground">
        업체당 한 곳을 한 번만 셉니다. 상품을 많이 올린 업체가 분포를 좌우하지 않도록
        각 업체의 가장 낮은 판매가를 표본으로 씁니다.
      </p>

      <Link
        href={exploreHref}
        className="block rounded-md bg-primary px-3 py-2 text-center text-sm font-medium text-primary-foreground"
        data-testid="explore-cta"
      >
        이 조건으로 업체 보기
      </Link>
    </div>
  );
}

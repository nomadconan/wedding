import Link from "next/link";

import { CartActions } from "@/components/domain/CartActions";
import { bpToPercentText } from "@/lib/core/pricing/dynamic";
import { NO_INDEX_BASELINE_NOTE } from "@/lib/core/pricing/price-index";
import { PriceDisplay, type PriceAddOns } from "@/components/domain/PriceDisplay";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  AVAILABILITY_LABEL,
  AVAILABILITY_NOTE,
  type AvailabilityState,
} from "@/lib/core/schemas/explore";
import { STYLE_TAG_LABEL, type StyleTag } from "@/lib/core/schemas/onboarding";
import { VENDOR_CATEGORY_LABEL, type VendorCategory } from "@/lib/core/schemas/vendor";
import type { ExploreRow } from "@/lib/explore/query";

/**
 * 목록 카드 (F-C-10, §6.2 `/explore`)
 *
 * **가격이 주인공이다**(D-18 · §6 공통 UI 규칙). 카드에서 가장 큰 것은 총액이고,
 * 추가금은 **같은 블록 안에서** 확인된다 — `PriceDisplay` 가 그 규칙을 타입으로 강제한다.
 *
 * 이미지는 `loading="lazy"` 인 `AssetImage` 계열만 쓰고, 카드 자체는 순수 서버
 * 컴포넌트다(§6 WebView 성능 가드 — 목록에 클라이언트 상태를 얹지 않는다).
 */
export type VendorCardProps = {
  row: ExploreRow;
  /** 이미 장바구니에 담긴 상품인지. 비로그인이면 항상 false 다. */
  inCart: boolean;
  /** 이미 찜한 상품인지. */
  inWishlist: boolean;
  /** 담기 버튼의 동작. 로그인 전이면 로그인으로 보낸다. */
  signedIn: boolean;
  /**
   * 예약 가능 여부를 보일지. **날짜를 골랐을 때만 true 다.**
   * 날짜가 없으면 '미확인'조차 사실이 아니다 — 물어본 적이 없기 때문이다.
   */
  showAvailability: boolean;
  /** 참가격 대비 편차를 보일지. 그 기준으로 정렬했을 때만 보인다. */
  showGap: boolean;
};

/** DB 의 추가금 상태를 화면 상태로 옮긴다. '없음'과 '미등록'을 섞지 않는다(S2-04). */
export function toPriceAddOns(addOns: ExploreRow["addOns"]): PriceAddOns {
  if (addOns.declaredAt === null) return { kind: "unknown" };
  if (addOns.count === 0) return { kind: "none" };

  return { kind: "listed", count: addOns.count, total: addOns.total };
}

const AVAILABILITY_TONE: Record<AvailabilityState["kind"], string> = {
  available: "bg-success/10 text-success",
  full: "bg-muted text-muted-foreground",
  blocked: "bg-muted text-muted-foreground",
  unknown: "bg-muted text-muted-foreground",
};

export function VendorCard({
  row,
  inCart,
  inWishlist,
  signedIn,
  showAvailability,
  showGap,
}: VendorCardProps) {
  const availability = row.availability;

  return (
    <Card data-testid="vendor-card" data-vendor-id={row.vendorId}>
      <CardContent className="space-y-3 pt-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <Link
              href={`/explore/${row.vendorId}`}
              className="block truncate text-base font-semibold text-foreground"
            >
              {row.vendorName}
            </Link>
            <p className="truncate text-caption text-muted-foreground">
              {VENDOR_CATEGORY_LABEL[row.category as VendorCategory] ?? row.category}
              {row.regionCode ? ` · ${row.regionCode}` : ""}
            </p>
          </div>
          {inCart ? (
            <Badge variant="secondary" data-testid="in-cart">
              담김
            </Badge>
          ) : null}
        </div>

        <p className="truncate text-sm text-foreground">{row.productName}</p>

        {/* 총액이 카드에서 가장 크다. 추가금은 같은 블록 안에 있다. */}
        <PriceDisplay
          amount={row.basePrice}
          basePrice={row.basePrice}
          taxIncluded={row.priceIncludesVat}
          addOns={toPriceAddOns(row.addOns)}
          // 탐색 단계에서는 아직 플래너를 고르지 않았다. 행은 숨기지 않는다(D-17).
          plannerFee={{ kind: "not_selected" }}
          size="sm"
          label="판매가"
        />

        {/*
          참가격 대비 편차(F-C-09 · S3-08). **기준이 없으면 0이 아니라 '기준 없음'** 이다 —
          지수가 없는 것은 업체가 한 일이 아니라 아직 표본이 모이지 않았다는 우리 쪽 사정이다.
        */}
        {showGap ? (
          <p className="text-caption" data-testid="index-gap" data-state={row.gapBp === null ? "no-baseline" : "measured"}>
            {row.gapBp === null ? (
              <span className="text-muted-foreground">{NO_INDEX_BASELINE_NOTE}</span>
            ) : (
              <span className={row.gapBp < 0 ? "text-success" : "text-muted-foreground"}>
                참가격 중앙값보다 {bpToPercentText(Math.abs(row.gapBp))}{" "}
                {row.gapBp < 0 ? "낮아요" : row.gapBp > 0 ? "높아요" : "같아요"}
              </span>
            )}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-1.5">
          {row.styleTags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="rounded-md bg-secondary px-2 py-0.5 text-caption text-secondary-foreground"
            >
              {STYLE_TAG_LABEL[tag as StyleTag] ?? tag}
            </span>
          ))}
          {row.includedItemCount > 0 ? (
            <span className="text-caption text-muted-foreground">
              포함 {row.includedItemCount}항목
            </span>
          ) : null}
        </div>

        {/* 날짜를 골랐을 때만 의미가 있다. 안 골랐으면 상태를 지어내지 않는다. */}
        {showAvailability ? (
          <div className="flex items-center justify-between gap-2" data-testid="availability">
            <span
              className={`rounded-md px-2 py-0.5 text-caption font-medium ${AVAILABILITY_TONE[availability.kind]}`}
              data-state={availability.kind}
            >
              {AVAILABILITY_LABEL[availability.kind]}
              {availability.kind === "available" ? ` · ${availability.remaining}자리` : ""}
            </span>
            <span className="text-caption text-muted-foreground">
              {AVAILABILITY_NOTE[availability.kind]}
            </span>
          </div>
        ) : null}

        <div className="flex gap-2">
          <Link
            href={`/explore/${row.vendorId}`}
            className="flex-1 rounded-md border border-border px-3 py-2 text-center text-sm font-medium text-foreground"
          >
            자세히 보기
          </Link>
          <CartActions
            productId={row.productId}
            vendorId={row.vendorId}
            inCart={inCart}
            inWishlist={inWishlist}
            signedIn={signedIn}
            next={`/explore/${row.vendorId}`}
          />
        </div>
      </CardContent>
    </Card>
  );
}

export default VendorCard;

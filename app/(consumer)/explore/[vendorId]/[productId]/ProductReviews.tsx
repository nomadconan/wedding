import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  RATING_AXIS_LABEL,
  RATING_BASIS,
  RATING_COMPOSITION,
  type VendorRating,
} from "@/lib/core/review/rating";
import type { PublicReview } from "@/lib/reviews/read";

/**
 * 상품 단위 검증 후기 (C-2e · F-C-17 확장 · §6.2)
 *
 * ── 평균은 건수 없이 나가지 않는다 ──────────────────────────────────────────
 * S8-11 이 세운 규칙 그대로다. 문구(`productRatingCaption`)를 화면이 손으로 적지
 * 않고 함수에서 받는다 — 손으로 적으면 한 화면이 빠지고, 빠진 화면은 표본 하나짜리
 * 평점을 확정된 사실처럼 보여준다.
 *
 * ── 업체 평점과 분모가 다르다는 것을 말한다 ────────────────────────────────
 * "검증 후기 3건" 이 업체 전체인지 이 상품인지 구분되지 않으면 같은 숫자가 두 가지를
 * 뜻한다. 그래서 문구가 **"이 상품"** 을 붙이고, 합산 규칙도 함께 적는다.
 *
 * ── 없으면 0 이 아니라 없다고 적는다 ────────────────────────────────────────
 * 0.0 은 "최악" 으로 읽힌다(D-96·D-108).
 *
 * ── 데이터를 **props 로 받는다** ────────────────────────────────────────────
 * 화면이 자기 조회를 따로 하면 `GET /api/products/[id]` 와 다른 것을 볼 수 있다.
 * 상세 로더(`loadProductDetail`)가 한 번 읽어 화면과 API 에 **같은 값**을 준다.
 */
export function ProductReviews({
  rating,
  caption,
  reviews,
}: {
  rating: VendorRating;
  /** 평균 옆에 반드시 붙는 문장. **화면이 만들지 않는다**(로더가 함수에서 받아 넘긴다). */
  caption: string;
  reviews: PublicReview[];
}) {
  return (
    <Card data-testid="product-reviews">
      <CardHeader>
        <CardTitle className="text-base">이 상품 후기</CardTitle>
        {/* 평균 옆에 반드시 붙는 문장. 함수가 만든다. */}
        <CardDescription data-testid="product-rating-caption">{caption}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {rating.reviewCount === 0 ? (
          <p className="text-sm text-muted-foreground">
            아직 이 상품에 달린 검증 후기가 없어요. 이 업체의 다른 후기는 업체 상세에서 볼 수 있어요.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-unit font-semibold text-foreground" data-testid="product-rating-overall">
                {rating.overall}
              </span>
              {rating.axes.map((axis) => (
                <span key={axis.axis} className="text-caption text-muted-foreground">
                  {RATING_AXIS_LABEL[axis.axis]}{" "}
                  {/* 축마다 응답 수가 다르다 — 없으면 0 이 아니라 '—' 다. */}
                  {axis.average === null ? "—" : `${axis.average} (${axis.sampleSize}건)`}
                </span>
              ))}
            </div>

            <ul className="space-y-3">
              {reviews.map((review) => (
                <li key={review.id} className="rounded-lg border border-border p-3">
                  {review.body ? (
                    <p className="whitespace-pre-line text-sm text-foreground">{review.body}</p>
                  ) : (
                    <p className="text-sm text-muted-foreground">점수만 남긴 후기예요.</p>
                  )}
                  {review.disclosedAmount !== null ? (
                    <p className="mt-1 text-caption text-muted-foreground">
                      작성자가 공개한 실지출 {review.disclosedAmount.toLocaleString()}원
                    </p>
                  ) : null}
                  {review.vendorReply ? (
                    <p className="mt-2 rounded-md bg-muted p-2 text-caption text-foreground">
                      업체 답변 · {review.vendorReply}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        )}

        {/* 산정 기준을 화면이 적는다(F-V-11). 접지 않는다. */}
        <details className="text-caption text-muted-foreground">
          <summary>평점 산정 기준</summary>
          <ul className="mt-1 space-y-0.5">
            {RATING_BASIS.rules.map((rule) => (
              <li key={rule}>· {rule}</li>
            ))}
            {RATING_COMPOSITION.rules.map((rule) => (
              <li key={rule}>· {rule}</li>
            ))}
          </ul>
        </details>
      </CardContent>
    </Card>
  );
}

export default ProductReviews;

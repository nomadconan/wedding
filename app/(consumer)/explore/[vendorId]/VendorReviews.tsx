import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { dateTimeAttr, formatTimestamp } from "@/lib/core/format/timestamp";
import { RATING_AXIS_LABEL, ratingCaption } from "@/lib/core/review/rating";
import { loadVendorRating, loadVendorReviews } from "@/lib/reviews/read";

/**
 * 업체 상세의 '검증 후기' (F-C-17 열람 면 · 명세서 §6.2 · S8-11)
 *
 * **커뮤니티 언급과 시각적으로 분리한다.** 명세가 "두 영역을 같은 카드 모양으로
 * 그리지 않는다" 고 적었고, `CommunityMentions` 가 점선 테두리를 잡아 두었다 —
 * 여기는 **실선 카드**다. 모양이 같으면 라벨은 읽히지 않는다.
 *
 * **평균만 크게 그리지 않는다.** 건수가 항상 붙고, 산정 기준(무엇을 셌고 축을 어떻게
 * 가중했는지)이 같은 카드 안에 있다 — 광고를 받지 않는 대신 순서와 점수의 근거를
 * 밝히기로 한 서비스다(D-03 · CLAUDE.md §2.2). 정렬 기준 배지와 같은 규칙이다.
 *
 * **후기가 없으면 그 사실을 적는다.** 섹션을 통째로 감추면 "후기가 없다" 와 "이
 * 업체에는 후기 기능이 없다" 가 구분되지 않는다 — 커뮤니티 언급과 다른 판단이며
 * (그쪽은 기능이 아직 닫혀 있어 감춘다) 이쪽은 열려 있다.
 */
export async function VendorReviews({ vendorId }: { vendorId: string }) {
  const [rating, reviews] = await Promise.all([
    loadVendorRating(vendorId).catch(() => null),
    loadVendorReviews(vendorId).catch(() => []),
  ]);

  if (rating === null) return null;

  return (
    <Card data-testid="vendor-reviews">
      <CardHeader>
        <CardTitle className="text-base">검증 후기</CardTitle>
        <CardDescription>
          <strong>계약이 확정된 거래에만</strong> 달립니다. 아래 커뮤니티 언급과 달리 거래
          기록으로 확인된 평가입니다.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-2xl font-semibold text-foreground">
            {rating.overall === null ? "—" : rating.overall.toFixed(1)}
          </span>
          <span className="text-caption text-muted-foreground">{ratingCaption(rating)}</span>
        </div>

        {rating.reviewCount > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {rating.axes.map((axis) => (
              <li key={axis.axis}>
                <Badge variant="outline">
                  {RATING_AXIS_LABEL[axis.axis]}{" "}
                  {axis.average === null ? "점수 없음" : axis.average.toFixed(1)}
                  <span className="ml-1 font-normal">({axis.sampleSize}건)</span>
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}

        {/* 산정 기준을 값 옆에 둔다(F-V-11 이 요구하고 소비자에게도 같은 값을 보인다). */}
        <details className="rounded-md border border-border p-3">
          <summary className="cursor-pointer text-caption font-medium text-foreground">
            평점을 어떻게 냈나요? · {rating.basis.label}
          </summary>
          <ul className="mt-2 space-y-0.5">
            {rating.basis.rules.map((rule) => (
              <li key={rule} className="text-caption text-muted-foreground">
                · {rule}
              </li>
            ))}
          </ul>
        </details>

        {reviews.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            아직 이 업체의 검증 후기가 없어요. 거래가 끝난 분이 남기면 여기에 보입니다.
          </p>
        ) : (
          <ul className="space-y-3">
            {reviews.map((review) => (
              <li key={review.id} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-caption text-muted-foreground">
                    {[
                      ["가격 투명성", review.scorePrice],
                      ["응대", review.scoreResponse],
                      ["이행", review.scoreFulfillment],
                    ]
                      .filter(([, value]) => value !== null)
                      .map(([label, value]) => `${label} ${value}`)
                      .join(" · ") || "점수 없음"}
                  </span>
                  {review.disclosedAmount !== null ? (
                    <Badge variant="outline">
                      실지출 {review.disclosedAmount.toLocaleString("ko-KR")}원
                    </Badge>
                  ) : null}
                </div>

                {review.body ? (
                  <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{review.body}</p>
                ) : null}

                {review.vendorReply ? (
                  <p className="mt-2 rounded-md bg-muted p-2 text-sm text-foreground">
                    업체 답변 — {review.vendorReply}
                  </p>
                ) : null}

                <p className="mt-2 text-caption text-muted-foreground">
                  <time dateTime={dateTimeAttr(review.createdAt)}>
                    {formatTimestamp(review.createdAt)}
                  </time>
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

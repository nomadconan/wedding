"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  RATING_AXES,
  RATING_AXIS_LABEL,
  RATING_BASIS,
  RATING_MAX,
  RATING_MIN,
  type RatingAxis,
} from "@/lib/core/review/rating";
import { ReviewCreateSchema } from "@/lib/core/review/write";

/**
 * 후기 작성 폼 (S8-11 · F-C-17)
 *
 * ── 이 폼이 지키는 규칙 ─────────────────────────────────────────────────────
 * 1. **실지출 공개는 기본이 꺼짐이다.** 금액은 사용자의 것이고, 공개가 기본이면
 *    "안 누르면 공개" 가 된다. 총액을 미리 채워 주되 **켜야 나간다.**
 * 2. **0원을 만들지 않는다.** 공개를 껐으면 `null` 을 보낸다 — 0원은 "공개했는데
 *    0원" 으로 읽힌다(D-96 과 같은 규칙).
 * 3. **점수를 강요하지 않는다.** 세 축 모두 선택이며 '아직 모르겠어요' 를 고를 수
 *    있다 — 응대만 겪고 이행은 아직 안 본 시점이 실제로 있다. 다만 **아무것도 남기지
 *    않은 후기는 막는다**(스키마가 같은 말을 한다).
 * 4. **평점이 어떻게 쓰이는지 미리 적는다.** 쓰기 전에 알아야 하는 정보다.
 */
export type ReviewFormProps = {
  bookingId: string;
  vendorName: string;
  /** 계약 총액. 공개 금액의 기본값으로만 쓴다. */
  totalAmount: number;
};

const NOT_RATED = "none";

export function ReviewForm({ bookingId, vendorName, totalAmount }: ReviewFormProps) {
  const router = useRouter();
  const [scores, setScores] = useState<Record<RatingAxis, number | null>>({
    price: null,
    response: null,
    fulfillment: null,
  });
  const [body, setBody] = useState("");
  const [disclose, setDisclose] = useState(false);
  const [amount, setAmount] = useState(String(totalAmount));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const payload = {
    bookingId,
    scorePrice: scores.price,
    scoreResponse: scores.response,
    scoreFulfillment: scores.fulfillment,
    body: body.trim() === "" ? null : body.trim(),
    // 꺼져 있으면 **아예 보내지 않는다**. 0 을 보내면 "0원을 공개했다" 가 된다.
    disclosedAmount: disclose && Number(amount) > 0 ? Math.trunc(Number(amount)) : null,
  };

  const parsed = ReviewCreateSchema.safeParse(payload);
  const problem = parsed.success ? null : parsed.error.issues[0]?.message ?? "입력을 확인해 주세요.";

  async function submit() {
    if (!parsed.success) return;

    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const result = (await response.json()) as { ok: boolean; error?: { message: string } };

      if (!result.ok) {
        setError(result.error?.message ?? "후기를 저장하지 못했습니다.");

        return;
      }

      router.push("/me");
      router.refresh();
    } catch {
      setError("후기를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4 px-gutter py-6" data-testid="review-form">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{vendorName} 후기</CardTitle>
          <CardDescription>
            계약이 확정된 거래에만 쓸 수 있는 <strong>검증 후기</strong>입니다. 커뮤니티
            경험담과 달리 업체 상세에 &apos;검증&apos;으로 실립니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* ── 항목별 평점 ─────────────────────────────────────────────── */}
          {RATING_AXES.map((axis) => (
            <fieldset key={axis} className="space-y-2">
              <legend className="text-sm font-medium text-foreground">
                {RATING_AXIS_LABEL[axis]}
              </legend>
              <div className="flex flex-wrap gap-2">
                {Array.from({ length: RATING_MAX - RATING_MIN + 1 }, (_, index) => RATING_MIN + index).map(
                  (value) => (
                    <Button
                      key={value}
                      type="button"
                      size="sm"
                      variant={scores[axis] === value ? "default" : "outline"}
                      onClick={() =>
                        setScores((current) => ({
                          ...current,
                          [axis]: current[axis] === value ? null : value,
                        }))
                      }
                      aria-pressed={scores[axis] === value}
                    >
                      {value}
                    </Button>
                  ),
                )}
                <Button
                  type="button"
                  size="sm"
                  variant={scores[axis] === null ? "default" : "outline"}
                  onClick={() => setScores((current) => ({ ...current, [axis]: null }))}
                  aria-pressed={scores[axis] === null}
                  data-testid={`score-${axis}-${NOT_RATED}`}
                >
                  아직 모르겠어요
                </Button>
              </div>
            </fieldset>
          ))}

          {/* ── 본문 ────────────────────────────────────────────────────── */}
          <label className="block space-y-1">
            <span className="text-sm font-medium text-foreground">후기 (선택)</span>
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={5}
              maxLength={2_000}
              placeholder="어떤 점이 좋았고 어떤 점이 아쉬웠는지 담백하게 적어 주세요."
              className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm"
              data-testid="review-body"
            />
          </label>

          {/* ── 실지출 공개 ─────────────────────────────────────────────── */}
          <div className="space-y-2 rounded-md border border-border p-3">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={disclose}
                onChange={(event) => setDisclose(event.target.checked)}
                className="mt-1"
                data-testid="disclose-amount"
              />
              <span className="text-sm text-foreground">
                실제로 낸 금액을 함께 공개합니다
                <span className="mt-0.5 block text-caption text-muted-foreground">
                  기본은 <strong>비공개</strong>입니다. 공개하면 다음 사람이 총액을 가늠할 수
                  있고, 그것이 이 서비스가 하려는 일입니다. 공개하지 않아도 후기는 그대로
                  실립니다.
                </span>
              </span>
            </label>

            {disclose ? (
              <label className="block space-y-1">
                <span className="text-caption font-medium text-foreground">공개할 금액 (원)</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  data-testid="disclosed-amount"
                />
                <span className="text-caption text-muted-foreground">
                  계약 총액은 {totalAmount.toLocaleString("ko-KR")}원입니다. 실제 낸 금액이
                  다르면 고쳐 주세요.
                </span>
              </label>
            ) : null}
          </div>

          {/* ── 이 점수가 어떻게 쓰이는가 ───────────────────────────────── */}
          <div className="rounded-md border border-border bg-muted p-3">
            <p className="text-caption font-medium text-foreground">
              남기신 점수는 이렇게 쓰입니다 · {RATING_BASIS.label}
            </p>
            <ul className="mt-1 space-y-0.5">
              {RATING_BASIS.rules.map((rule) => (
                <li key={rule} className="text-caption text-muted-foreground">
                  · {rule}
                </li>
              ))}
            </ul>
          </div>

          {problem !== null && (body !== "" || Object.values(scores).some((value) => value !== null)) ? (
            <p role="alert" className="text-sm text-warning">
              {problem}
            </p>
          ) : null}

          {error !== null ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}

          <Button
            type="button"
            size="touch"
            className="w-full"
            disabled={pending || !parsed.success}
            onClick={() => void submit()}
          >
            {pending ? "올리는 중…" : "후기 올리기"}
          </Button>

          <p className="text-caption text-muted-foreground">
            올린 뒤에도 내용을 고칠 수 있고, 원하면 거둘 수 있습니다. 거둔 후기는 공개되지
            않지만 <strong>기록은 남습니다</strong> — 업체 답변이 달려 있을 수 있어서입니다.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

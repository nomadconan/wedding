"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { formatKrw } from "@/components/domain/PriceDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  APP_STORE_NOTICE,
  BENEFIT_STATE_LABEL,
  CANCEL_NOTICE,
  MEMBERSHIP_BENEFITS,
  MEMBERSHIP_INTRO,
  MEMBERSHIP_PLAN_LABEL,
  MEMBERSHIP_REASON_NOTE,
  PRICE_UNCONFIGURED_NOTICE,
  differenceSummary,
  type MembershipPrice,
  type MembershipState,
} from "@/lib/core/membership/membership";

/**
 * /membership — 멤버십 구독 (F-C-19 · 명세서 §6.2)
 *
 * ── 이 화면이 지키는 것 ─────────────────────────────────────────────────────
 *  1. **무엇이 갈리는지 그대로 적는다.** §2.1 이 적은 혜택 넷 중 **지금 실제로 갈리는
 *     것은 AI 대화 턴 하나**다. 나머지 셋은 "지금은 무료에도 제한이 없다" 를 적는다 —
 *     "멤버십이면 무제한" 만 적으면 사용자는 무료에 제한이 있는 줄 안다. 파는 쪽에
 *     유리한 침묵을 두지 않는다(D-03 의 정신).
 *  2. **아무것도 닫지 않았다.** 열려 있던 기능을 멤버십 뒤로 옮기지 않았다 —
 *     옮겼다면 이 화면이 그 사실을 먼저 말해야 했다.
 *  3. **가격이 없으면 버튼을 열지 않고 이유를 적는다.** 0원으로 그리지 않는다(O-17).
 *  4. **해지는 지금 끊는 것이 아니다.** 남은 기간을 그대로 쓴다는 사실을 누르기 전에
 *     적는다 — 되돌릴 수 있는 행위와 없는 행위를 화면이 구분한다.
 *
 * 판정·문구는 전부 `lib/core/membership` 이 갖는다. 이 파일은 그리기만 한다.
 */
export function MembershipView({
  state,
  daysLeft,
  price,
}: {
  state: MembershipState;
  daysLeft: number | null;
  price: MembershipPrice;
}) {
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"start" | "cancel" | null>(null);

  async function call(method: "POST" | "DELETE") {
    setBusy(true);
    setNotice(null);
    setConfirming(null);

    try {
      const response = await fetch("/api/membership", { method });
      const payload = (await response.json()) as {
        ok: boolean;
        error?: { message: string };
      };

      if (!payload.ok) {
        setNotice(payload.error?.message ?? "요청을 처리하지 못했어요.");
        return;
      }

      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const isPremium = state.plan === "premium";

  return (
    <div className="space-y-5" data-testid="membership-view">
      {/* ── 지금 내 상태 ──────────────────────────────────────────────── */}
      <section className="space-y-2 rounded-lg border border-border p-4" data-testid="membership-state">
        <div className="flex items-center gap-2">
          <Badge variant={isPremium ? "default" : "secondary"}>
            {MEMBERSHIP_PLAN_LABEL[state.plan]}
          </Badge>
          {state.cancelPending ? <Badge variant="outline">해지 예약</Badge> : null}
        </div>

        <p className="text-sm text-foreground">{MEMBERSHIP_REASON_NOTE[state.reason]}</p>

        {/* **남은 기간은 계산해서 보여준다** — 만료 시각만 적으면 사용자가 세야 한다. */}
        {state.expiresAt !== null ? (
          <p className="text-caption text-muted-foreground">
            {state.expiresAt.slice(0, 10)}까지
            {daysLeft === null ? "" : ` · ${daysLeft}일 남았어요`}
          </p>
        ) : null}
      </section>

      {/* ── 무엇이 갈리는가 ───────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">무료와 멤버십</h2>
          <p className="text-caption text-muted-foreground">{MEMBERSHIP_INTRO}</p>
          {/* 파는 쪽에 유리한 침묵을 두지 않는다 — 갈리는 것이 몇 개인지 먼저 말한다. */}
          <p className="text-sm font-medium text-foreground" data-testid="membership-difference">
            {differenceSummary()}
          </p>
        </div>

        <ul className="space-y-2" data-testid="membership-benefits">
          {MEMBERSHIP_BENEFITS.map((benefit) => (
            <li
              key={benefit.key}
              className="space-y-1 rounded-lg border border-border p-3"
              data-testid={`membership-benefit-${benefit.key}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground">{benefit.label}</span>
                <Badge variant={benefit.state === "differs" ? "default" : "outline"}>
                  {BENEFIT_STATE_LABEL[benefit.state]}
                </Badge>
              </div>
              <p className="text-caption text-muted-foreground">{benefit.note}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* ── 가격과 가입 ───────────────────────────────────────────────── */}
      <section className="space-y-2 rounded-lg border border-border p-4" data-testid="membership-price">
        {price.ok ? (
          <p className="text-lg font-semibold text-foreground">
            월 {formatKrw(price.amount)}
          </p>
        ) : (
          // **0원을 그리지 않는다.** 금액 자리를 비우고 이유를 적는다(O-17).
          <p className="text-sm text-muted-foreground" data-testid="membership-price-unconfigured">
            {PRICE_UNCONFIGURED_NOTICE}
          </p>
        )}

        <p className="text-caption text-muted-foreground">{APP_STORE_NOTICE}</p>

        {isPremium ? (
          <div className="space-y-2">
            <p className="text-caption text-muted-foreground">{CANCEL_NOTICE}</p>

            {state.cancelPending ? (
              <p className="text-sm text-foreground">이미 해지를 예약했어요.</p>
            ) : confirming === "cancel" ? (
              // **되돌릴 수 있는 행위여도 한 번 묻는다** — 무엇이 남는지 적은 뒤에.
              <div className="flex gap-2">
                <Button variant="destructive" disabled={busy} onClick={() => call("DELETE")}>
                  해지 예약하기
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => setConfirming(null)}>
                  그만두기
                </Button>
              </div>
            ) : (
              <Button variant="outline" disabled={busy} onClick={() => setConfirming("cancel")}>
                해지하기
              </Button>
            )}
          </div>
        ) : price.ok ? (
          confirming === "start" ? (
            <div className="space-y-2">
              <p className="text-sm text-foreground">
                월 {formatKrw(price.amount)}으로 멤버십을 시작할까요?
              </p>
              <div className="flex gap-2">
                <Button disabled={busy} onClick={() => call("POST")}>
                  시작하기
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => setConfirming(null)}>
                  그만두기
                </Button>
              </div>
            </div>
          ) : (
            <Button disabled={busy} onClick={() => setConfirming("start")}>
              멤버십 시작하기
            </Button>
          )
        ) : (
          // 가격이 없으면 **버튼 자체를 열지 않는다.** 눌러 보고 실패하는 것보다 낫다.
          <Button disabled>지금은 가입할 수 없어요</Button>
        )}

        {notice !== null ? (
          <p className="text-sm text-destructive" data-testid="membership-notice">
            {notice}
          </p>
        ) : null}
      </section>
    </div>
  );
}

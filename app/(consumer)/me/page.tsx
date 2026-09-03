import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { MetricTile } from "@/components/domain/MetricTile";
import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/LoadingState";
import { Separator } from "@/components/ui/separator";
import {
  CONSENT_REQUIRED_NOTE,
  CONSENT_TYPE_LABEL,
  ME_PENDING_SECTIONS,
  isWithdrawable,
  mePendingMetric,
  type DeletionStatus,
} from "@/lib/core/schemas/me";
import {
  MEMBERSHIP_PLAN_LABEL,
  MEMBERSHIP_REASON_NOTE,
  daysLeft,
} from "@/lib/core/membership/membership";
import {
  isOnboardingComplete,
  type OnboardingQuestion,
} from "@/lib/core/schemas/onboarding";
import { findMyCouple } from "@/lib/couple/membership";
import { loadMembership } from "@/lib/membership/actions";
import { loadReviewableBookings } from "@/lib/reviews/read";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import {
  OnboardingStepper,
  type SavedAnswer,
} from "../../(auth)/onboarding/OnboardingStepper";
import { MeForms } from "./MeForms";

export const metadata: Metadata = {
  title: "마이페이지 — 웨딩클리어",
};

/**
 * /me (F-C-23, §6.2)
 *
 * 로그인이 필요하다. 미인증 차단은 미들웨어가 한다(S3-01).
 * 로딩 상태는 `loading.tsx` 가 아니라 페이지 안쪽 Suspense 다(S3-03).
 *
 * **온보딩 답변 수정은 온보딩과 같은 컴포넌트를 쓴다.** 폼을 새로 만들면 검증이 두
 * 벌이 되고, 한쪽만 고쳤을 때 같은 값이 화면마다 다르게 통과한다. `OnboardingStepper`
 * 는 이미 문항 단위로 저장하고 완료 후 재수정도 지원하므로 그대로 얹는다.
 */
export default async function MePage() {
  await requireUser("/me");

  return (
    <ConsumerShell title="마이페이지">
      <Suspense
        fallback={
          <LoadingState
            label="내 정보를 불러오는 중"
            rows={4}
            variant="block"
          />
        }
      >
        <MeSection />
      </Suspense>
    </ConsumerShell>
  );
}

async function MeSection() {
  const user = await requireUser("/me");
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, phone_hash, marketing_opt_in")
    .eq("user_id", user.id)
    .maybeSingle();

  const membership = await findMyCouple(user.id);

  // 멤버십 등급. **저장된 값을 그대로 적지 않는다** — 만료 여부는 계산이다(S7-11).
  const now = new Date();
  const subscription = (await loadMembership(supabase, { now })).state;

  const { count: memberCount } = membership
    ? await admin
        .from("couple_members")
        .select("id", { count: "exact", head: true })
        .eq("couple_id", membership.coupleId)
        .in("member_role", ["owner", "partner"])
    : { count: 0 };

  // 온보딩 답변은 세션 클라이언트로 읽는다 — RLS 가 내 커플 것만 보여준다.
  const { data: answerRows } = membership
    ? await supabase
        .from("onboarding_answers")
        .select("question_key, answer_json")
        .eq("couple_id", membership.coupleId)
    : { data: [] };

  const answers = (
    (answerRows ?? []) as {
      question_key: string;
      answer_json: Record<string, unknown>;
    }[]
  ).map((row) => ({
    question: row.question_key as OnboardingQuestion,
    ...row.answer_json,
  })) as SavedAnswer[];

  const { data: consents } = await supabase
    .from("consents")
    .select("id, consent_type, version, agreed_at")
    .order("agreed_at", { ascending: false });

  // **열린 요청만 본다.** 끝난 요청 이력은 아래에서 따로 센다.
  const { data: requests } = await supabase
    .from("data_deletion_requests")
    .select("id, scope, status, requested_at")
    .order("requested_at", { ascending: false });

  const allRequests = (requests ?? []) as {
    id: string;
    scope: string;
    status: DeletionStatus;
    requested_at: string;
  }[];

  // 후기 진입점(S8-11). 커플이 없으면 거래도 없다.
  const reviewable = membership
    ? await loadReviewableBookings(membership.coupleId)
    : [];

  const openRequest = allRequests.find(
    (row) => row.status === "pending" || row.status === "in_progress",
  );

  return (
    <div className="space-y-6" data-testid="me">
      <MeForms
        profile={{
          displayName: profile?.display_name ?? "",
          email: user.email,
          // **해시 존재 여부만 넘긴다.** 해시 자체를 화면에 내보내지 않는다(§7.2).
          phoneRegistered: Boolean(profile?.phone_hash),
          marketingOptIn: Boolean(profile?.marketing_opt_in),
        }}
        couple={
          membership
            ? { role: membership.role, memberCount: memberCount ?? 0 }
            : null
        }
        openRequest={
          openRequest
            ? {
                id: openRequest.id,
                scope: openRequest.scope,
                status: openRequest.status,
                requestedAt: openRequest.requested_at,
              }
            : null
        }
      />

      <Separator />

      {/* ── 멤버십 ───────────────────────────────────────────────────────
          **여기가 `/membership` 의 진입점이다.** 하단 탭은 다섯 칸이 찼고(D-55)
          결제·구독은 자주 오는 화면이 아니라 계정 설정에서 찾는 화면이다.
          이 줄은 **지금 등급을 계산해서** 적는다 — 만료된 유료 구독을 '멤버십' 이라고
          적으면 화면이 거짓말을 한다. */}
      <section className="space-y-2" data-testid="me-membership">
        <h2 className="text-base font-semibold text-foreground">멤버십</h2>
        <Card>
          <CardContent className="space-y-1 pt-5">
            <p className="text-sm font-medium text-foreground">
              {MEMBERSHIP_PLAN_LABEL[subscription.plan]}
              {subscription.cancelPending ? " · 해지 예약" : ""}
            </p>
            <p className="text-caption text-muted-foreground">
              {MEMBERSHIP_REASON_NOTE[subscription.reason]}
            </p>
            {subscription.expiresAt !== null ? (
              <p className="text-caption text-muted-foreground">
                {subscription.expiresAt.slice(0, 10)}까지 ·{" "}
                {daysLeft(subscription.expiresAt, now.toISOString())}일 남았어요
              </p>
            ) : null}
            <Link
              href="/membership"
              className="text-sm font-medium text-brand-600"
            >
              멤버십 보기
            </Link>
          </CardContent>
        </Card>
      </section>

      <Separator />

      {/* ── 온보딩 답변 수정 ─────────────────────────────────────────────
          여기서 고친 값은 홈의 D-day 와 탐색 필터 기본값으로 바로 이어진다.
          그래서 저장 경로를 온보딩과 하나로 둔다(`POST /api/onboarding`). */}
      <section className="space-y-2" data-testid="me-onboarding">
        <h2 className="text-base font-semibold text-foreground">
          결혼 준비 정보
        </h2>

        {membership === null ? (
          <p className="text-sm text-muted-foreground">
            아직 온보딩을 시작하지 않았어요.{" "}
            <Link href="/onboarding" className="font-medium text-brand-600">
              시작하기
            </Link>
          </p>
        ) : (
          <Card>
            <CardContent className="pt-5">
              <OnboardingStepper
                answers={answers}
                complete={isOnboardingComplete(
                  answers.map((answer) => answer.question),
                )}
              />
            </CardContent>
          </Card>
        )}
      </section>

      <Separator />

      {/* ── 내 예약 (F-C-14·15 · S5-10) ──
          **여기가 `/bookings` 의 진입점이다.** 하단 탭은 다섯 칸이 찼고(D-55)
          예약은 매일 여는 화면이 아니라 내 정보에서 찾는 화면이다. 예약 상세가
          계약·결제·해지·안전거래·후기 다섯의 진입점이다(S5-10). */}
      <section className="space-y-2" data-testid="me-bookings">
        <h2 className="text-base font-semibold text-foreground">내 예약</h2>
        <p className="text-caption text-muted-foreground">
          진행 상황·결제 회차·계약서를 한자리에서 보실 수 있어요.
        </p>
        <Link
          href="/bookings"
          className="text-caption font-medium text-brand-600"
        >
          예약 목록 열기
        </Link>
      </section>

      <Separator />

      {/* ── 알림센터 (F-C-21 · S4-13) ──
          **S0-04 가 이 진입점을 만들었다.** 화면은 S4-13 이 세웠는데
          **어느 내비도 어느 화면도 `/notifications` 를 가리키지 않았다** —
          미들웨어가 로그인까지 요구하는 화면이라 URL 을 직접 쳐야 열렸다(FIX-25 계열).
          하단 탭은 다섯 칸이 찼으므로(D-55) 쿠폰·예약과 같은 자리에 둔다. */}
      <section className="space-y-2" data-testid="me-notifications">
        <h2 className="text-base font-semibold text-foreground">알림</h2>
        <p className="text-caption text-muted-foreground">
          받은 알림과 토픽별 수신 설정을 확인하세요.
        </p>
        <Link href="/notifications" className="text-caption font-medium text-brand-600">
          알림센터 열기
        </Link>
      </section>

      <Separator />

      {/* ── 내 쿠폰 (F-C-35 · S5-12) ──
          **여기가 `/coupons` 의 진입점이다.** 하단 탭은 다섯 칸이 찼고(D-55)
          쿠폰함은 결제 화면에서도 들어가지만, **받은 것을 모아 보는 자리**가
          따로 있어야 만료 임박을 알 수 있다. */}
      <section className="space-y-2" data-testid="me-coupons">
        <h2 className="text-base font-semibold text-foreground">내 쿠폰</h2>
        <p className="text-caption text-muted-foreground">
          받은 쿠폰과 사용 조건·기한을 확인하세요. 사용은 결제 화면에서 합니다.
        </p>
        <Link href="/coupons" className="text-caption font-medium text-brand-600">
          쿠폰함 열기
        </Link>
      </section>

      <Separator />

      {/* ── 후기 쓸 수 있는 거래 (F-C-17 · S8-11) ────────────────
          `/reviews/new/[bookingId]` 로 가는 **두 길 중 하나**다. S8-11 이 이 자리를
          임시로 만들 때는 §6.2 가 진입점으로 삼는 `/bookings/[id]` 가 없었고,
          **S5-10 이 그것을 세우면서 그쪽에서도 들어올 수 있게 됐다.** 이 자리는
          남겨 둔다 — 쓸 수 있는 것이 모여 보이는 곳이 따로 있는 편이 낫고,
          두 곳에서 들어와도 되는 종류의 화면이다. */}
      {reviewable.length > 0 ? (
        <section className="space-y-2" data-testid="me-reviewable">
          <h2 className="text-base font-semibold text-foreground">
            후기 쓸 수 있는 거래
          </h2>
          <p className="text-caption text-muted-foreground">
            계약이 확정된 거래에만 쓸 수 있는 <strong>검증 후기</strong>입니다.
            실지출 금액 공개는 선택이며 기본은 비공개입니다.
          </p>
          <ul className="space-y-2">
            {reviewable.map((row) => (
              <li
                key={row.bookingId}
                className="rounded-lg border border-border p-3"
              >
                <p className="text-sm font-medium text-foreground">
                  {row.vendorName}
                </p>
                <Link
                  href={`/reviews/new/${row.bookingId}`}
                  className="text-caption font-medium text-brand-600"
                >
                  후기 쓰기
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ── 문의·신고 (F-A-06 접수 면 · S8-09) ──────────────────
          **여기가 `/support` 의 진입점이다.** 접수 경로가 없으면 운영자 큐가 영원히
          비고, 빈 큐는 "신고가 없다" 로 읽힌다(FIX-25 계열). 하단 탭은 다섯 칸이 찼고
          (D-55) 문의는 자주 오는 화면이 아니라 계정 설정에서 찾는 화면이다. */}
      <section className="space-y-2" data-testid="me-support">
        <h2 className="text-base font-semibold text-foreground">문의·신고</h2>
        <Card>
          <CardContent className="space-y-1 pt-5">
            <Link
              href="/support"
              className="text-sm font-medium text-brand-600"
            >
              문의 보내기·처리 상태 보기
            </Link>
            <p className="text-caption text-muted-foreground">
              계정·결제·업체 관련 문의를 받습니다. 게시물·후기 신고는 그 글에서
              직접 신고해 주세요 — 처리 절차가 달라 따로 받습니다.
            </p>
          </CardContent>
        </Card>
      </section>

      {/* ── 동의 이력 ──────────────────────────────────────────────────── */}
      <section className="space-y-2" data-testid="me-consents">
        <h2 className="text-base font-semibold text-foreground">동의 이력</h2>

        {(consents ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            아직 기록된 동의가 없어요.
          </p>
        ) : (
          <ul className="space-y-2">
            {(
              (consents ?? []) as {
                id: string;
                consent_type: string;
                version: string;
                agreed_at: string;
              }[]
            ).map((consent) => (
              <li
                key={consent.id}
                className="rounded-lg border border-border p-3"
                data-testid="consent-row"
                data-withdrawable={isWithdrawable(consent.consent_type)}
              >
                <p className="text-sm text-foreground">
                  {CONSENT_TYPE_LABEL[consent.consent_type] ??
                    consent.consent_type}
                  <span className="ml-1 text-caption text-muted-foreground">
                    {consent.version}
                  </span>
                </p>
                <p className="text-caption text-muted-foreground">
                  {consent.agreed_at.slice(0, 10)} 동의
                </p>
                {/* 철회 가능 여부를 항목마다 밝힌다. 필수 동의는 탈퇴로 이어져야 한다. */}
                <p className="text-caption text-muted-foreground">
                  {isWithdrawable(consent.consent_type)
                    ? "위 '내 정보'에서 수신 동의를 끄면 철회됩니다."
                    : CONSENT_REQUIRED_NOTE}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── 지난 삭제 요청 ─────────────────────────────────────────────── */}
      {allRequests.length > 0 ? (
        <section className="space-y-2" data-testid="me-request-history">
          <h2 className="text-base font-semibold text-foreground">
            삭제 요청 이력
          </h2>
          <ul className="space-y-1">
            {allRequests.map((row) => (
              <li key={row.id} className="text-caption text-muted-foreground">
                {row.requested_at.slice(0, 10)} · {row.scope} · {row.status}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ── 아직 없는 것 ───────────────────────────────────────────────── */}
      <section className="space-y-2">
        <h2 className="text-base font-semibold text-foreground">
          준비 중인 기능
        </h2>
        <div className="space-y-2" data-testid="me-pending">
          {ME_PENDING_SECTIONS.map((section) => (
            <MetricTile
              key={section.key}
              label={section.label}
              metric={mePendingMetric(section.key)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

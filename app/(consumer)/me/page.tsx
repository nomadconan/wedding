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
import { isOnboardingComplete, type OnboardingQuestion } from "@/lib/core/schemas/onboarding";
import { findMyCouple } from "@/lib/couple/membership";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { OnboardingStepper, type SavedAnswer } from "../../(auth)/onboarding/OnboardingStepper";
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
      <Suspense fallback={<LoadingState label="내 정보를 불러오는 중" rows={4} variant="block" />}>
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

  const answers = ((answerRows ?? []) as { question_key: string; answer_json: Record<string, unknown> }[])
    .map((row) => ({
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
          membership ? { role: membership.role, memberCount: memberCount ?? 0 } : null
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

      {/* ── 온보딩 답변 수정 ─────────────────────────────────────────────
          여기서 고친 값은 홈의 D-day 와 탐색 필터 기본값으로 바로 이어진다.
          그래서 저장 경로를 온보딩과 하나로 둔다(`POST /api/onboarding`). */}
      <section className="space-y-2" data-testid="me-onboarding">
        <h2 className="text-base font-semibold text-foreground">결혼 준비 정보</h2>

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
                complete={isOnboardingComplete(answers.map((answer) => answer.question))}
              />
            </CardContent>
          </Card>
        )}
      </section>

      <Separator />

      {/* ── 동의 이력 ──────────────────────────────────────────────────── */}
      <section className="space-y-2" data-testid="me-consents">
        <h2 className="text-base font-semibold text-foreground">동의 이력</h2>

        {(consents ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">아직 기록된 동의가 없어요.</p>
        ) : (
          <ul className="space-y-2">
            {((consents ?? []) as {
              id: string;
              consent_type: string;
              version: string;
              agreed_at: string;
            }[]).map((consent) => (
              <li
                key={consent.id}
                className="rounded-lg border border-border p-3"
                data-testid="consent-row"
                data-withdrawable={isWithdrawable(consent.consent_type)}
              >
                <p className="text-sm text-foreground">
                  {CONSENT_TYPE_LABEL[consent.consent_type] ?? consent.consent_type}
                  <span className="ml-1 text-caption text-muted-foreground">{consent.version}</span>
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
          <h2 className="text-base font-semibold text-foreground">삭제 요청 이력</h2>
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
        <h2 className="text-base font-semibold text-foreground">준비 중인 기능</h2>
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

import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { findMyCouple } from "@/lib/couple/membership";
import {
  FEE_TIMING_NOTICE,
  SCOPE_CROSS_AXIS_NOTICE,
  SCOPE_EMPTY_BODY,
  SCOPE_ENFORCEMENT_NOTICE,
  SCOPE_NO_DELEGATION_BODY,
  SCOPE_NO_DELEGATION_TITLE,
  SCOPE_TITLE,
} from "@/lib/core/planner/scope";
import { loadScopePayload } from "@/lib/planners/scopes";
import { requireUser } from "@/lib/supabase/auth";

import { ScopeEditor } from "./ScopeEditor";

export const metadata: Metadata = {
  title: "플래너 이용 범위 — 웨딩클리어",
};

/**
 * /planners/scopes — 카테고리별 부분 선택 과금 (F-C-31 · §6.2 보완 제안 · S6-03)
 *
 * ── 이 화면이 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **고르면 총액이 어떻게 되는지 먼저 보여 준다**(F-C-31 — 선택 즉시 반영). 담긴
 *    항목의 판매가로 계산하며, 담긴 것이 없으면 0원이라고 적는다(그것은 사실이다).
 * 2. **요율이 없으면 0원이라고 적지 않는다**(함정 2). 계산된 0과 "기준을 모른다" 는
 *    화면에서 겹쳐 읽히므로 문장을 갈라 둔다.
 * 3. **언제 실제로 걸리는지 적는다**(D-17 · 집행은 계약 발행이다). 안 적으면 고객은
 *    고르는 순간 돈이 나가는 줄 알거나, 반대로 표시일 뿐이라고 읽는다.
 * 4. **위임이 없으면 고를 수 없고 그 이유를 적는다** — 보지도 못하는 플래너에게
 *    수수료가 붙으면 안 된다(0036 트리거가 최종 경계다).
 * 5. **두 축이 다르다는 것을 말하고 상대 화면으로 잇는다**(D-43).
 * 6. **하단 탭을 늘리지 않는다.** 진입은 `/cart` 와 위임 관리 화면이다.
 * 7. **캐시하지 않는다** — 금액과 위임 기간이 시계로 판정된다(함정 4).
 */
export const dynamic = "force-dynamic";

export default async function PlannerScopesPage() {
  await requireUser("/planners/scopes");

  return (
    <ConsumerShell title={SCOPE_TITLE}>
      <Suspense fallback={<LoadingState label="이용 범위를 불러오는 중" rows={3} variant="block" />}>
        <Section />
      </Suspense>
    </ConsumerShell>
  );
}

async function Section() {
  const user = await requireUser("/planners/scopes");
  const couple = await findMyCouple(user.id);

  if (!couple) {
    return (
      <ErrorState
        code="COUPLE_REQUIRED"
        title="커플 정보가 필요해요"
        description="온보딩을 마치면 카테고리별로 플래너 이용을 정할 수 있어요."
      />
    );
  }

  let payload: Awaited<ReturnType<typeof loadScopePayload>>;
  try {
    payload = await loadScopePayload({ coupleId: couple.coupleId, now: new Date() });
  } catch {
    return (
      <ErrorState
        code="SCOPE_LOAD_FAILED"
        title="이용 범위를 불러오지 못했어요"
        description="잠시 후 다시 시도해 주세요."
      />
    );
  }

  return (
    <div className="space-y-5">
      <p className="rounded-lg border border-border bg-muted px-3 py-2 text-xs text-neutral-700">
        {FEE_TIMING_NOTICE}
      </p>

      {payload.delegated.length === 0 ? (
        <EmptyState
          title={SCOPE_NO_DELEGATION_TITLE}
          description={SCOPE_NO_DELEGATION_BODY}
          action={
            <Link
              href="/planners"
              className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-brand-600"
            >
              플래너 찾아 위임하기
            </Link>
          }
        />
      ) : (
        <ScopeEditor
          categories={payload.categories}
          delegated={payload.delegated}
          feeTotal={payload.feeTotal}
        />
      )}

      <p className="text-xs text-neutral-600">{SCOPE_EMPTY_BODY}</p>

      <section className="rounded-xl border border-border p-4">
        <h2 className="text-sm font-semibold text-foreground">언제 실제로 걸리나요</h2>
        <p className="mt-2 text-xs text-neutral-700">{SCOPE_ENFORCEMENT_NOTICE}</p>
      </section>

      {/* 두 축을 잇는 자리다(D-43). 위임 화면의 짝이다. */}
      <section className="rounded-xl border border-border p-4">
        <p className="text-xs text-neutral-700">{SCOPE_CROSS_AXIS_NOTICE}</p>
        <Link
          href="/planners/delegations"
          className="mt-2 inline-block text-xs font-medium text-brand-600"
        >
          열람 위임 관리로 가기
        </Link>
      </section>
    </div>
  );
}

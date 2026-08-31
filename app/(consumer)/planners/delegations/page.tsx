import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { findMyCouple } from "@/lib/couple/membership";
import {
  CLOSED_SCOPES,
  CROSS_AXIS_NOTICE,
  DELEGATION_EMPTY_BODY,
  DELEGATION_EMPTY_TITLE,
  DELEGATION_LIST_TITLE,
  NO_FEE_FROM_DELEGATION_NOTICE,
  VISIBILITY_NOTICE,
} from "@/lib/core/planner/delegation";
import { loadCoupleDelegations } from "@/lib/planners/delegation";
import { requireUser } from "@/lib/supabase/auth";

import { DelegationList } from "./DelegationList";

export const metadata: Metadata = {
  title: "위임 관리 — 웨딩클리어",
};

/**
 * /planners/delegations — 열람 권한 위임 관리 (F-C-18 · §6.2 · S6-04)
 *
 * ── 이 화면이 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **두 축이 다르다는 것을 화면이 말한다**(D-43). 위임을 거둬도 카테고리별 플래너
 *    이용 설정은 그대로다 — 자동으로 끄면 돈이 걸린 변경이 누르지 않은 채 일어나고,
 *    끄지 않으면서 알리지도 않으면 고객이 나중에 발견한다.
 * 2. **열려 있지 않은 것도 보인다.** 수락 대기·기간 종료·거절된 제안을 감추면
 *    고객은 "위임했다" 고 기억하는 것과 화면이 어긋나는 이유를 알 수 없다.
 * 3. **막아 둔 범위를 이유와 함께 보인다.** 목록에 없으면 "아직 안 만든 것" 인지
 *    "일부러 막은 것" 인지 구분할 수 없다.
 * 4. **하단 탭을 늘리지 않는다**(다섯이 상한이다). 진입은 `/planners` 와 플래너
 *    상세 화면이다.
 * 5. **캐시하지 않는다** — 기간이 시계로 판정되는 화면이고, 쿠키를 읽는다(함정 4).
 */
export const dynamic = "force-dynamic";

export default async function DelegationsPage() {
  await requireUser("/planners/delegations");

  return (
    <ConsumerShell title={DELEGATION_LIST_TITLE}>
      <Suspense fallback={<LoadingState label="위임을 불러오는 중" rows={3} variant="block" />}>
        <Section />
      </Suspense>
    </ConsumerShell>
  );
}

async function Section() {
  const user = await requireUser("/planners/delegations");
  const couple = await findMyCouple(user.id);

  if (!couple) {
    return (
      <ErrorState
        code="COUPLE_REQUIRED"
        title="커플 정보가 필요해요"
        description="온보딩을 마치면 플래너에게 위임할 수 있어요."
      />
    );
  }

  let payload: Awaited<ReturnType<typeof loadCoupleDelegations>>;
  try {
    payload = await loadCoupleDelegations({ coupleId: couple.coupleId, now: new Date() });
  } catch {
    return (
      <ErrorState
        code="DELEGATION_LOAD_FAILED"
        title="위임을 불러오지 못했어요"
        description="잠시 후 다시 시도해 주세요."
      />
    );
  }

  return (
    <div className="space-y-5">
      <p className="rounded-lg border border-border bg-muted px-3 py-2 text-xs text-neutral-700">
        {VISIBILITY_NOTICE}
      </p>

      {payload.rows.length === 0 ? (
        <EmptyState
          title={DELEGATION_EMPTY_TITLE}
          description={DELEGATION_EMPTY_BODY}
          action={
            <Link
              href="/planners"
              className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-brand-600"
            >
              플래너 찾아보기
            </Link>
          }
        />
      ) : (
        <DelegationList rows={payload.rows} canRevoke={couple.role === "owner"} />
      )}

      <section className="rounded-xl border border-border p-4">
        <h2 className="text-sm font-semibold text-foreground">위임해도 열리지 않는 것</h2>
        <ul className="mt-2 space-y-2 text-xs text-neutral-600">
          {CLOSED_SCOPES.map((closed) => (
            <li key={closed.label}>
              <span className="font-medium text-neutral-800">{closed.label}</span> — {closed.reason}
            </li>
          ))}
        </ul>
      </section>

      {/* 두 축을 잇는 자리다(D-43). 자동으로 끄지 않고 경로를 안내한다.
          **S6-03 이 그 경로를 실제 화면으로 만들었다** — 그 전까지는 문장뿐이었다. */}
      <section className="rounded-xl border border-border p-4">
        <p className="text-xs text-neutral-700">{CROSS_AXIS_NOTICE}</p>
        <p className="mt-2 text-xs text-neutral-500">{NO_FEE_FROM_DELEGATION_NOTICE}</p>
        <Link
          href="/planners/scopes"
          className="mt-2 inline-block text-xs font-medium text-brand-600"
        >
          카테고리별 이용 범위 설정으로 가기
        </Link>
      </section>
    </div>
  );
}

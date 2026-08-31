import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { findMyCouple } from "@/lib/couple/membership";
import {
  CLOSED_SCOPES,
  DELEGATION_TITLE,
  NO_FEE_FROM_DELEGATION_NOTICE,
  OFFER_PENDING_NOTICE,
  VISIBILITY_NOTICE,
} from "@/lib/core/planner/delegation";
import { loadPlanner } from "@/lib/planners/loader";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/supabase/auth";

import { DelegateForm } from "./DelegateForm";

export const metadata: Metadata = {
  title: "권한 위임 — 웨딩클리어",
};

/**
 * /planners/[id]/delegate — 위임 제안 (F-C-18 · §6.2 · S6-04)
 *
 * ── 이 화면이 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **제안만으로는 아무것도 열리지 않는다는 사실을 먼저 적는다**(D-165). 안 적으면
 *    고객은 이미 공유된 줄 알고 다음 단계를 진행한다.
 * 2. **고를 수 있는 것은 RLS 가 실제로 여는 11개뿐이다**(D-167). 목록을 코드가 짓지
 *    않고 `DELEGATABLE_SCOPES` 하나에서 가져온다 — DB CHECK 도 같은 목록을 든다.
 * 3. **막아 둔 것을 같은 화면에서 이유와 함께 보인다.** 없는 항목을 조용히 빼면
 *    고객은 결제·대화가 함께 넘어가는지 확신할 수 없다.
 * 4. **기간에는 끝이 있어야 한다**(D-166). 무기한 칸을 만들지 않는다.
 * 5. **대표가 아니면 폼을 만들지 않는다** — 눌러도 403 이 나는 버튼은 장식이다.
 */
export const dynamic = "force-dynamic";

export default async function DelegatePage({ params }: { params: { id: string } }) {
  await requireUser(`/planners/${params.id}/delegate`);

  return (
    <ConsumerShell title={DELEGATION_TITLE}>
      <Suspense fallback={<LoadingState label="플래너를 불러오는 중" rows={3} variant="block" />}>
        <Section plannerId={params.id} />
      </Suspense>
    </ConsumerShell>
  );
}

async function Section({ plannerId }: { plannerId: string }) {
  const user = await requireUser(`/planners/${plannerId}/delegate`);
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

  const planner = await loadPlanner(await createClient(), plannerId);

  if (!planner) {
    return (
      <ErrorState
        code="PLANNER_NOT_FOUND"
        title="플래너를 찾지 못했어요"
        description="공개가 내려갔거나 주소가 잘못됐을 수 있어요."
      />
    );
  }

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-border p-4">
        <h2 className="text-base font-semibold text-foreground">{planner.headline}</h2>
        <p className="mt-1 text-xs text-neutral-600">
          경력 {planner.careerYears}년 · {planner.regions.join(", ")}
        </p>
        <Link
          href={`/planners/${planner.id}`}
          className="mt-2 inline-block text-xs font-medium text-brand-600"
        >
          프로필 다시 보기
        </Link>
      </section>

      <p className="rounded-lg border border-border bg-muted px-3 py-2 text-xs text-neutral-700">
        {OFFER_PENDING_NOTICE}
      </p>

      {couple.role === "owner" ? (
        <DelegateForm plannerId={planner.id} />
      ) : (
        <p className="rounded-lg border border-border px-3 py-2 text-xs text-neutral-600">
          위임 제안은 대표 계정만 할 수 있어요. 우리 데이터를 밖으로 여는 일이라 결제·서명과 같은
          권한으로 두었습니다.
        </p>
      )}

      <p className="text-xs text-neutral-600">{VISIBILITY_NOTICE}</p>

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

      <p className="text-xs text-neutral-500">{NO_FEE_FROM_DELEGATION_NOTICE}</p>
    </div>
  );
}

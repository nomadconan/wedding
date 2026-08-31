import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import {
  DELEGATION_NEXT_NOTICE,
  NEW_PLANNER_NOTICE,
  PROFILE_TITLE,
  SELF_REPORTED_NOTICE,
} from "@/lib/core/planner/profile";
import { PLANNER_CATEGORY_LABEL, type PlannerCategory } from "@/lib/core/planner/scope";
import { loadPlanner } from "@/lib/planners/loader";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "플래너 프로필 — 웨딩클리어",
};

/**
 * /planners/[id] (F-C-18, §6.2)
 *
 * **위임은 여기서 하지 않고 다음 화면으로 잇는다**(S6-04). 범위·기간을 고르는 일은
 * 프로필 읽기와 성격이 다르고 되돌리기 어려운 결정이라 `/planners/[id]/delegate` 를
 * 따로 둔다 — 목록을 훑다가 실수로 눌러 우리 예산·하객이 열리는 일이 없어야 한다.
 *
 * **요금을 보여주지 않는다.** 요율은 `planner_fee_rates` 가 갖고 계약 확정 시
 * 스냅샷된다(D-16) — 프로필에 숫자를 적으면 화면과 실제 청구가 어긋난다.
 */
export default async function PlannerDetailPage({ params }: { params: { id: string } }) {
  return (
    <ConsumerShell title={PROFILE_TITLE}>
      <Suspense fallback={<LoadingState label="프로필을 불러오는 중" rows={3} variant="block" />}>
        <DetailSection id={params.id} />
      </Suspense>
    </ConsumerShell>
  );
}

async function DetailSection({ id }: { id: string }) {
  try {
    const planner = await loadPlanner(await createClient(), id);

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

          <div className="mt-3 flex flex-wrap gap-1.5">
            {planner.categories.map((category: PlannerCategory) => (
              <span
                key={category}
                className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600"
              >
                {PLANNER_CATEGORY_LABEL[category] ?? category}
              </span>
            ))}
          </div>

          {planner.bio ? (
            <p className="mt-3 whitespace-pre-wrap border-t border-border pt-3 text-sm text-neutral-700">
              {planner.bio}
            </p>
          ) : null}
        </section>

        <section className="rounded-xl border border-border p-4">
          <h2 className="text-sm font-semibold text-foreground">실적</h2>
          <dl className="mt-3 space-y-1.5 text-sm">
            <Row
              label="계약 성사"
              value={
                planner.metrics.contracts.kind === "value"
                  ? `${planner.metrics.contracts.value}건`
                  : "아직 세지 않아요"
              }
            />
            {/* 리뷰를 0으로 적지 않는다 — 0은 평가가 나쁜 것처럼 읽힌다. */}
            <Row
              label="후기"
              value={
                planner.metrics.reviews.kind === "pending"
                  ? `아직 세지 않아요 (${planner.metrics.reviews.owner})`
                  : "-"
              }
            />
          </dl>

          {planner.contractCount === 0 ? (
            <p className="mt-3 text-xs text-neutral-500">{NEW_PLANNER_NOTICE}</p>
          ) : null}
        </section>

        {/* S6-04 가 이 자리를 실제 경로로 이었다. 그 전까지는 문장만 있고 갈 곳이
            없었다 — 만들어 놓고 들어가는 자리가 없는 화면의 반대 짝이다. */}
        <section className="rounded-lg border border-border px-3 py-3">
          <p className="text-xs text-neutral-600">{DELEGATION_NEXT_NOTICE}</p>
          <div className="mt-2 flex flex-wrap gap-3">
            <Link
              href={`/planners/${planner.id}/delegate`}
              className="text-xs font-medium text-brand-600"
            >
              권한 위임하기
            </Link>
            <Link href="/planners/delegations" className="text-xs font-medium text-neutral-600">
              내 위임 관리
            </Link>
          </div>
        </section>

        <p className="text-xs text-neutral-500">{SELF_REPORTED_NOTICE}</p>
      </div>
    );
  } catch {
    return (
      <ErrorState
        code="PLANNER_LOAD_FAILED"
        title="프로필을 불러오지 못했어요"
        description="잠시 후 다시 시도해 주세요."
      />
    );
  }
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-neutral-600">{label}</dt>
      <dd className="text-neutral-800">{value}</dd>
    </div>
  );
}

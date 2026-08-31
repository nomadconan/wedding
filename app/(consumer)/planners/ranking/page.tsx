import type { Metadata } from "next";
import Link from "next/link";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import {
  RANKING_INTRO,
  RANKING_LIST_ELSEWHERE_NOTICE,
  RANKING_METRIC_STATE_LABEL,
  RANKING_TITLE,
  rankingDisclosure,
} from "@/lib/core/planner/ranking";

export const metadata: Metadata = {
  title: "플래너 순서 기준 — 웨딩클리어",
};

/**
 * /planners/ranking — 랭킹 기준 공개 (F-C-18 · D-03 · D-25 · §6 보완 제안 · S6-06)
 *
 * ── 이 화면이 목록을 그리지 않는 이유 ───────────────────────────────────────
 * S6-02 의 마켓이 이미 **지금 셀 수 있는 유일한 실적 지표**로 정렬하고 동점 처리까지
 * 고정해 두었다. 같은 지표로 목록을 하나 더 그리면 **그것은 같은 목록**이고, 두 화면이
 * 각자 계산하는 순간 어긋날 자리가 생긴다(FIX-52 가 요율에서 만든 자리와 같다).
 *
 * 그래서 이 태스크가 더하는 것은 **순서가 아니라 근거**다 — D-25 가 요구하는 것이
 * 정확히 그것이고, S6-01 이 판정 함수를 만들어 두었는데 **읽는 화면이 없었다.**
 *
 * ── 이 화면이 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **다섯 지표를 하나도 빼지 않는다.** 빼면 "없는 지표" 가 되고, 고객은 우리가
 *    무엇을 안 보는지 알 수 없다.
 * 2. **못 세는 이유를 두 종류로 가른다** — "아직 채우는 경로가 없다"(담당 태스크가
 *    있다)와 "구조상 따로 셀 수 없다"(같은 행을 센다). 한 통에 담으면 화면이
 *    "곧 생긴다" 와 "생길 수 없다" 를 같은 문장으로 적는다.
 * 3. **종합 점수를 만들지 않았다는 사실을 적는다**(O-13). 지어낸 계수가 플래너의
 *    수입을 좌우하게 두지 않는다.
 * 4. **콜드스타트에 대응하지 않고 물음을 그대로 보인다.**
 * 5. **비로그인도 본다** — 순서의 근거는 고르기 전에 읽어야 하는 것이다.
 *
 * ── 이 화면은 정적이다 (의도한 것이다) ──────────────────────────────────────
 * 쿠키도 DB 도 읽지 않는다 — 내용이 전부 코드 상수(정렬 어휘·지표 판정)라 **사용자에
 * 따라 달라질 것이 없다.** 함정 4 가 경계하는 것은 "사용자별 값을 읽어야 하는데 정적
 * 으로 굳는" 경우이고, 여기는 반대다. 기준이 바뀌면 배포와 함께 바뀐다.
 */
export default function PlannerRankingPage() {
  const disclosure = rankingDisclosure();

  return (
    <ConsumerShell title={RANKING_TITLE}>
      <div className="space-y-5">
        <p className="rounded-lg border border-border bg-muted px-3 py-2 text-xs text-neutral-700">
          {RANKING_INTRO}
        </p>

        <section className="rounded-xl border border-border p-4">
          <h2 className="text-sm font-semibold text-foreground">고를 수 있는 순서</h2>
          <ul className="mt-2 space-y-2">
            {disclosure.sorts.map((row) => (
              <li key={row.sort} className="text-xs">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium text-neutral-800">{row.label}</span>
                  <span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-neutral-600">
                    {row.kind === "performance" ? "실적 지표" : "사실 정보"}
                  </span>
                </div>
                <p className="mt-0.5 text-neutral-600">{row.basis}</p>
              </li>
            ))}
          </ul>
          <p className="mt-3 border-t border-border pt-2 text-xs text-neutral-600">
            {disclosure.notices.sortBasis}
          </p>
        </section>

        <section className="rounded-xl border border-border p-4">
          <h2 className="text-sm font-semibold text-foreground">지표를 어디까지 세고 있나</h2>
          <ul className="mt-2 space-y-2.5" data-testid="ranking-metrics">
            {disclosure.metrics.map((row) => (
              <li key={row.metric} className="text-xs">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium text-neutral-800">{row.label}</span>
                  <span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-neutral-600">
                    {RANKING_METRIC_STATE_LABEL[row.state]}
                  </span>
                </div>
                {/* 0으로 적지 않는다 — 상태마다 다른 문장을 쓴다. */}
                {row.state === "counted" ? (
                  <p className="mt-0.5 text-neutral-600">
                    성사된 계약에서 생긴 기록을 셉니다.
                  </p>
                ) : null}
                {row.state === "pending" ? (
                  <p className="mt-0.5 text-neutral-600">
                    {row.reason} <span className="text-neutral-500">({row.owner})</span>
                  </p>
                ) : null}
                {row.state === "not_distinct" ? (
                  <p className="mt-0.5 text-neutral-600">
                    {row.reason}{" "}
                    <span className="text-neutral-500">({row.sameAsLabel}와 같은 기록)</span>
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-xl border border-border p-4">
          <h2 className="text-sm font-semibold text-foreground">아직 정하지 않은 것</h2>
          {/* 지어내지 않은 것을 지어내지 않았다고 적는다. */}
          <p className="mt-2 text-xs text-neutral-700">{disclosure.formulaPending.note}</p>
          <p className="mt-2 text-xs text-neutral-700">{disclosure.coldStart.note}</p>
          <p className="mt-2 text-xs text-neutral-500">
            두 물음은 오픈 이슈 {disclosure.formulaPending.openIssue} 에 함께 열려 있어요.
          </p>
        </section>

        <section className="rounded-lg border border-border px-3 py-3">
          <p className="text-xs text-neutral-600">{RANKING_LIST_ELSEWHERE_NOTICE}</p>
          <Link href="/planners" className="mt-2 inline-block text-xs font-medium text-brand-600">
            플래너 찾기로 가기
          </Link>
        </section>
      </div>
    </ConsumerShell>
  );
}

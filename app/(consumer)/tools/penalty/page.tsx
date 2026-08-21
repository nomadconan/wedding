import type { Metadata } from "next";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import type { SavedSimulation } from "@/lib/core/pricing/penalty-view";
import { findMyCouple } from "@/lib/couple/membership";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { PenaltyToolView } from "./PenaltyToolView";

export const metadata: Metadata = {
  title: "위약금 시뮬레이터 — 웨딩클리어",
  description:
    "계약서에 적힌 위약 조건과 소비자분쟁해결기준을 나란히 비교합니다. 참고 정보이며 법률 자문이 아닙니다.",
};

/**
 * /tools/penalty — 위약금 시뮬레이터 (F-C-08 · 명세서 §6.2 · §5.3)
 *
 * **로그인을 요구하지 않는다.** 입력이 전부 사용자에게서 오고 커플 데이터를 하나도
 * 읽지 않는다 — 계약서에 서명하기 **전에** 확인하는 것이 이 도구의 쓸모인데 로그인을
 * 요구하면 그 자리가 막힌다(`/search` 가 공개인 것과 같은 판단). 미들웨어의
 * `PROTECTED_PREFIXES` 에도 넣지 않았다.
 *
 * **저장한 계산만 세션으로 읽는다.** `penalty_simulations` 는 커플 스코프 RLS 이고
 * (0005 [45]) 비로그인이면 조회 자체를 건너뛴다. 쿠키를 읽는 경로가 있으므로 이
 * 페이지는 동적이며 **FIX-22 의 캐시 문제가 붙지 않는다.**
 *
 * 하단 탭은 '탐색' 을 켠다 — 다섯 칸이 이미 찼고(D-55) 진입은 계약서 검토
 * 목록(`/reports`)이다.
 */
export default async function PenaltyToolPage() {
  const user = await getSessionUser();
  const membership = user ? await findMyCouple(user.id) : null;

  let saved: SavedSimulation[] = [];

  if (membership) {
    const supabase = await createClient();

    // **소유자 필터를 넣는다.** RLS 가 경계이지만 조건을 빼면 다른 커플의 행이
    // 정책에 걸려 사라지는지 여부에 화면이 의존하게 된다 — 조건을 적는 편이 낫다.
    const { data } = await supabase
      .from("penalty_simulations")
      .select("id, inputs_json, standard_amount, contract_amount, excess_amount, rule_version, created_at")
      .eq("couple_id", membership.coupleId)
      .order("created_at", { ascending: false })
      .limit(5);

    saved = ((data ?? []) as {
      id: string;
      inputs_json: { category?: string } | null;
      standard_amount: number;
      contract_amount: number;
      excess_amount: number;
      rule_version: string | null;
      created_at: string;
    }[]).map((row) => ({
      id: row.id,
      category: row.inputs_json?.category ?? "hall",
      standardAmount: row.standard_amount,
      contractAmount: row.contract_amount,
      excessAmount: row.excess_amount,
      ruleVersion: row.rule_version,
      createdAt: row.created_at,
    }));
  }

  return (
    <ConsumerShell title="위약금 시뮬레이터" activeTab="/explore">
      <PenaltyToolView canSave={membership !== null} initialSaved={saved} />
    </ConsumerShell>
  );
}

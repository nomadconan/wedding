import type { Metadata } from "next";

import { AdminShell } from "@/components/layout/AdminShell";
import { ErrorState } from "@/components/ui/ErrorState";
import { listRates } from "@/lib/rates/admin";
import { requireOperator } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { RatesPanel } from "./RatesPanel";

export const metadata: Metadata = {
  title: "요율 관리 — 웨딩클리어",
};

/**
 * /admin/commission-rates (F-A-15, §6.4 — **5단계**)
 *
 * 명세 §부록이 이 화면을 **"개발 블로커 해제 장치"** 라고 적었다. 요율 **값**이
 * 미확정이어도(O-02) 값을 넣는 자리가 있으면 거래·정산 개발이 값에 묶이지 않는다.
 *
 * 실제로 `commission_rates` 가 0행이면 계약 발행이 `CONTRACT_RATE_UNRESOLVED` 로
 * 막히고(S5-06) **결제·정산·해지 흐름 전체가 서지 않는다.** 이 화면이 그 자물쇠다.
 *
 * **세션 클라이언트로 읽는다** — 0034 가 운영자 열람 정책을 만들었고 경계는 앱 코드가
 * 아니라 RLS 여야 한다(§5.5).
 */
export default async function AdminCommissionRatesPage() {
  await requireOperator("/admin/commission-rates");

  try {
    const rates = await listRates(await createClient());
    const active = rates.filter((row) => row.state === "active").length;

    return (
      <AdminShell
        role="admin"
        title="요율 관리"
        description={
          active > 0
            ? `적용 중인 요율 ${active}건. 변경은 새 요율을 추가하고 기존 요율을 종료하는 방식이에요.`
            : "적용 중인 요율이 없습니다. 요율이 없으면 계약을 발행할 수 없어요 — 값이 미정이면 임시 요율을 넣고 나중에 바꿀 수 있습니다."
        }
      >
        <RatesPanel rates={rates} />
      </AdminShell>
    );
  } catch {
    return (
      <AdminShell role="admin" title="요율 관리">
        <ErrorState
          code="RATE_LOAD_FAILED"
          title="요율을 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }
}

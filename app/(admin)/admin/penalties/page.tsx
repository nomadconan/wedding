import type { Metadata } from "next";

import { AdminShell } from "@/components/layout/AdminShell";
import { ErrorState } from "@/components/ui/ErrorState";
import { loadDisputeQueue } from "@/lib/cancellation/loader";
import { requireOperator } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { ResolvePanel } from "./ResolvePanel";

export const metadata: Metadata = {
  title: "위약금 조율 — 웨딩클리어",
};

/**
 * /admin/penalties (F-A-17, §6.4)
 *
 * 양측 확인이 갈리거나 기한이 지난 해지가 쌓이는 **조율 큐**다. S4-07 이 상담
 * 보증금에서 만든 구조(상태 + 부분 인덱스)를 그대로 쓴다 — 운영이 배워야 할 흐름이
 * 하나로 줄고, 조율 큐를 두 벌 만들지 않는다.
 *
 * **서비스롤로 우회해 읽지 않는다.** 0031 이 `is_operator()` 정책을 만들었고 이
 * 화면은 세션 클라이언트로 읽는다 — 경계가 앱 코드가 아니라 RLS 여야 한다(§5.5).
 * 입점 심사(`/admin/vendors`)가 서비스롤을 쓰는 것과 다른 선택이며, 그쪽은 Storage
 * 서명 URL 발급 때문에 서버 코드가 필요했다.
 */
export default async function AdminPenaltiesPage() {
  await requireOperator("/admin/penalties");

  try {
    const queue = await loadDisputeQueue(await createClient());

    return (
      <AdminShell
        role="admin"
        title="위약금 조율"
        description={
          queue.length > 0
            ? `조율 대기 ${queue.length}건. 결론에는 사유가 반드시 붙습니다.`
            : "조율할 건이 없어요."
        }
      >
        <ResolvePanel
          items={queue.map((item) => ({
            id: item.id,
            statusLabel: item.statusLabel,
            reasonLabel: item.reasonLabel,
            reasonNote: item.reasonNote,
            coupleClaim: item.coupleClaim,
            vendorClaim: item.vendorClaim,
            coupleAgreed: item.coupleAgreed,
            vendorAgreed: item.vendorAgreed,
            bandLabel: item.bandLabel,
            basisRef: item.basisRef,
            isDraftRules: item.isDraftRules,
            paidAmount: item.paidAmount,
          }))}
        />
      </AdminShell>
    );
  } catch {
    return (
      <AdminShell role="admin" title="위약금 조율">
        <ErrorState
          code="CANCEL_QUEUE_FAILED"
          title="조율 큐를 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }
}

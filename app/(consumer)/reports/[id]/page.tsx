import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { LoadingState } from "@/components/ui/LoadingState";
import { loadReport } from "@/lib/reports/loader";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { ReportDetailView } from "./ReportDetailView";
import { SharePanel } from "./SharePanel";

export const metadata: Metadata = {
  title: "검토 리포트 — 웨딩클리어",
};

/**
 * /reports/[id] — 리포트 상세 (F-C-07 · 명세서 §6.2)
 *
 * **남의 리포트는 404 다.** RLS 가 막아 `loadReport` 가 null 을 돌려주고, 여기서
 * 존재 여부도 알리지 않는다(업체 상세·대화가 세운 것과 같은 규칙).
 *
 * **공유(F-C-20 · S7-12)가 붙었다.** S7-03 이 "공유는 S7-12" 로 비워 둔 자리이며
 * `/share/[token]` 이 서면서 열렸다 — 없는 화면으로 보내지 않는다는 규칙(S3-11)이
 * 이제 지켜진 채로 링크가 생긴다.
 */
export default async function ReportDetailPage({ params }: { params: { id: string } }) {
  await requireUser(`/reports/${params.id}`);

  return (
    <ConsumerShell title="검토 리포트" activeTab="/home">
      <Suspense fallback={<LoadingState label="리포트를 불러오는 중" rows={3} variant="block" />}>
        <DetailSection analysisId={params.id} />
      </Suspense>
    </ConsumerShell>
  );
}

async function DetailSection({ analysisId }: { analysisId: string }) {
  await requireUser(`/reports/${analysisId}`);

  const supabase = await createClient();
  const report = await loadReport(supabase, analysisId);

  if (report === null) notFound();

  return (
    <div className="space-y-4">
      <ReportDetailView initial={report} />
      {/* 분석이 끝난 리포트만 공유할 수 있다 — 도는 중인 결과를 밖으로 보내면
          받는 사람이 **부분 결과**를 본다(§5.1). */}
      {report.status === "done" ? <SharePanel analysisId={report.analysisId} /> : null}
    </div>
  );
}

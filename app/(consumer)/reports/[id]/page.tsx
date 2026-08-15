import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { LoadingState } from "@/components/ui/LoadingState";
import { loadReport } from "@/lib/reports/loader";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { ReportDetailView } from "./ReportDetailView";

export const metadata: Metadata = {
  title: "검토 리포트 — 웨딩클리어",
};

/**
 * /reports/[id] — 리포트 상세 (F-C-07 · 명세서 §6.2)
 *
 * **남의 리포트는 404 다.** RLS 가 막아 `loadReport` 가 null 을 돌려주고, 여기서
 * 존재 여부도 알리지 않는다(업체 상세·대화가 세운 것과 같은 규칙).
 *
 * 공유(F-C-20)는 S7-12 다. 이 화면은 링크를 만들지 않는다 — 없는 화면으로 보내지
 * 않는다(S3-11).
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

  return <ReportDetailView initial={report} />;
}

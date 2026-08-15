import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { AiDisclaimer } from "@/components/domain/AiDisclaimer";
import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingState } from "@/components/ui/LoadingState";
import {
  ANALYSIS_STATUS_LABEL,
  PURGE_NOTICE,
  PURGE_STATE_LABEL,
} from "@/lib/core/report/pipeline";
import { listReports } from "@/lib/reports/loader";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "계약서 검토 — 웨딩클리어",
};

/**
 * /reports — 검토 리포트 목록 (F-C-07 · 명세서 §6.2)
 *
 * §6.2 가 요구하는 세 가지를 한 줄에 담는다 — **상태 · 위험 점수 · 파기 예정 시각**.
 * 파기 시각을 목록에 두는 이유는 그것이 이 기능의 약속이기 때문이다. 상세에만 있으면
 * 사용자는 원문이 언제 사라지는지 모른 채 목록만 본다.
 *
 * 하단 탭은 '홈' 을 켠다 — `/reports` 는 탭이 아니고(다섯 칸이 찼다 · D-55) 진입은
 * 홈의 '최근 검토 리포트' 다.
 */
export default async function ReportsPage() {
  await requireUser("/reports");

  return (
    <ConsumerShell title="계약서 검토" activeTab="/home">
      <Suspense fallback={<LoadingState label="리포트를 불러오는 중" rows={3} variant="list" />}>
        <ReportsSection />
      </Suspense>
    </ConsumerShell>
  );
}

async function ReportsSection() {
  await requireUser("/reports");

  const supabase = await createClient();
  const rows = await listReports(supabase);

  return (
    <div className="space-y-4">
      <AiDisclaimer />

      <Link
        href="/reports/upload"
        className="block rounded-lg bg-brand-500 px-4 py-3 text-center text-sm font-semibold text-primary-foreground"
        data-testid="reports-upload-link"
      >
        계약서 올리기
      </Link>

      <p className="text-caption text-muted-foreground">{PURGE_NOTICE}</p>

      {rows.length === 0 ? (
        <EmptyState
          title="아직 검토한 계약서가 없어요"
          description="계약서를 올리면 위험 조항을 찾아 기준과 견줘 드려요. 원문은 분석이 끝나면 바로 지웁니다."
        />
      ) : (
        <ul className="space-y-2" data-testid="report-list">
          {rows.map((row) => (
            <li key={row.documentId}>
              <ReportRow row={row} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReportRow({ row }: { row: Awaited<ReturnType<typeof listReports>>[number] }) {
  const body = (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border p-4">
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium text-foreground">
          {new Date(row.createdAt).toLocaleDateString("ko-KR")} 올린 계약서
        </p>
        <p className="text-caption text-muted-foreground">
          {row.status === null ? "분석을 시작하지 않았어요" : ANALYSIS_STATUS_LABEL[row.status]}
          {" · "}
          {/* 파기 완료를 실패로 읽히게 하지 않는다 — 그것이 약속한 동작이다. */}
          {PURGE_STATE_LABEL[row.purge]}
        </p>
      </div>

      {row.riskScore === null ? null : (
        <Badge variant="secondary" data-testid="report-risk">
          위험 {row.riskScore}
        </Badge>
      )}
    </div>
  );

  if (row.analysisId === null) return body;

  return (
    <Link href={`/reports/${row.analysisId}`} data-testid="report-link" className="block">
      {body}
    </Link>
  );
}

import type { Metadata } from "next";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { requireUser } from "@/lib/supabase/auth";

import { UploadView } from "./UploadView";

export const metadata: Metadata = {
  title: "계약서 올리기 — 웨딩클리어",
};

/**
 * /reports/upload — 업로드 (F-C-07 · 명세서 §6.2)
 *
 * 서버가 하는 일은 로그인 확인뿐이다. 업로드는 **클라이언트 → Storage** 직행이며
 * (§5.3) 이 화면은 그 절차와 고지를 담는다.
 */
export default async function ReportUploadPage() {
  await requireUser("/reports/upload");

  return (
    <ConsumerShell title="계약서 올리기" activeTab="/home">
      <UploadView />
    </ConsumerShell>
  );
}

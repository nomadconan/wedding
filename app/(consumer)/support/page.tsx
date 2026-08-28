import type { Metadata } from "next";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { SupportView } from "./SupportView";

export const metadata: Metadata = {
  title: "문의·신고 — 웨딩클리어",
};

/**
 * /support — 문의·신고 (F-A-06 접수 면 · §6.2 신설 제안 · S8-09)
 *
 * **§6.2 에 없던 화면을 신설했다.** 명세는 운영자 쪽(`/admin/tickets`)만 적는데
 * `tickets_insert` 정책은 사용자가 접수하는 것을 전제로 서 있었다 — **접수 경로가
 * 없으면 그 큐는 영원히 비고, 빈 큐는 "신고가 없다" 로 읽힌다**(FIX-25 계열).
 * S7-10 이 `/guides` 목록을 신설한 것과 같은 판단이다.
 *
 * **자기 티켓만 읽는다.** `tickets_select`(`reporter_id = auth.uid()`)가 경계이며
 * 여기서 조건을 다시 적지 않는다 — 두 곳에 적으면 한 곳이 낡는다.
 */
export const dynamic = "force-dynamic";

export default async function SupportPage() {
  await requireUser("/support");

  const supabase = await createClient();

  const { data } = await supabase
    .from("tickets")
    .select("id, category, subject, status, resolution, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <ConsumerShell title="문의·신고" activeTab="/me">
      <SupportView
        tickets={
          (data ?? []) as {
            id: string;
            category: string;
            subject: string;
            status: string;
            resolution: string | null;
            created_at: string;
          }[]
        }
      />
    </ConsumerShell>
  );
}

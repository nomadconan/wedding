import type { Metadata } from "next";
import Link from "next/link";

import { AdminShell } from "@/components/layout/AdminShell";
import { ErrorState } from "@/components/ui/ErrorState";
import { countByReason } from "@/lib/core/community/moderation";
import { COMMUNITY_FLAG, isFeatureEnabled } from "@/lib/flags";
import { loadQueue } from "@/lib/community/moderation";
import { requireOperator } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { ModerationPanel } from "./ModerationPanel";

export const metadata: Metadata = {
  title: "커뮤니티 모더레이션 — 웨딩클리어",
};

/**
 * /admin/community-reports (F-A-18 · §6.4)
 *
 * **큐 조회는 세션 클라이언트로 한다.** 0038 이 `is_operator()` 정책을 만들었고
 * 경계는 RLS 여야 한다(§5.5 · `/admin/penalties` 와 같은 선택). 조치만 서버가
 * 서비스롤로 수행한다 — 운영자에게 UPDATE 정책을 주면 되돌릴 수 없는 권한이
 * 클라이언트 번들이 닿는 자리에 놓인다(D-62).
 *
 * **플래그가 꺼져 있어도 이 화면은 연다.** 커뮤니티가 닫혀 있으면 새 글이 없을 뿐,
 * 이미 접수된 신고는 처리돼야 한다 — 모더레이션이 소비자 화면의 스위치에 매이면
 * "열지 않았으니 처리도 안 한다" 가 된다. 대신 지금 커뮤니티가 닫혀 있다는 사실을
 * 화면이 적는다.
 *
 * **서버 컴포넌트 조회의 캐시**(FIX-22)는 이 화면에 해당하지 않는다 — `createClient()`
 * 가 쿠키를 읽어 요청이 동적으로 판정되므로 `fetch` 캐시가 붙지 않는다. 플래그 조회만
 * 서비스롤이라 `lib/flags.ts` 가 `no-store` 를 못 박고 있다.
 */
export default async function AdminCommunityReportsPage({
  searchParams,
}: {
  searchParams: { state?: string };
}) {
  await requireOperator("/admin/community-reports");

  const closed = searchParams.state === "closed";

  try {
    const [queue, communityOpen] = await Promise.all([
      loadQueue(await createClient(), { closed, now: Date.now() }),
      isFeatureEnabled(COMMUNITY_FLAG),
    ]);

    const counts = countByReason(queue);

    return (
      <AdminShell
        role="admin"
        title="커뮤니티 모더레이션"
        description={
          closed
            ? `처리 완료 ${queue.length}건. 사유가 함께 남아 있습니다.`
            : queue.length > 0
              ? `처리 대기 ${queue.length}건 · ${counts.map((row) => `${row.label} ${row.count}`).join(" · ")}`
              : "처리할 신고가 없어요."
        }
      >
        <div className="space-y-4">
          <nav aria-label="큐" className="flex gap-2">
            <QueueTab href="/admin/community-reports" label="처리 대기" active={!closed} />
            <QueueTab
              href="/admin/community-reports?state=closed"
              label="처리 이력"
              active={closed}
            />
          </nav>

          {communityOpen ? null : (
            <p
              className="rounded-lg border border-border bg-muted p-3 text-caption text-muted-foreground"
              data-testid="moderation-community-closed"
            >
              커뮤니티는 아직 열지 않았어요(`community.enabled` 꺼짐). 이미 접수된 신고는 그대로
              처리할 수 있습니다.
            </p>
          )}

          <ModerationPanel items={queue} closed={closed} />
        </div>
      </AdminShell>
    );
  } catch {
    return (
      <AdminShell role="admin" title="커뮤니티 모더레이션">
        <ErrorState
          code="MOD_QUEUE_FAILED"
          title="신고 큐를 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }
}

function QueueTab({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-full border px-3 py-1 text-caption ${
        active ? "border-brand-500 text-brand-600" : "border-border text-muted-foreground"
      }`}
    >
      {label}
    </Link>
  );
}

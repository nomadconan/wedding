"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { POST_STATUS_LABEL } from "@/lib/core/community/community";
import {
  ABUSE_SIGNAL_LABEL,
  ABUSE_SIGNAL_NOTE,
  HARD_DELETE_NOTE,
  MODERATION_ACTIONS,
  MODERATION_ACTION_HINT,
  MODERATION_ACTION_LABEL,
  moderationProblem,
  type ModerationAction,
} from "@/lib/core/community/moderation";
import type { QueueItem } from "@/lib/community/moderation";
import { cn } from "@/lib/utils";

/**
 * 커뮤니티 모더레이션 (F-A-18 · §6.4 · D-24 · D-62)
 *
 * ── 운영자는 조율자다 ───────────────────────────────────────────────────────
 * **어떤 조치에도 사유가 붙는다.** '조치 없음' 에도 요구하는 이유는 나중에 "왜
 * 그대로 뒀나" 를 묻는 사람이 신고자이기 때문이다. 화면·라우트·DB CHECK 세 층이
 * 같은 것을 요구한다.
 *
 * ── 숫자는 사실이고 판정이 아니다 ───────────────────────────────────────────
 * 어뷰징 신호를 보여주되 **임계값을 두지 않는다**(O-14 미결). 숫자 옆에 그 사실을
 * 적어 두지 않으면 사람은 그것을 기준처럼 읽고, 그러면 우리가 정하지 않은 기준이
 * 생긴다.
 */
export function ModerationPanel({
  items,
  closed,
}: {
  items: QueueItem[];
  closed: boolean;
}) {
  if (items.length === 0) {
    return (
      <EmptyState
        title={closed ? "처리한 신고가 없어요" : "처리할 신고가 없어요"}
        description={
          closed
            ? "처리한 신고와 그 사유가 여기에 쌓입니다."
            : "접수된 신고가 오래된 것부터 여기에 쌓입니다."
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-caption text-muted-foreground">{ABUSE_SIGNAL_NOTE}</p>

      {items.map((item) => (
        <ReportCard key={item.reportId} item={item} closed={closed} />
      ))}

      <p className="text-caption text-neutral-500">{HARD_DELETE_NOTE}</p>
    </div>
  );
}

function ReportCard({ item, closed }: { item: QueueItem; closed: boolean }) {
  const router = useRouter();

  const [action, setAction] = useState<ModerationAction | null>(null);
  const [resolution, setResolution] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problem =
    action === null
      ? null
      : moderationProblem({
          action,
          resolution,
          targetStatus: item.target.status ?? "deleted",
        });

  async function submit() {
    if (action === null || problem !== null || busy) return;

    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/community-reports", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId: item.reportId, action, resolution: resolution.trim() }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "처리하지 못했어요.");

        return;
      }

      router.refresh();
    } catch {
      setError("처리하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="space-y-3 rounded-lg border border-border p-4"
      data-testid="moderation-report"
      data-status={item.status}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{item.reasonLabel}</Badge>
        <Badge variant="outline">{item.statusLabel}</Badge>

        {/* SLA 는 값이 있을 때만 말한다 — 없으면 판정하지 않는다(O-14). */}
        {item.sla.kind === "overdue" ? (
          <Badge variant="destructive">기한 {item.sla.overdueHours}시간 초과</Badge>
        ) : item.sla.kind === "within" ? (
          <Badge variant="outline">{item.sla.remainingHours}시간 남음</Badge>
        ) : (
          <span className="text-caption text-neutral-400">처리 기한 미설정({item.sla.openIssue})</span>
        )}
      </div>

      <div className="space-y-1">
        {item.target.exists ? (
          <>
            <p className="text-sm font-medium text-foreground">{item.target.title}</p>
            <p className="whitespace-pre-wrap text-caption text-muted-foreground">
              {item.target.excerpt}
            </p>
            <p className="text-caption text-neutral-500">
              현재 상태 · {POST_STATUS_LABEL[item.target.status ?? "published"]}
            </p>
          </>
        ) : (
          // **대상이 사라져도 신고는 남는다**(S7-14). 없다고 말하고 닫을 수 있게 둔다.
          <p className="text-sm text-muted-foreground">
            대상 글이 남아 있지 않아요. 신고 기록은 그대로 남습니다.
          </p>
        )}
      </div>

      <dl className="grid grid-cols-3 gap-2" data-testid="moderation-signals">
        {(Object.keys(ABUSE_SIGNAL_LABEL) as (keyof typeof ABUSE_SIGNAL_LABEL)[]).map((key) => (
          <div key={key} className="rounded-md border border-border px-2 py-1">
            <dt className="text-caption text-muted-foreground">{ABUSE_SIGNAL_LABEL[key]}</dt>
            <dd className="text-sm font-medium text-foreground">{item.signals[key]}</dd>
          </div>
        ))}
      </dl>

      {closed ? (
        <div className="space-y-1 rounded-md bg-muted p-3">
          <p className="text-caption font-medium text-muted-foreground">처리 사유</p>
          <p className="whitespace-pre-wrap text-sm text-foreground">{item.resolution}</p>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {MODERATION_ACTIONS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setAction(value)}
                aria-pressed={action === value}
                className={cn(
                  "rounded-md border px-3 py-2 text-sm",
                  action === value
                    ? "border-brand-500 text-brand-600"
                    : "border-border text-muted-foreground",
                )}
              >
                {MODERATION_ACTION_LABEL[value]}
              </button>
            ))}
          </div>

          {action === null ? null : (
            <p className="text-caption text-muted-foreground">{MODERATION_ACTION_HINT[action]}</p>
          )}

          <label className="block space-y-1">
            <span className="text-caption font-medium text-foreground">
              처리 사유 (필수 — 기록에 남고 나중에 설명의 근거가 됩니다)
            </span>
            <textarea
              value={resolution}
              onChange={(event) => setResolution(event.target.value)}
              rows={2}
              maxLength={1_000}
              className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm"
              data-testid="moderation-resolution"
            />
          </label>

          {problem !== null && resolution !== "" ? (
            <p role="alert" className="text-sm text-warning">
              {problem.message}
            </p>
          ) : null}

          {error !== null ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}

          <Button
            type="button"
            disabled={action === null || problem !== null || busy}
            onClick={() => void submit()}
          >
            {busy ? "처리 중…" : "처리하기"}
          </Button>
        </div>
      )}
    </section>
  );
}

export default ModerationPanel;

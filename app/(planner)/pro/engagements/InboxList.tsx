"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { PHASE_DETAIL, PHASE_LABEL } from "@/lib/core/planner/delegation";
import { formatTimestamp } from "@/lib/core/format/timestamp";
import type { PlannerInboxRow } from "@/lib/planners/delegation";

/**
 * 받은 위임 목록 (S6-04)
 *
 * **수락·거절 말고는 아무것도 할 수 없다.** 범위·기간을 바꾸는 칸을 두지 않는 이유는
 * 정책과 컬럼 권한이 그것을 막기 때문이며(0069), 막힌 일을 화면에 만들면 눌러도
 * 아무 일이 없는 버튼이 된다.
 */
export function InboxList({ rows }: { rows: PlannerInboxRow[] }) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function respond(id: string, action: "accept" | "decline") {
    setPendingId(id);
    setError(null);

    try {
      const response = await fetch(`/api/planner-engagements/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: { message?: string } };

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "처리하지 못했어요.");

        return;
      }

      router.refresh();
    } catch {
      setError("네트워크 문제로 처리하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="space-y-3" data-testid="planner-inbox">
      {rows.map((row) => (
        <article key={row.id} className="rounded-xl border border-border bg-background p-4">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">
              위임 제안 · {formatTimestamp(row.createdAt)}
            </h3>
            <span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700">
              {PHASE_LABEL[row.phase]}
            </span>
          </div>

          <p className="mt-1 text-xs text-neutral-600">{PHASE_DETAIL[row.phase]}</p>

          <dl className="mt-3 space-y-1 text-xs">
            <div className="flex gap-2">
              <dt className="shrink-0 text-neutral-500">범위</dt>
              <dd className="text-neutral-800">
                {row.scopes.length === 0
                  ? "열리는 항목이 없어요"
                  : row.scopes.map((scope) => scope.label).join(" · ")}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0 text-neutral-500">기간</dt>
              <dd className="text-neutral-800">
                {row.validFrom === null || row.validTo === null
                  ? "기간이 정해지지 않았어요"
                  : `${formatTimestamp(row.validFrom)} ~ ${formatTimestamp(row.validTo)}`}
              </dd>
            </div>
          </dl>

          {row.phase === "awaiting" ? (
            <div className="mt-3 flex gap-2">
              <Button size="sm" disabled={pendingId === row.id} onClick={() => respond(row.id, "accept")}>
                수락
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pendingId === row.id}
                onClick={() => respond(row.id, "decline")}
              >
                거절
              </Button>
            </div>
          ) : null}
        </article>
      ))}

      {error === null ? null : (
        <p className="rounded-lg border border-danger bg-danger-surface px-3 py-2 text-xs text-danger-foreground">
          {error}
        </p>
      )}
    </div>
  );
}

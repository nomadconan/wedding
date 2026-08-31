"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  PHASE_DETAIL,
  PHASE_LABEL,
  REVOKE_CONFIRM_TITLE,
  revokeImpact,
} from "@/lib/core/planner/delegation";
import { formatTimestamp } from "@/lib/core/format/timestamp";
import type { DelegationRow } from "@/lib/planners/delegation";

/**
 * 위임 목록·해제 (S6-04)
 *
 * ── 이 목록이 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **해제 전에 무엇이 바뀌는지 먼저 말한다.** 특히 "카테고리 선택은 그대로다" 를 —
 *    두 축이 다르다는 사실을 여기서 말하지 않으면 고객은 수수료도 멈춘 줄 안다(D-43).
 * 2. **국면을 계산해 보여준다.** `active` 인데 기간이 지난 위임은 "열람 중" 이 아니라
 *    "기간 종료" 다 — 저장된 상태를 그대로 적으면 열려 있지 않은 것을 열렸다고 쓴다.
 * 3. **끝난 위임을 감추지 않는다.** 거절·해제도 그대로 남는다(D-23).
 * 4. **대표가 아니면 버튼을 만들지 않는다.** 눌러도 403 이 나는 버튼은 장식이다.
 */
export function DelegationList({
  rows,
  canRevoke,
}: {
  rows: DelegationRow[];
  canRevoke: boolean;
}) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const impact = revokeImpact();

  async function revoke(id: string) {
    setPendingId(id);
    setError(null);

    try {
      const response = await fetch(`/api/planner-engagements/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revoke" }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: { message?: string } };

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "위임을 거두지 못했어요.");

        return;
      }

      setConfirmId(null);
      router.refresh();
    } catch {
      setError("네트워크 문제로 처리하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <ul className="space-y-3" data-testid="delegation-list">
      {rows.map((row) => {
        const live = row.phase === "awaiting" || row.phase === "scheduled" || row.phase === "effective";

        return (
          <li key={row.id} className="rounded-xl border border-border p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">
                {/* 플래너 이름을 못 읽었으면 지어내지 않는다. */}
                {row.plannerHeadline ?? "이름을 불러오지 못한 플래너"}
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
              {row.revokedAt === null ? null : (
                <div className="flex gap-2">
                  <dt className="shrink-0 text-neutral-500">거둔 시각</dt>
                  <dd className="text-neutral-800">{formatTimestamp(row.revokedAt)}</dd>
                </div>
              )}
            </dl>

            {/* 저장돼 있지만 아무것도 열지 않는 키. 조용히 버리지 않는다. */}
            {row.unknownScopes.length > 0 ? (
              <p className="mt-2 rounded-lg bg-warning-surface px-2 py-1.5 text-xs text-warning-foreground">
                이 위임에는 지금 열리지 않는 항목이 섞여 있어요({row.unknownScopes.join(", ")}).
                해당 항목은 아무것도 보여주지 않습니다.
              </p>
            ) : null}

            {live && canRevoke ? (
              confirmId === row.id ? (
                <div className="mt-3 rounded-lg border border-border bg-muted p-3">
                  <p className="text-sm font-medium text-foreground">{REVOKE_CONFIRM_TITLE}</p>
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-neutral-700">
                    {impact.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                  <div className="mt-3 flex gap-2">
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={pendingId === row.id}
                      onClick={() => revoke(row.id)}
                    >
                      거두기
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmId(null)}>
                      그대로 두기
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmId(row.id)}
                >
                  위임 거두기
                </Button>
              )
            ) : null}

            {live && !canRevoke ? (
              <p className="mt-3 text-xs text-neutral-500">
                위임을 거두는 것은 대표 계정만 할 수 있어요.
              </p>
            ) : null}
          </li>
        );
      })}

      {error === null ? null : (
        <li className="rounded-lg border border-danger bg-danger-surface px-3 py-2 text-xs text-danger-foreground">
          {error}
        </li>
      )}
    </ul>
  );
}

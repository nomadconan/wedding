"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { deactivationWarning } from "@/lib/core/rules/console";

/**
 * 룰 하나의 운영자 자산 수정 (S8-06 · F-A-03)
 *
 * ── 이 폼이 지키는 규칙 ─────────────────────────────────────────────────────
 * 1. **정규식·코드·등급을 고칠 자리가 없다.** 오타 하나가 스캔을 멈추거나(SyntaxError)
 *    특정 문서에서 되돌아오지 않게 만든다(파국적 백트래킹). 배포로 고친다 — 그 편이
 *    리뷰를 거친다(S7-01).
 * 2. **마지막 룰을 끌 때 결과를 미리 말한다.** 막지는 않는다(정당한 운영 판단일 수
 *    있다) — 다만 "위험 없음" 이 아니라 **분석이 아예 서지 않는다**는 것을 누르기 전에
 *    알린다.
 * 3. **사유가 필수다.** 룰을 끄는 것은 계약서에서 그 조항을 안 보겠다는 뜻이고,
 *    나중에 "왜 이 조항이 리포트에 없었나" 를 답해야 한다.
 * 4. **비우면 코드 값이 산다.** 빈 문자열은 '지웠다' 가 아니라 대개 사고라서
 *    `mergeDetectRules` 가 코드 값으로 되돌린다 — 화면이 그 사실을 적는다.
 */
export type RulePanelProps = {
  code: string;
  active: boolean;
  promptFragment: string;
  basisRef: string;
  /** 지금 도는 룰 수. 마지막 하나를 끄는지 판단하는 데 쓴다. */
  activeCount: number;
  /** 코드에 없는 룰이면 고칠 수 없다 — 고쳐도 실행되지 않는다. */
  orphaned: boolean;
};

export function RulePanel({
  code,
  active,
  promptFragment,
  basisRef,
  activeCount,
  orphaned,
}: RulePanelProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isActive, setIsActive] = useState(active);
  const [fragment, setFragment] = useState(promptFragment);
  const [basis, setBasis] = useState(basisRef);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (orphaned) {
    return (
      <p className="mt-2 text-caption text-muted-foreground" data-testid="rule-orphaned">
        코드에 없는 룰이라 <strong>실행되지 않습니다.</strong> 여기서 고쳐도 스캔이 그 룰을
        모릅니다 — 배포로 추가하거나 DB 행을 정리해야 합니다.
      </p>
    );
  }

  const warning = deactivationWarning(activeCount, active && !isActive);
  const trimmedReason = reason.trim();
  const problem = trimmedReason.length === 0 ? "왜 바꾸는지 적어 주세요." : null;

  async function submit() {
    if (problem !== null) return;

    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/rules", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          isActive,
          // 비어 있으면 **null 로 보낸다** — 빈 문자열을 저장하면 화면은 '지웠다' 로
          // 보이는데 실제로는 코드 값이 돈다(둘이 갈린다).
          promptFragment: fragment.trim() === "" ? null : fragment.trim(),
          basisRef: basis.trim() === "" ? null : basis.trim(),
          reason: trimmedReason,
        }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };

      if (!payload.ok) {
        setError(payload.error?.message ?? "저장하지 못했습니다.");

        return;
      }

      setReason("");
      setOpen(false);
      router.refresh();
    } catch {
      setError("저장하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        켬/끔·지시문 고치기
      </Button>
    );
  }

  const field = "w-full rounded-md border border-border bg-background px-3 py-2 text-sm";

  return (
    <div className="mt-3 space-y-3 rounded-md border border-border p-3" data-testid="rule-panel">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(event) => setIsActive(event.target.checked)}
          className="mt-1"
          data-testid="rule-active"
        />
        <span className="text-sm text-foreground">
          이 룰로 계약서를 검사합니다
          <span className="mt-0.5 block text-caption text-muted-foreground">
            끄면 그 조항을 보지 않습니다. 이미 나간 리포트는 바뀌지 않습니다.
          </span>
        </span>
      </label>

      {warning !== null ? (
        <p role="alert" className="text-sm text-warning" data-testid="rule-warning">
          {warning}
        </p>
      ) : null}

      <label className="block space-y-1">
        <span className="text-caption font-medium text-foreground">
          지시문 (AI 분석 단계에 함께 넘깁니다)
        </span>
        <textarea
          value={fragment}
          onChange={(event) => setFragment(event.target.value)}
          rows={3}
          maxLength={2_000}
          className={`${field} resize-y`}
          data-testid="rule-fragment"
        />
        <span className="text-caption text-muted-foreground">
          비우면 <strong>코드에 적힌 값이 그대로 돕니다</strong> — 빈 문자열로 저장되지
          않습니다.
        </span>
      </label>

      <label className="block space-y-1">
        <span className="text-caption font-medium text-foreground">근거 표기</span>
        <input
          value={basis}
          onChange={(event) => setBasis(event.target.value)}
          maxLength={500}
          className={field}
          data-testid="rule-basis"
        />
        <span className="text-caption text-muted-foreground">
          출처 수준까지만 적습니다. <strong>조항 번호를 적지 않습니다</strong> — 법무 검수
          전까지 우리는 조항 번호를 말하지 않습니다(S7-01).
        </span>
      </label>

      <label className="block space-y-1">
        <span className="text-caption font-medium text-foreground">
          변경 사유 (필수 — 기록에 남고 나중에 설명의 근거가 됩니다)
        </span>
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={2}
          maxLength={500}
          className={`${field} resize-none`}
          data-testid="rule-reason"
        />
      </label>

      {problem !== null && reason !== "" ? (
        <p role="alert" className="text-sm text-warning">
          {problem}
        </p>
      ) : null}

      {error !== null ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={pending || problem !== null} onClick={() => void submit()}>
          {pending ? "저장 중…" : "저장"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          접기
        </Button>
      </div>
    </div>
  );
}

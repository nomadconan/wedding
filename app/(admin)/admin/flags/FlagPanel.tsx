"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { type FlagRow, conditionNotice, emptyPartialWarning } from "@/lib/core/flags/registry";

/**
 * 플래그 토글 (S8-12 · F-A-10)
 *
 * ── 이 폼이 지키는 규칙 ─────────────────────────────────────────────────────
 * 1. **조건 미충족 상태로 켜는 것을 막지 않는다**(D-145). 긴급 롤백이 이 플래그의
 *    정의된 용도이고(§1.3), 조건은 기계가 판정할 수 있는 형태가 아니다. 대신 **조건을
 *    누르기 전에 보여주고** 사유를 요구한다.
 * 2. **되돌릴 수 없는 것을 먼저 말한다.** 플래그는 되돌릴 수 있지만 켜져 있던 동안
 *    벌어진 일은 되돌릴 수 없다.
 * 3. **자유 JSON 편집이 없다.** 코드가 선언한 부분 스위치만 토글하고 나머지 키(개방
 *    조건 서술 · D-67)는 그대로 보존한다 — 오타 하나가 기능을 닫는다.
 * 4. **코드가 모르는 플래그는 자리를 두지 않는다.** 켜도 아무 일도 안 일어나므로
 *    버튼이 있으면 화면이 거짓 기대를 만든다(S7-16 의 판단과 같다).
 */
export function FlagPanel({ flag }: { flag: FlagRow }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(flag.enabled);
  const [partials, setPartials] = useState<Record<string, boolean>>(
    Object.fromEntries(flag.partials.map((partial) => [partial.key, partial.on])),
  );
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!flag.inCode) {
    return (
      <p className="mt-2 text-caption text-muted-foreground" data-testid="flag-orphaned">
        이 키를 읽는 코드가 없습니다. <strong>켜 두어도 아무 일도 일어나지 않습니다</strong> —
        여기서 켜고 끌 수 있게 두면 화면이 거짓 기대를 만듭니다. 행을 지우거나 코드에서
        쓰는 것은 배포로 합니다.
      </p>
    );
  }

  if (!flag.inDatabase) {
    return (
      <p className="mt-2 text-caption text-muted-foreground" data-testid="flag-no-row">
        이 플래그의 행이 아직 없습니다. <strong>행이 없으면 꺼진 것</strong>이며, 만드는 것은
        마이그레이션의 몫입니다 — 콘솔이 행을 만들면 어떤 조건으로 열렸는지가 아무 데도
        안 남습니다.
      </p>
    );
  }

  const notice = conditionNotice(flag, !flag.enabled && enabled);
  const partialWarning = emptyPartialWarning(flag, partials);
  const trimmed = reason.trim();
  const problem = trimmed.length === 0 ? "왜 바꾸는지 적어 주세요." : null;

  async function submit() {
    if (problem !== null) return;

    setPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/admin/flags/${encodeURIComponent(flag.key)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          partials: flag.partials.length > 0 ? partials : null,
          reason: trimmed,
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
        켬/끔 바꾸기
      </Button>
    );
  }

  return (
    <div className="mt-3 space-y-3 rounded-md border border-border p-3" data-testid="flag-panel">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          className="mt-1"
          data-testid="flag-enabled"
        />
        <span className="text-sm text-foreground">
          이 기능을 켭니다
          <span className="mt-0.5 block text-caption text-muted-foreground">{flag.effect}</span>
        </span>
      </label>

      {/* 되돌릴 수 없는 것을 먼저 말한다. */}
      <p className="text-caption text-warning" data-testid="flag-irreversible">
        {flag.irreversible}
      </p>

      {notice !== null ? (
        <div className="rounded-md border border-border bg-muted p-3" data-testid="flag-condition">
          <p className="text-caption text-muted-foreground">{notice}</p>
          {Object.keys(flag.conditions).length > 0 ? (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-caption text-foreground">
              {JSON.stringify(flag.conditions, null, 2)}
            </pre>
          ) : null}
          <p className="mt-1 text-caption text-muted-foreground">
            조건 출처 — {flag.conditionSource}
          </p>
        </div>
      ) : null}

      {flag.partials.length > 0 ? (
        <fieldset className="space-y-2 rounded-md border border-border p-3">
          <legend className="px-1 text-caption font-medium text-foreground">
            부분 공개 (코드가 선언한 표현만)
          </legend>
          {flag.partials.map((partial) => (
            <label key={partial.key} className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={partials[partial.key] ?? false}
                onChange={(event) =>
                  setPartials((current) => ({ ...current, [partial.key]: event.target.checked }))
                }
                className="mt-1"
                data-testid={`flag-partial-${partial.key}`}
              />
              <span className="text-caption text-foreground">
                {partial.label}
                {partial.hint ? (
                  <span className="mt-0.5 block text-muted-foreground">{partial.hint}</span>
                ) : null}
              </span>
            </label>
          ))}
          {partialWarning !== null ? (
            <p role="alert" className="text-caption text-warning" data-testid="flag-partial-warning">
              {partialWarning}
            </p>
          ) : null}
        </fieldset>
      ) : null}

      <label className="block space-y-1">
        <span className="text-caption font-medium text-foreground">
          변경 사유 (필수 — 기록에 남고 나중에 설명의 근거가 됩니다)
        </span>
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={2}
          maxLength={500}
          className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm"
          data-testid="flag-reason"
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

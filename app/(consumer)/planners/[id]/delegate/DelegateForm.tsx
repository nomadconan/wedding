"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DELEGATABLE_SCOPES,
  DELEGATION_MESSAGE,
  type DelegationErrorCode,
  validateDelegation,
} from "@/lib/core/planner/delegation";

/**
 * 위임 제안 폼 (S6-04)
 *
 * ── 이 폼이 지키는 규칙 ─────────────────────────────────────────────────────
 * 1. **판정은 순수 함수 하나가 한다.** 화면과 API 가 다른 답을 내면 버튼이 살아
 *    있는데 눌리지 않는다 — `validateDelegation` 을 둘 다 쓰고 DB CHECK 이 최종
 *    경계다(세 층이 같은 목록을 본다).
 * 2. **항목마다 무엇이 열리는지 함께 적는다.** "장바구니" 하나가 담긴 항목까지
 *    연다는 사실은 이름만으로는 알 수 없다.
 * 3. **기간의 상한을 만들지 않는다**(§7.4 — 운영 파라미터를 코드가 고르지 않는다).
 *    다만 **끝은 반드시 있어야 한다**(D-166).
 * 4. **서버가 막으면 그 문장을 그대로 보여준다.**
 */
export function DelegateForm({ plannerId }: { plannerId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");

  // 날짜 입력은 로컬 날짜다. 판정도 저장도 UTC 순간으로 바꾼 뒤에 한다 —
  // 두 형식이 섞이면 "오늘까지" 가 어느 시각인지 화면과 DB 가 달라진다.
  const fromIso = validFrom === "" ? "" : new Date(`${validFrom}T00:00:00`).toISOString();
  const toIso = validTo === "" ? "" : new Date(`${validTo}T23:59:59`).toISOString();

  const validation = validateDelegation(
    { scopes, validFrom: fromIso, validTo: toIso },
    new Date(),
  );
  const errors: DelegationErrorCode[] = validation.ok ? [] : validation.errors;
  const ready = errors.length === 0 && !pending;

  function toggle(key: string) {
    setScopes((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]));
  }

  async function submit() {
    setPending(true);
    setServerErrors([]);

    try {
      const response = await fetch("/api/planner-engagements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plannerId, scopes, validFrom: fromIso, validTo: toIso }),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        error?: { message?: string; details?: { reasons?: { message: string }[] } };
      };

      if (!response.ok || !payload.ok) {
        const reasons = payload.error?.details?.reasons ?? [];
        setServerErrors(
          reasons.length > 0
            ? reasons.map((reason) => reason.message)
            : [payload.error?.message ?? "위임을 제안하지 못했어요."],
        );

        return;
      }

      router.push("/planners/delegations");
      router.refresh();
    } catch {
      setServerErrors(["네트워크 문제로 처리하지 못했어요. 잠시 후 다시 시도해 주세요."]);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="space-y-4 rounded-xl border border-border p-4" data-testid="delegate-form">
      <div>
        <h2 className="text-sm font-semibold text-foreground">무엇을 보여줄까요</h2>
        <ul className="mt-2 space-y-2">
          {DELEGATABLE_SCOPES.map((scope) => (
            <li key={scope.key}>
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 shrink-0 accent-brand-500"
                  checked={scopes.includes(scope.key)}
                  onChange={() => toggle(scope.key)}
                />
                <span className="text-sm text-neutral-800">
                  {scope.label}
                  <span className="block text-xs text-neutral-600">{scope.detail}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="delegate-from">시작일</Label>
          <Input
            id="delegate-from"
            type="date"
            value={validFrom}
            onChange={(event) => setValidFrom(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="delegate-to">종료일</Label>
          <Input
            id="delegate-to"
            type="date"
            value={validTo}
            onChange={(event) => setValidTo(event.target.value)}
          />
          <p className="mt-1 text-xs text-neutral-500">
            끝나는 날은 반드시 정해요. 무기한으로 열어 두면 잊었을 때 계속 보입니다.
          </p>
        </div>
      </div>

      {errors.length > 0 ? (
        <ul className="space-y-1 text-xs text-danger">
          {errors.map((code) => (
            <li key={code}>{DELEGATION_MESSAGE[code]}</li>
          ))}
        </ul>
      ) : null}

      {serverErrors.length > 0 ? (
        <ul className="rounded-lg border border-danger bg-danger-surface px-3 py-2 text-xs text-danger-foreground">
          {serverErrors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}

      <Button disabled={!ready} onClick={submit}>
        {pending ? "제안하는 중" : "위임 제안하기"}
      </Button>
    </section>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * 지수 재계산 (S8-10 · F-A-02)
 *
 * **사유 없이 다시 셀 수 없다.** 지수는 이 서비스의 핵심 값이라 누가 왜 다시 셌는지가
 * 남아야 한다(`entity_events` + `audit_logs`).
 *
 * **표본이 하한에 못 미치면 사분위를 비운다** — 옛 값을 남겨 두면 화면이 낡은 시세를
 * 계속 보여준다. 응답이 그 사실(`blocked`)을 그대로 알려 준다.
 */
export function RecalculatePanel() {
  const router = useRouter();
  const [regionCode, setRegionCode] = useState("");
  const [category, setCategory] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const problem =
    regionCode.trim() === ""
      ? "지역을 입력해 주세요."
      : category.trim() === ""
        ? "카테고리를 입력해 주세요."
        : reason.trim() === ""
          ? "재계산 사유를 적어 주세요."
          : null;

  async function submit() {
    if (problem) return;

    setPending(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch("/api/admin/prices/recalculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ regionCode, category, reason }),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        data?: { sampleSize: number; p50: number | null; blocked: string | null };
        error?: { message: string };
      };

      if (!payload.ok) {
        setError(payload.error?.message ?? "재계산하지 못했습니다.");

        return;
      }

      // **표본 부족을 실패로 적지 않는다.** 아직 안 모인 것이지 고장이 아니다.
      setMessage(
        payload.data?.blocked
          ? `업체 ${payload.data.sampleSize}곳으로는 사분위를 만들지 않았습니다. 표본이 더 모이면 값이 생깁니다.`
          : `업체 ${payload.data?.sampleSize}곳으로 다시 셌습니다. 중앙값 ${payload.data?.p50?.toLocaleString("en-US")}원.`,
      );
      setReason("");
      router.refresh();
    } catch {
      setError("재계산하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-border p-3" data-testid="recalculate-panel">
      <p className="text-sm font-medium text-foreground">지수 재계산</p>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="recalc-region">지역</Label>
          <Input
            id="recalc-region"
            value={regionCode}
            onChange={(event) => setRegionCode(event.target.value)}
            placeholder="서울 강남"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="recalc-category">카테고리</Label>
          <Input
            id="recalc-category"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            placeholder="hall"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="recalc-reason">
            사유 <span className="text-danger">*</span>
          </Label>
          <Input
            id="recalc-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="이상치 제외 후 재계산"
            maxLength={1000}
          />
        </div>
      </div>

      <p className="text-caption text-muted-foreground">
        제외한 표본은 유지됩니다 — 재계산이 큐레이션을 되돌리지 않습니다.
      </p>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {message ? <p className="text-sm text-foreground">{message}</p> : null}

      <Button type="button" size="sm" disabled={Boolean(problem) || pending} onClick={submit}>
        {pending ? "다시 세는 중…" : "다시 세기"}
      </Button>
      {problem ? <p className="text-caption text-muted-foreground">{problem}</p> : null}
    </div>
  );
}

export default RecalculatePanel;

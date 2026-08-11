"use client";

import { Trash2 } from "lucide-react";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Label } from "@/components/ui/label";
import type { AvailabilityRow } from "@/lib/consultation/loader";

const ENDPOINT = "/api/vendor/availability";

/** 0=일요일 … 6=토요일. 0007 이 `extract(dow from date)` 와 같은 규약으로 정했다. */
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

/**
 * 상담 가능 시간대 등록 (F-V-17 · S4-06, §6.3 `/vendor/availability`)
 *
 * **겹침을 화면이 판정하지 않는다.** 0007 의 EXCLUDE 가 거부하고, 화면은 그 결과를
 * 문장으로 옮긴다 — 화면이 미리 검사하면 동시 등록에서 지고, 판정이 두 곳에 생긴다.
 */
export function AvailabilityView({ initialRules }: { initialRules: AvailabilityRow[] }) {
  const [rules, setRules] = useState(initialRules);
  const [weekday, setWeekday] = useState(6);
  const [startTime, setStartTime] = useState("14:00");
  const [endTime, setEndTime] = useState("17:00");
  const [slotMinutes, setSlotMinutes] = useState(60);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(ENDPOINT);
      const payload = await response.json();

      if (response.ok && payload.ok) setRules(payload.data.rules as AvailabilityRow[]);
    } catch {
      // 목록은 이미 그려져 있다.
    }
  }, []);

  async function call(body: unknown) {
    setPending(true);
    setError(null);

    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "처리하지 못했어요.");

        return;
      }

      await refresh();
    } catch {
      setError("처리하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="vendor-availability">
      <Card>
        <CardContent className="space-y-3 pt-5">
          <p className="text-sm font-semibold text-foreground">시간대 추가</p>

          <div className="grid gap-3 sm:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="avail-weekday">요일</Label>
              <select
                id="avail-weekday"
                value={weekday}
                onChange={(event) => setWeekday(Number(event.target.value))}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                {WEEKDAYS.map((label, index) => (
                  <option key={label} value={index}>
                    {label}요일
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="avail-start">시작</Label>
              <input
                id="avail-start"
                type="time"
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="avail-end">종료</Label>
              <input
                id="avail-end"
                type="time"
                value={endTime}
                onChange={(event) => setEndTime(event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="avail-slot">슬롯 길이(분)</Label>
              <input
                id="avail-slot"
                type="number"
                min={5}
                max={1440}
                step={5}
                value={slotMinutes}
                onChange={(event) => setSlotMinutes(Number(event.target.value))}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              />
            </div>
          </div>

          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}

          <Button
            type="button"
            disabled={pending}
            onClick={() =>
              void call({ action: "create", weekday, startTime, endTime, slotMinutes })
            }
            data-testid="add-availability"
          >
            추가
          </Button>

          <p className="text-caption text-muted-foreground">
            같은 요일에 시간대가 겹치면 등록되지 않아요. 오전·오후처럼 나눠서 등록해 주세요.
          </p>
        </CardContent>
      </Card>

      {rules.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              assetId="vendor.dashboard.empty"
              title="아직 등록한 시간대가 없어요"
              description="시간대를 등록해야 고객이 상담·탐방을 신청할 수 있어요."
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-border" data-testid="availability-rules">
              {rules.map((rule) => (
                <li
                  key={rule.id}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                  data-testid="availability-rule"
                >
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {WEEKDAYS[rule.weekday]}요일 {rule.startTime.slice(0, 5)} ~{" "}
                      {rule.endTime.slice(0, 5)}
                    </p>
                    <p className="text-caption text-muted-foreground">
                      {rule.slotMinutes}분 단위로 예약을 받아요
                    </p>
                  </div>

                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    aria-label="시간대 삭제"
                    onClick={() => void call({ action: "delete", id: rule.id })}
                  >
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

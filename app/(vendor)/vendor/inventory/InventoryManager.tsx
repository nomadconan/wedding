"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CSV_TEMPLATE } from "@/lib/core/inventory/csv";
import { SLOT_BULK_MAX, WEEKDAY_LABEL } from "@/lib/core/schemas/inventory";

import { InventoryCalendar, type DaySlot } from "./InventoryCalendar";

/**
 * 재고 관리 (F-V-05, §6.3 `/vendor/inventory`)
 *
 * 세 가지 등록 방법을 탭으로 나눈다 — 반복 규칙 / CSV / 블록 처리.
 * **재고는 가격·정산이 아니므로 staff 도 등록할 수 있다**(§3.9). 그래서 이 화면에는
 * owner 전용 비활성화가 없다. 최종 경계는 RLS 다.
 *
 * 상담 가능 시간대(`vendor_availability`, S4-02)는 **초기값 제안**으로만 쓴다.
 * 상담 시간과 예식 재고는 다른 것이라 데이터를 엮지 않는다 — 자세한 근거는 페이지 주석 참조.
 */
export type AvailabilityHint = {
  weekday: number;
  startTime: string;
  endTime: string;
  slotMinutes: number;
};

export type InventoryManagerProps = {
  month: string;
  slotsByDate: Record<string, DaySlot[]>;
  availability: AvailabilityHint[];
};

const TODAY_FALLBACK_TIMES = "11:00, 14:00";

export function InventoryManager({ month, slotsByDate, availability }: InventoryManagerProps) {
  const router = useRouter();

  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorRows, setErrorRows] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  // 반복 규칙
  const [from, setFrom] = useState(`${month}-01`);
  const [to, setTo] = useState(`${month}-28`);
  const [weekdays, setWeekdays] = useState<number[]>([6, 0]);
  const [times, setTimes] = useState(TODAY_FALLBACK_TIMES);
  const [capacity, setCapacity] = useState("1");

  // CSV
  const [csv, setCsv] = useState("");

  // 블록
  const [blockFrom, setBlockFrom] = useState(`${month}-01`);
  const [blockTo, setBlockTo] = useState(`${month}-01`);

  async function submit(payload: unknown, successMessage: string) {
    setPending(true);
    setError(null);
    setErrorRows([]);
    setNotice(null);

    try {
      const response = await fetch("/api/vendor/inventory/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();

      if (!response.ok || !body.ok) {
        setError(body.error?.message ?? "처리하지 못했어요.");

        const details = body.error?.details;
        if (Array.isArray(details)) {
          setErrorRows(
            details.map((detail: unknown) =>
              typeof detail === "string"
                ? detail
                : `${(detail as { line?: number }).line ?? "-"}행: ${(detail as { message?: string }).message ?? ""}`,
            ),
          );
        }

        return;
      }

      setNotice(successMessage.replace("{n}", String(body.data.created ?? body.data.affected ?? 0)));
      router.refresh();
    } catch {
      setError("처리하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  function applyAvailabilityHint() {
    if (availability.length === 0) return;

    setWeekdays([...new Set(availability.map((row) => row.weekday))]);
    setTimes([...new Set(availability.map((row) => row.startTime.slice(0, 5)))].sort().join(", "));
    setNotice("상담 가능 시간대를 초기값으로 채웠습니다. 예식 재고에 맞게 고쳐 주세요.");
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <InventoryCalendar
        month={month}
        slotsByDate={slotsByDate}
        selectedDate={selectedDate}
        onSelectDate={setSelectedDate}
      />

      <div className="space-y-3" data-testid="inventory-manager">
        <Tabs defaultValue="repeat">
          <TabsList>
            <TabsTrigger value="repeat">반복 등록</TabsTrigger>
            <TabsTrigger value="csv">CSV</TabsTrigger>
            <TabsTrigger value="block">블록</TabsTrigger>
          </TabsList>

          {/* ── 반복 규칙 ─────────────────────────────────────────────── */}
          <TabsContent value="repeat" className="space-y-3 pt-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="repeat-from">시작일</Label>
                <Input id="repeat-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="repeat-to">종료일</Label>
                <Input id="repeat-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>요일</Label>
              <div className="flex flex-wrap gap-2">
                {WEEKDAY_LABEL.map((label, index) => (
                  <div key={label} className="flex items-center gap-1">
                    <Checkbox
                      id={`weekday-${index}`}
                      checked={weekdays.includes(index)}
                      onCheckedChange={(checked) =>
                        setWeekdays((prev) =>
                          checked === true ? [...new Set([...prev, index])] : prev.filter((d) => d !== index),
                        )
                      }
                    />
                    <Label htmlFor={`weekday-${index}`} className="font-normal">
                      {label}
                    </Label>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="repeat-times">시각 (쉼표로 구분)</Label>
              <Input
                id="repeat-times"
                value={times}
                onChange={(e) => setTimes(e.target.value)}
                placeholder="11:00, 14:00"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="repeat-capacity">정원</Label>
              <Input
                id="repeat-capacity"
                type="number"
                min={1}
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
              />
              <p className="text-caption text-muted-foreground">
                한 번에 {SLOT_BULK_MAX}개까지 만들 수 있습니다. 휴무는 &apos;블록&apos; 탭에서
                처리합니다.
              </p>
            </div>

            {availability.length > 0 ? (
              <Button type="button" variant="outline" size="sm" onClick={applyAvailabilityHint}>
                상담 가능 시간대에서 가져오기
              </Button>
            ) : null}

            <Button
              type="button"
              disabled={pending}
              onClick={() =>
                submit(
                  {
                    mode: "repeat",
                    rule: {
                      from,
                      to,
                      weekdays,
                      times: times
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean),
                      capacity: Number(capacity),
                      productId: null,
                    },
                  },
                  "{n}개 슬롯을 만들었습니다.",
                )
              }
            >
              {pending ? "처리 중…" : "슬롯 만들기"}
            </Button>
          </TabsContent>

          {/* ── CSV ───────────────────────────────────────────────────── */}
          <TabsContent value="csv" className="space-y-3 pt-3">
            <div className="space-y-1.5">
              <Label htmlFor="csv-input">CSV 내용</Label>
              <textarea
                id="csv-input"
                rows={8}
                value={csv}
                onChange={(e) => setCsv(e.target.value)}
                placeholder={CSV_TEMPLATE}
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              />
              <p className="text-caption text-muted-foreground">
                첫 줄은 <code>date,time,capacity,product_id</code> 입니다. 한 행이라도 형식이
                틀리면 <strong>전체가 반영되지 않고</strong> 어느 줄이 문제인지 알려 드립니다.
              </p>
            </div>

            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setCsv(CSV_TEMPLATE)}
              >
                예시 채우기
              </Button>
              <Button
                type="button"
                disabled={pending || csv.trim().length === 0}
                onClick={() => submit({ mode: "csv", csv }, "{n}개 슬롯을 만들었습니다.")}
              >
                {pending ? "처리 중…" : "가져오기"}
              </Button>
            </div>
          </TabsContent>

          {/* ── 블록 ──────────────────────────────────────────────────── */}
          <TabsContent value="block" className="space-y-3 pt-3">
            <p className="text-caption text-muted-foreground">
              휴무나 외부 예약으로 막을 기간을 고릅니다. 정원은 지우지 않고 상태만 바꾸므로
              언제든 되돌릴 수 있습니다.
            </p>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="block-from">시작일</Label>
                <Input
                  id="block-from"
                  type="date"
                  value={blockFrom}
                  onChange={(e) => setBlockFrom(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="block-to">종료일</Label>
                <Input
                  id="block-to"
                  type="date"
                  value={blockTo}
                  onChange={(e) => setBlockTo(e.target.value)}
                />
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                type="button"
                variant="destructive"
                disabled={pending}
                onClick={() =>
                  submit(
                    { mode: "block", range: { from: blockFrom, to: blockTo, times: [], status: "blocked" } },
                    "{n}개 슬롯을 막았습니다.",
                  )
                }
              >
                막기
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  submit(
                    { mode: "block", range: { from: blockFrom, to: blockTo, times: [], status: "open" } },
                    "{n}개 슬롯을 열었습니다.",
                  )
                }
              >
                되돌리기
              </Button>
            </div>
          </TabsContent>
        </Tabs>

        {error ? (
          <div role="alert" className="space-y-1">
            <p className="text-sm text-danger">{error}</p>
            {errorRows.length > 0 ? (
              <ul className="max-h-40 space-y-0.5 overflow-y-auto">
                {errorRows.slice(0, 20).map((row) => (
                  <li key={row} className="text-caption text-danger">
                    · {row}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {notice ? <p className="text-sm text-success">{notice}</p> : null}
      </div>
    </div>
  );
}

export default InventoryManager;

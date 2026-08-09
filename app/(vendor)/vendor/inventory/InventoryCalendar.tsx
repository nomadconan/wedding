"use client";

import { SLOT_STATUS_LABEL, WEEKDAY_LABEL, type SlotStatus } from "@/lib/core/schemas/inventory";
import { cn } from "@/lib/utils";

/**
 * 월 달력 (F-V-05, §6.3 `/vendor/inventory`)
 *
 * 새 색을 만들지 않는다. 상태는 **DESIGN.md 시맨틱 3종 안에서만** 표현한다.
 *   슬롯 없음 → 무채색 / 예약 가능 → brand / 잔여 0 → warning / 막음 → danger
 * 색만으로 상태를 전달하지 않고 숫자와 배지 문구를 함께 둔다(§7.5 접근성).
 */
export type DaySlot = {
  id: string;
  time: string;
  capacity: number;
  remaining: number;
  status: SlotStatus;
};

export type InventoryCalendarProps = {
  /** 'YYYY-MM' */
  month: string;
  slotsByDate: Record<string, DaySlot[]>;
  selectedDate: string | null;
  onSelectDate: (date: string) => void;
};

/** 달력 격자에 쓸 날짜 목록. 앞뒤 빈칸은 null 이다. UTC 기준으로만 계산한다. */
function buildMonthGrid(month: string): (string | null)[] {
  const first = new Date(`${month}-01T00:00:00Z`);
  const year = first.getUTCFullYear();
  const monthIndex = first.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

  const cells: (string | null)[] = Array.from({ length: first.getUTCDay() }, () => null);

  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(`${month}-${String(day).padStart(2, "0")}`);
  }

  while (cells.length % 7 !== 0) cells.push(null);

  return cells;
}

function dayTone(slots: DaySlot[] | undefined) {
  if (!slots || slots.length === 0) return "empty" as const;
  if (slots.every((slot) => slot.status === "blocked")) return "blocked" as const;

  const open = slots.filter((slot) => slot.status === "open");

  return open.some((slot) => slot.remaining > 0) ? "open" : ("full" as const);
}

const TONE_CLASS = {
  empty: "border-border bg-background text-muted-foreground",
  open: "border-brand-200 bg-brand-50 text-brand-700",
  full: "border-warning bg-warning-surface text-warning-foreground",
  blocked: "border-danger bg-danger-surface text-danger-foreground",
} as const;

const TONE_LABEL = {
  empty: "슬롯 없음",
  open: "예약 가능",
  full: "잔여 없음",
  blocked: "막음",
} as const;

export function InventoryCalendar({
  month,
  slotsByDate,
  selectedDate,
  onSelectDate,
}: InventoryCalendarProps) {
  const cells = buildMonthGrid(month);

  return (
    <div className="space-y-3" data-testid="inventory-calendar">
      <div className="grid grid-cols-7 gap-1 text-center">
        {WEEKDAY_LABEL.map((label) => (
          <div key={label} className="text-caption font-medium text-muted-foreground">
            {label}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((date, index) => {
          if (!date) return <div key={`empty-${index}`} />;

          const slots = slotsByDate[date];
          const tone = dayTone(slots);
          const remaining = (slots ?? [])
            .filter((slot) => slot.status === "open")
            .reduce((sum, slot) => sum + slot.remaining, 0);

          return (
            <button
              key={date}
              type="button"
              onClick={() => onSelectDate(date)}
              aria-pressed={selectedDate === date}
              className={cn(
                "flex min-h-16 flex-col items-start gap-0.5 rounded-md border p-1.5 text-left transition-colors",
                TONE_CLASS[tone],
                selectedDate === date ? "ring-2 ring-ring ring-offset-1" : null,
              )}
            >
              <span className="text-caption font-medium">{Number(date.slice(8))}</span>

              {slots && slots.length > 0 ? (
                <>
                  <span className="text-caption">슬롯 {slots.length}</span>
                  {/* 색만으로 상태를 전달하지 않는다(§7.5). */}
                  <span className="text-caption">
                    {tone === "blocked" ? TONE_LABEL.blocked : `잔여 ${remaining}`}
                  </span>
                </>
              ) : null}
            </button>
          );
        })}
      </div>

      <ul className="flex flex-wrap gap-3">
        {(["open", "full", "blocked", "empty"] as const).map((tone) => (
          <li key={tone} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={cn("h-3 w-3 rounded-sm border", TONE_CLASS[tone])}
            />
            <span className="text-caption text-muted-foreground">{TONE_LABEL[tone]}</span>
          </li>
        ))}
      </ul>

      {selectedDate ? (
        <div className="rounded-lg border border-border p-3" data-testid="day-detail">
          <p className="text-sm font-medium">{selectedDate}</p>

          {!slotsByDate[selectedDate] || slotsByDate[selectedDate].length === 0 ? (
            <p className="mt-1 text-caption text-muted-foreground">등록된 슬롯이 없습니다.</p>
          ) : (
            <ul className="mt-2 space-y-1">
              {slotsByDate[selectedDate].map((slot) => (
                <li key={slot.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium">{slot.time.slice(0, 5)}</span>
                  <span className="text-unit text-muted-foreground">
                    {SLOT_STATUS_LABEL[slot.status]} · 잔여 {slot.remaining} / 정원 {slot.capacity}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default InventoryCalendar;

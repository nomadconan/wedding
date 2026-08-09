// 실재고 슬롯 스키마 (S2-05 · 명세서 §2.2 F-V-05, §3.4 inventory_slots, §4.3)
//
// 슬롯은 **날짜 + 시각 한 점**이다. 같은 자리에 슬롯이 둘이면 어느 것을 소진시킬지
// 비결정적이 되므로 DB 가 UNIQUE 로 막고, 여기서는 입력 단계에서 중복을 걸러 준다.
//
// `capacity` 는 업체가 정하는 총량, `remaining` 은 예약에 따라 줄어드는 값이다.
// **예약은 4단계(bookings)** 라 이번 범위에서 remaining 을 줄이지 않는다.

import { z } from "zod";

/** 슬롯 상태. DB CHECK 와 값이 같다. */
export const SLOT_STATUSES = ["open", "blocked"] as const;
export type SlotStatus = (typeof SLOT_STATUSES)[number];
export const SlotStatusSchema = z.enum(SLOT_STATUSES);

export const SLOT_STATUS_LABEL: Record<SlotStatus, string> = {
  open: "예약 가능",
  blocked: "막음",
};

/** 'YYYY-MM-DD'. 로컬 타임존 변환을 끼우지 않는다 — 하루가 밀리는 사고를 막는다. */
export const DateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 YYYY-MM-DD 형식으로 입력해 주세요.")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), {
    message: "존재하지 않는 날짜입니다.",
  });

/** 'HH:MM'. 초는 받지 않는다 — 예식 슬롯에 초 단위가 필요한 적이 없다. */
export const TimeStringSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "시각은 HH:MM 형식으로 입력해 주세요.");

export const CapacitySchema = z
  .number({ required_error: "정원을 입력해 주세요.", invalid_type_error: "정원은 숫자로 입력해 주세요." })
  .int("정원은 정수로 입력해 주세요.")
  .min(1, "정원은 1 이상이어야 합니다. 휴무는 '막음'으로 표시하세요.")
  .max(1000, "정원을 다시 확인해 주세요.");

/** 슬롯 한 칸. 화면·CSV·반복 규칙이 모두 이 모양으로 수렴한다. */
export const SlotInputSchema = z.object({
  date: DateStringSchema,
  time: TimeStringSchema,
  capacity: CapacitySchema,
  /** 상품별 재고. 비우면 업체 전체 재고다. */
  productId: z.string().uuid().nullable().default(null),
});

export type SlotInput = z.infer<typeof SlotInputSchema>;

/** 요일 0=일 … 6=토. `vendor_availability.weekday`·Postgres `extract(dow)` 와 같은 규약. */
export const WeekdaySchema = z.number().int().min(0).max(6);

export const WEEKDAY_LABEL = ["일", "월", "화", "수", "목", "금", "토"] as const;

/**
 * 반복 규칙 일괄 등록.
 * 기간 안에서 지정한 요일에만, 지정한 시각들로 슬롯을 만든다.
 */
export const RepeatRuleSchema = z
  .object({
    from: DateStringSchema,
    to: DateStringSchema,
    weekdays: z.array(WeekdaySchema).min(1, "요일을 하나 이상 선택해 주세요."),
    times: z.array(TimeStringSchema).min(1, "시각을 하나 이상 입력해 주세요.").max(24),
    capacity: CapacitySchema,
    productId: z.string().uuid().nullable().default(null),
  })
  .refine((input) => input.from <= input.to, {
    message: "종료일이 시작일보다 빠릅니다.",
    path: ["to"],
  })
  .refine((input) => daysBetween(input.from, input.to) <= 366, {
    message: "한 번에 1년 이내 기간만 등록할 수 있습니다.",
    path: ["to"],
  });

export type RepeatRule = z.input<typeof RepeatRuleSchema>;

/** 두 날짜 사이의 일수(양끝 포함). UTC 자정 기준이라 타임존이 끼어들지 않는다. */
export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);

  return Math.floor((end - start) / 86_400_000) + 1;
}

/** 한 번에 만들 수 있는 슬롯 수. 실수로 몇 년치를 만드는 사고를 막는다. */
export const SLOT_BULK_MAX = 2000;

/**
 * 반복 규칙을 슬롯 목록으로 편다.
 *
 * 순수 함수다 — DB 도 타임존도 모른다. 날짜 계산은 UTC 자정 기준으로만 한다.
 */
export function expandRepeatRule(rule: {
  from: string;
  to: string;
  weekdays: number[];
  times: string[];
  capacity: number;
  productId?: string | null;
}): SlotInput[] {
  const slots: SlotInput[] = [];
  const start = Date.parse(`${rule.from}T00:00:00Z`);
  const end = Date.parse(`${rule.to}T00:00:00Z`);
  const weekdays = new Set(rule.weekdays);
  const times = [...new Set(rule.times)].sort();

  for (let cursor = start; cursor <= end; cursor += 86_400_000) {
    const day = new Date(cursor);
    if (!weekdays.has(day.getUTCDay())) continue;

    const date = day.toISOString().slice(0, 10);
    for (const time of times) {
      slots.push({ date, time, capacity: rule.capacity, productId: rule.productId ?? null });
    }
  }

  return slots;
}

/** 같은 자리(상품·날짜·시각)의 중복을 찾는다. DB UNIQUE 와 같은 기준이다. */
export function findDuplicateSlots(slots: SlotInput[]): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];

  for (const slot of slots) {
    const key = `${slot.productId ?? "-"}|${slot.date}|${slot.time}`;
    if (seen.has(key)) duplicates.push(`${slot.date} ${slot.time}`);
    seen.add(key);
  }

  return duplicates;
}

/** 블록·해제 대상. 날짜 구간과 (선택) 시각으로 지정한다. */
export const BlockRangeSchema = z
  .object({
    from: DateStringSchema,
    to: DateStringSchema,
    /** 비우면 그 기간의 모든 시각을 대상으로 한다. */
    times: z.array(TimeStringSchema).max(24).default([]),
    status: SlotStatusSchema,
  })
  .refine((input) => input.from <= input.to, {
    message: "종료일이 시작일보다 빠릅니다.",
    path: ["to"],
  });

/** 일괄 등록 요청. 하나의 엔드포인트가 세 가지 모드를 받는다(§4.3 의 API 표면 유지). */
export const InventoryBulkSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("repeat"), rule: RepeatRuleSchema }),
  z.object({ mode: z.literal("csv"), csv: z.string().min(1, "CSV 내용이 비어 있습니다.") }),
  z.object({ mode: z.literal("block"), range: BlockRangeSchema }),
]);

export type InventoryBulk = z.input<typeof InventoryBulkSchema>;

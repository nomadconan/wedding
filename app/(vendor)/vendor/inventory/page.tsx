import type { Metadata } from "next";
import Link from "next/link";

import { AdminShell } from "@/components/layout/AdminShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import type { SlotStatus } from "@/lib/core/schemas/inventory";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { findMemberVendor } from "@/lib/vendor/products";

import type { DaySlot } from "./InventoryCalendar";
import { InventoryManager, type AvailabilityHint } from "./InventoryManager";

export const metadata: Metadata = {
  title: "재고 캘린더 — 웨딩클리어",
};

/**
 * /vendor/inventory (F-V-05, §6.3)
 *
 * 조회는 **사용자 세션 클라이언트**로 한다 — RLS 가 자기 업체 슬롯만 보여준다.
 *
 * **`vendor_availability`(S4-02)를 재고의 근거로 쓰지 않는다.**
 * 그건 **상담·탐방 가능 시간대**(F-V-17)이고 여기는 **예식 재고**(F-V-05)다.
 * 상담을 받는 시간과 예식을 치를 수 있는 시간은 다르고, 한쪽을 고치면 다른 쪽이
 * 따라 바뀌는 구조는 사고가 난다. 대신 **초기값 제안**으로만 화면에 넘긴다 —
 * 이미 적어 둔 요일·시각을 다시 타이핑하지 않게 하는 편의이며 저장되는 값은 별개다.
 */
function monthOf(value: string | undefined): string {
  if (value && /^\d{4}-\d{2}$/.test(value)) return value;

  // 서버 시각 기준 이번 달. 슬롯 날짜는 date 타입이라 타임존 변환이 끼어들지 않는다.
  return new Date().toISOString().slice(0, 7);
}

function lastDayOf(month: string): string {
  const [year, monthIndex] = month.split("-").map(Number);
  const day = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();

  return `${month}-${String(day).padStart(2, "0")}`;
}

function shiftMonth(month: string, delta: number): string {
  const [year, monthIndex] = month.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, monthIndex - 1 + delta, 1));

  return shifted.toISOString().slice(0, 7);
}

export default async function VendorInventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const user = await requireUser("/vendor/inventory");
  const { month: monthParam } = await searchParams;
  const month = monthOf(monthParam);

  const supabase = await createClient();
  const vendor = await findMemberVendor(user.id);

  if (!vendor) {
    return (
      <AdminShell role="vendor" title="재고 캘린더">
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              assetId="vendor.dashboard.empty"
              title="아직 등록된 업체가 없어요"
              description="입점 신청을 마치면 예약 가능한 날짜를 등록할 수 있습니다."
              action={
                <Button size="touch" asChild>
                  <Link href="/vendor/apply">입점 신청하러 가기</Link>
                </Button>
              }
            />
          </CardContent>
        </Card>
      </AdminShell>
    );
  }

  const { data: slots, error } = await supabase
    .from("inventory_slots")
    .select("id, slot_date, slot_time, capacity, remaining, status")
    .eq("vendor_id", vendor.id)
    .gte("slot_date", `${month}-01`)
    .lte("slot_date", lastDayOf(month))
    .order("slot_date", { ascending: true })
    .order("slot_time", { ascending: true });

  if (error) {
    return (
      <AdminShell role="vendor" title="재고 캘린더">
        <ErrorState
          code="VENDOR_SLOT_LOAD_FAILED"
          title="재고를 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }

  const slotsByDate: Record<string, DaySlot[]> = {};
  for (const slot of slots ?? []) {
    const list = slotsByDate[slot.slot_date] ?? [];
    list.push({
      id: slot.id,
      time: slot.slot_time ?? "00:00:00",
      capacity: slot.capacity,
      remaining: slot.remaining,
      status: slot.status as SlotStatus,
    });
    slotsByDate[slot.slot_date] = list;
  }

  // 상담 가능 시간대는 초기값 제안으로만 쓴다(위 주석 참조).
  const { data: availabilityRows } = await supabase
    .from("vendor_availability")
    .select("weekday, start_time, end_time, slot_minutes")
    .eq("vendor_id", vendor.id)
    .order("weekday", { ascending: true });

  const availability: AvailabilityHint[] = (availabilityRows ?? []).map((row) => ({
    weekday: row.weekday,
    startTime: row.start_time,
    endTime: row.end_time,
    slotMinutes: row.slot_minutes,
  }));

  const total = slots?.length ?? 0;
  const blocked = (slots ?? []).filter((slot) => slot.status === "blocked").length;

  return (
    <AdminShell
      role="vendor"
      title="재고 캘린더"
      description={`${month} · 슬롯 ${total}개 · 막힘 ${blocked}개`}
      action={
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link href={`/vendor/inventory?month=${shiftMonth(month, -1)}`}>이전 달</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href={`/vendor/inventory?month=${shiftMonth(month, 1)}`}>다음 달</Link>
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">예약 가능한 날짜</CardTitle>
            <CardDescription>
              정원은 업체가 정하는 총량이고, 잔여는 예약이 들어오면 줄어듭니다. 예약 연동은
              4단계에서 붙습니다.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {total === 0 ? (
              <div className="space-y-6">
                <EmptyState
                  assetId="vendor.dashboard.empty"
                  title="이 달에 등록된 슬롯이 없어요"
                  description="오른쪽에서 반복 규칙이나 CSV 로 한 번에 등록할 수 있습니다."
                />
                <InventoryManager month={month} slotsByDate={slotsByDate} availability={availability} />
              </div>
            ) : (
              <InventoryManager month={month} slotsByDate={slotsByDate} availability={availability} />
            )}
          </CardContent>
        </Card>
      </div>
    </AdminShell>
  );
}

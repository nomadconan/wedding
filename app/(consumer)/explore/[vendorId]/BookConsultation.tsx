"use client";

import { CalendarClock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { formatKrw } from "@/components/domain/PriceDisplay";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  CONSULTATION_TYPES,
  DEPOSIT_NOTICE,
  NO_AVAILABILITY_NOTE,
  TYPE_DESCRIPTION,
  TYPE_LABEL,
  isBookableSlot,
  requiresDeposit,
  type ConsultationType,
  type Slot,
} from "@/lib/core/consultation/consultation";

/**
 * 상담·탐방 신청 (F-C-29 진입점, `/explore/[vendorId]`)
 *
 * **업체가 등록한 시간대에서만 고른다.** 자유 입력 칸을 두지 않는다 — 아무 시각이나
 * 적어 보내면 업체가 자리를 비워 둘 수 없고, 서버도 그 요청을 거절하므로 화면에
 * 그런 입력을 만들 이유가 없다.
 *
 * **보증금이 붙는 유형인지 고르는 즉시 알려준다.** 결제 화면에서 처음 알게 되면
 * 그것은 안내가 아니라 통보다.
 */
type SlotPayload = {
  slots: Slot[];
  hasAvailability: boolean;
  deposit: { depositAmount: number | null; currency: string };
};

export function BookConsultation({ vendorId }: { vendorId: string }) {
  const router = useRouter();
  const [type, setType] = useState<ConsultationType>("visit_consult");
  const [date, setDate] = useState("");
  const [payload, setPayload] = useState<SlotPayload | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSlots = useCallback(async () => {
    if (date === "") return;

    setPending(true);
    setError(null);
    setSelected(null);

    try {
      const response = await fetch(
        `/api/consultations?vendorId=${encodeURIComponent(vendorId)}&date=${encodeURIComponent(date)}`,
      );
      const body = await response.json();

      if (!response.ok || !body.ok) {
        setError(body.error?.message ?? "시간을 불러오지 못했어요.");

        return;
      }

      setPayload(body.data as SlotPayload);
    } catch {
      setError("시간을 불러오지 못했어요.");
    } finally {
      setPending(false);
    }
  }, [date, vendorId]);

  useEffect(() => {
    void loadSlots();
  }, [loadSlots]);

  async function submit() {
    if (selected === null) return;

    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/consultations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          vendorId,
          type,
          scheduledAt: selected,
          location: null,
        }),
      });
      const body = await response.json();

      if (response.status === 401) {
        router.push(`/login?next=${encodeURIComponent(`/explore/${vendorId}`)}`);

        return;
      }

      if (!response.ok || !body.ok) {
        setError(body.error?.message ?? "신청하지 못했어요.");

        return;
      }

      router.push("/consultations");
    } catch {
      setError("신청하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  const now = new Date();
  const bookable = (payload?.slots ?? []).filter((slot) => isBookableSlot(slot, now));
  const depositAmount = payload?.deposit?.depositAmount ?? null;

  return (
    <section
      id="book"
      className="scroll-mt-16 space-y-3 rounded-lg border border-border p-4"
      data-testid="book-consultation"
    >
      <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <CalendarClock aria-hidden="true" className="h-4 w-4" />
        상담·탐방 예약
      </p>

      <div className="space-y-1.5">
        <Label htmlFor="consult-type">유형</Label>
        <select
          id="consult-type"
          value={type}
          onChange={(event) => setType(event.target.value as ConsultationType)}
          className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          {CONSULTATION_TYPES.map((option) => (
            <option key={option} value={option}>
              {TYPE_LABEL[option]}
            </option>
          ))}
        </select>
        <p className="text-caption text-muted-foreground">{TYPE_DESCRIPTION[type]}</p>
      </div>

      {requiresDeposit(type) ? (
        <p className="rounded-md bg-secondary/60 p-2.5 text-caption text-muted-foreground" data-testid="deposit-notice">
          {depositAmount === null
            ? "보증금 금액이 설정되지 않아 지금은 보증금 없이 예약할 수 있어요."
            : `보증금 ${formatKrw(depositAmount)}. `}
          {depositAmount === null ? "" : DEPOSIT_NOTICE}
        </p>
      ) : (
        <p className="text-caption text-muted-foreground">이 유형은 보증금이 없어요.</p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="consult-date">날짜</Label>
        <input
          id="consult-date"
          type="date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
          className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
        />
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {payload !== null && !payload.hasAvailability ? (
        <p className="text-caption text-muted-foreground">{NO_AVAILABILITY_NOTE}</p>
      ) : null}

      {payload !== null && payload.hasAvailability ? (
        bookable.length === 0 ? (
          <p className="text-caption text-muted-foreground">
            그날은 예약할 수 있는 시간이 없어요. 다른 날짜를 골라 보세요.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5" data-testid="slot-list">
            {bookable.map((slot) => (
              <Button
                key={slot.startsAt}
                type="button"
                size="sm"
                variant={selected === slot.startsAt ? "default" : "outline"}
                onClick={() => setSelected(slot.startsAt)}
                data-testid="slot"
              >
                {formatTime(slot.startsAt)}
              </Button>
            ))}
          </div>
        )
      ) : null}

      <Button
        type="button"
        size="touch"
        disabled={pending || selected === null}
        onClick={() => void submit()}
        data-testid="submit-consultation"
      >
        {pending ? "처리 중" : "이 시간으로 신청"}
      </Button>

      <p className="text-caption text-muted-foreground">
        신청 후 업체가 승인하면 확정돼요. 승인 전에는 자리가 잡히지 않아요.
      </p>
    </section>
  );
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" }).format(
    new Date(iso),
  );
}

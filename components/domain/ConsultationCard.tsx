"use client";

import { CalendarClock } from "lucide-react";
import { useState } from "react";

import { formatKrw } from "@/components/domain/PriceDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  CALENDAR_SYNC_PENDING,
  CONFIRM_CHOICES,
  CONFIRM_ONCE_NOTE,
  CONFIRM_PROMPT,
  COUPLE_CHOICE_LABEL,
  DEPOSIT_STATUS_LABEL,
  DISPUTE_QUEUE_NOTE,
  OUTCOME_LABEL,
  PLANNER_SHARE_PENDING,
  STATUS_LABEL,
  STATUS_NOTE,
  TYPE_LABEL,
  VENDOR_CHOICE_LABEL,
  type ConsultationOutcome,
  type ConsultationStatus,
  type ConsultationType,
  type DepositStatus,
} from "@/lib/core/consultation/consultation";
import type { ConsultationView } from "@/lib/core/schemas/consultation";
import { cn } from "@/lib/utils";

/**
 * 예약 카드 (F-C-29 · F-V-17)
 *
 * 소비자 화면(375px)과 업체 화면(데스크톱)이 **같은 컴포넌트**를 쓴다. 상태 표기와
 * 이행 확인의 규칙은 두 화면에서 같아야 하고, 나누면 한쪽만 고쳐진다.
 *
 * **이행 확인은 한 번만.** 0025 트리거가 DB 에서도 막지만, 화면이 먼저 그 사실을
 * 말해 준다 — 상대 답을 보고 말을 바꿀 수 있으면 대조가 의미를 잃는다.
 */
export type ConsultationCardProps = {
  consultation: ConsultationView;
  /** 이 화면이 서 있는 편. 서버가 판정해 내려준다. */
  side: "couple" | "vendor";
  pending: boolean;
  onConfirm?: (outcome: ConsultationOutcome) => void;
  /** 소비자: 취소 · 보증금 결제. 업체: 승인 · 거절. */
  actions?: React.ReactNode;
  className?: string;
};

export function ConsultationCard({
  consultation,
  side,
  pending,
  onConfirm,
  actions,
  className,
}: ConsultationCardProps) {
  const [choice, setChoice] = useState<ConsultationOutcome>("fulfilled");

  const status = consultation.status as ConsultationStatus;
  const mine = side === "couple" ? consultation.coupleOutcome : consultation.vendorOutcome;
  const labels = side === "couple" ? COUPLE_CHOICE_LABEL : VENDOR_CHOICE_LABEL;

  // 예정 시각이 지났고 확정 상태이며 아직 내가 답하지 않았을 때만 묻는다.
  const canConfirm =
    onConfirm !== undefined &&
    status === "confirmed" &&
    mine === null &&
    new Date(consultation.scheduledAt).getTime() <= Date.now();

  return (
    <article
      className={cn("rounded-lg border border-border p-4", className)}
      data-testid="consultation-card"
      data-status={status}
      data-type={consultation.type}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <CalendarClock aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span className="truncate">
              {side === "couple" ? consultation.vendorName : TYPE_LABEL[consultation.type as ConsultationType]}
            </span>
          </p>
          <p className="mt-0.5 text-caption text-muted-foreground">
            {formatWhen(consultation.scheduledAt)} · {consultation.durationMinutes}분
            {side === "couple"
              ? ` · ${TYPE_LABEL[consultation.type as ConsultationType]}`
              : ""}
          </p>
        </div>

        <Badge variant={badgeVariant(status)}>{STATUS_LABEL[status] ?? status}</Badge>
      </div>

      <p className="mt-2 text-caption text-muted-foreground">{STATUS_NOTE[status]}</p>

      {consultation.location ? (
        <p className="mt-1 text-caption text-muted-foreground">장소: {consultation.location}</p>
      ) : null}

      {consultation.rejectReason ? (
        <p className="mt-1 text-caption text-muted-foreground">
          사유: {consultation.rejectReason}
        </p>
      ) : null}

      {/* ── 보증금 ─────────────────────────────────────────────────────────── */}
      {consultation.deposit ? (
        <p className="mt-2 text-caption text-muted-foreground" data-testid="deposit-state">
          보증금 {formatKrw(consultation.deposit.amount)} ·{" "}
          {DEPOSIT_STATUS_LABEL[consultation.deposit.status as DepositStatus] ??
            consultation.deposit.status}
        </p>
      ) : null}

      {/* ── 이행 확인 (§3.11) ──────────────────────────────────────────────── */}
      {canConfirm ? (
        <div className="mt-3 space-y-2 rounded-md bg-secondary/50 p-3" data-testid="confirm-panel">
          <p className="text-sm font-medium text-foreground">{CONFIRM_PROMPT}</p>

          <div className="space-y-1.5">
            <Label htmlFor={`confirm-${consultation.id}`} className="sr-only">
              이행 확인
            </Label>
            <select
              id={`confirm-${consultation.id}`}
              value={choice}
              onChange={(event) => setChoice(event.target.value as ConsultationOutcome)}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {CONFIRM_CHOICES.map((option) => (
                <option key={option} value={option}>
                  {labels[option]}
                </option>
              ))}
            </select>
          </div>

          <p className="text-caption text-muted-foreground">{CONFIRM_ONCE_NOTE}</p>

          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={() => onConfirm?.(choice)}
            data-testid="submit-confirm"
          >
            제출
          </Button>
        </div>
      ) : null}

      {mine !== null && status === "confirmed" ? (
        <p className="mt-2 text-caption text-muted-foreground" data-testid="my-confirm">
          내 확인: {OUTCOME_LABEL[mine as ConsultationOutcome] ?? mine} · 상대 응답을 기다리고 있어요.
        </p>
      ) : null}

      {status === "disputed" ? (
        <p className="mt-2 text-caption text-warning-foreground" data-testid="dispute-note">
          {DISPUTE_QUEUE_NOTE}
        </p>
      ) : null}

      {consultation.outcome && status !== "confirmed" ? (
        <p className="mt-1 text-caption text-muted-foreground">
          판정: {OUTCOME_LABEL[consultation.outcome as ConsultationOutcome] ?? consultation.outcome}
        </p>
      ) : null}

      {/* ── 3자 공유·캘린더 — 아직 못 채우는 자리를 그대로 밝힌다 ─────────── */}
      {status === "confirmed" && side === "couple" ? (
        <div className="mt-2 flex flex-wrap gap-1.5" data-testid="consultation-pending">
          <Badge variant="outline">
            {PLANNER_SHARE_PENDING.label} — {PLANNER_SHARE_PENDING.filledBy}
          </Badge>
          <Badge variant="outline">
            {CALENDAR_SYNC_PENDING.label} — {CALENDAR_SYNC_PENDING.filledBy}
          </Badge>
        </div>
      ) : null}

      {actions ? <div className="mt-3 flex flex-wrap gap-2">{actions}</div> : null}
    </article>
  );
}

function badgeVariant(status: ConsultationStatus) {
  if (status === "confirmed" || status === "completed") return "default" as const;
  if (status === "requested" || status === "approved") return "outline" as const;

  return "secondary" as const;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

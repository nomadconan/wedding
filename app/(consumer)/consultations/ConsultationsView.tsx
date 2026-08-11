"use client";

import Link from "next/link";
import { useCallback, useState } from "react";

import { ConsultationCard } from "@/components/domain/ConsultationCard";
import { formatKrw } from "@/components/domain/PriceDisplay";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  CONSULTATIONS_EMPTY_DESCRIPTION,
  CONSULTATIONS_EMPTY_TITLE,
  DEPOSIT_NOTICE,
  FREE_CANCEL_UNSET_NOTE,
  freeCancelDeadline,
  isFreeCancel,
  isLive,
  type ConsultationOutcome,
  type ConsultationStatus,
} from "@/lib/core/consultation/consultation";
import type { ConsultationSettings } from "@/lib/consultation/loader";
import type { ConsultationView } from "@/lib/core/schemas/consultation";

const ENDPOINT = "/api/consultations";

/**
 * 상담·탐방 (F-C-29, §6.2 `/consultations`)
 *
 * **취소가 무료인지 화면이 미리 알려준다.** 누르고 나서 "몰취되었습니다" 를 보는
 * 것과 누르기 전에 "지금 취소하면 보증금이 몰취돼요" 를 보는 것은 다르다 —
 * 판정은 서버가 하지만 그 결과를 예고하는 것은 화면의 일이다.
 */
export function ConsultationsView({
  initialConsultations,
  settings,
}: {
  initialConsultations: ConsultationView[];
  settings: ConsultationSettings;
}) {
  const [consultations, setConsultations] = useState(initialConsultations);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = new Date();

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(ENDPOINT);
      const payload = await response.json();

      if (response.ok && payload.ok) {
        setConsultations(payload.data.consultations as ConsultationView[]);
      }
    } catch {
      // 목록은 이미 그려져 있다.
    }
  }, []);

  async function call(body: unknown, key: string, path = ENDPOINT, method = "POST") {
    setPending(key);
    setError(null);

    try {
      const response = await fetch(path, {
        method,
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
      setPending(null);
    }
  }

  if (consultations.length === 0) {
    return (
      <EmptyState
        assetId="explore.empty"
        title={CONSULTATIONS_EMPTY_TITLE}
        description={CONSULTATIONS_EMPTY_DESCRIPTION}
        action={
          <Link href="/explore" className="text-sm font-medium text-brand-600">
            업체 둘러보기
          </Link>
        }
      />
    );
  }

  const live = consultations.filter((item) => isLive(item.status as ConsultationStatus));
  const past = consultations.filter((item) => !isLive(item.status as ConsultationStatus));

  return (
    <div className="space-y-4" data-testid="consultations">
      {/* 보증금이 무엇인지 상시로 밝힌다(D-24 — 플랫폼은 판정자가 아니다). */}
      <p className="rounded-lg bg-secondary/50 p-3 text-caption text-muted-foreground">
        {DEPOSIT_NOTICE}
      </p>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {[
        { key: "live", label: "예정된 일정", items: live },
        { key: "past", label: "지난 일정", items: past },
      ]
        .filter((group) => group.items.length > 0)
        .map((group) => (
          <section key={group.key} className="space-y-2" data-testid={`consultations-${group.key}`}>
            <h2 className="text-base font-semibold text-foreground">{group.label}</h2>

            {group.items.map((consultation) => {
              const free = isFreeCancel(
                consultation.scheduledAt,
                now,
                settings.freeCancelHours,
              );
              const deadline = freeCancelDeadline(
                consultation.scheduledAt,
                settings.freeCancelHours,
              );

              return (
                <ConsultationCard
                  key={consultation.id}
                  consultation={consultation}
                  side="couple"
                  pending={pending === consultation.id}
                  onConfirm={(outcome: ConsultationOutcome) =>
                    void call(
                      { outcome },
                      consultation.id,
                      `${ENDPOINT}/${consultation.id}/confirm`,
                    )
                  }
                  actions={
                    <>
                      {consultation.status === "approved" ? (
                        <Button
                          type="button"
                          size="sm"
                          disabled={pending === consultation.id}
                          onClick={() =>
                            void call(
                              {
                                action: "pay_deposit",
                                consultationId: consultation.id,
                                // 멱등 열쇠는 클라이언트가 만든다(CLAUDE.md §6).
                                // 같은 예약에 같은 열쇠라 두 번 눌러도 한 번만 결제된다.
                                idempotencyKey: `deposit-${consultation.id}`,
                              },
                              consultation.id,
                            )
                          }
                          data-testid="pay-deposit"
                        >
                          {settings.depositAmount
                            ? `보증금 ${formatKrw(settings.depositAmount)} 결제하고 확정`
                            : "확정하기"}
                        </Button>
                      ) : null}

                      {isLive(consultation.status as ConsultationStatus) ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={pending === consultation.id}
                          onClick={() => {
                            const message = free
                              ? "이 예약을 취소할까요? 보증금이 있다면 전액 환불돼요."
                              : "무료 취소 기한이 지났어요. 지금 취소하면 보증금은 업체에 지급돼요. 계속할까요?";

                            if (window.confirm(message)) {
                              void call(
                                {
                                  action: "cancel",
                                  consultationId: consultation.id,
                                  reason: null,
                                },
                                consultation.id,
                              );
                            }
                          }}
                          data-testid="cancel-consultation"
                        >
                          취소
                        </Button>
                      ) : null}
                    </>
                  }
                >
                </ConsultationCard>
              );
            })}

            {group.key === "live" ? (
              <p className="text-caption text-muted-foreground" data-testid="cancel-policy">
                {settings.freeCancelHours === null
                  ? FREE_CANCEL_UNSET_NOTE
                  : `예정 시각 ${settings.freeCancelHours}시간 전까지 취소하면 보증금을 전액 돌려드려요.`}
              </p>
            ) : null}
          </section>
        ))}
    </div>
  );
}

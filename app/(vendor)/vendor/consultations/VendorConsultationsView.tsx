"use client";

import { useCallback, useState } from "react";

import { ConsultationCard } from "@/components/domain/ConsultationCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Label } from "@/components/ui/label";
import {
  VENDOR_CONSULTATIONS_EMPTY_DESCRIPTION,
  VENDOR_CONSULTATIONS_EMPTY_TITLE,
  isLive,
  type ConsultationOutcome,
  type ConsultationStatus,
} from "@/lib/core/consultation/consultation";
import type { ConsultationSettings } from "@/lib/consultation/loader";
import type { ConsultationView } from "@/lib/core/schemas/consultation";

const ENDPOINT = "/api/vendor/consultations";

/**
 * 업체 상담 일정 (F-V-17, §6.3 `/vendor/consultations`)
 *
 * **승인 대기가 위다.** 고객이 기다리는 상태이고, 승인이 늦으면 다른 업체로 간다.
 *
 * **노쇼 신고 버튼을 따로 두지 않는다.** 이행 확인에서 '고객이 오지 않았어요' 를
 * 고르는 것이 곧 노쇼 신고다 — 별도 버튼을 두면 업체의 일방 주장이 양측 대조를
 * 건너뛰는 것처럼 보이고, 실제로 §3.11 은 그것을 허용하지 않는다.
 */
export function VendorConsultationsView({
  initialConsultations,
  settings,
}: {
  initialConsultations: ConsultationView[];
  settings: ConsultationSettings;
}) {
  const [consultations, setConsultations] = useState(initialConsultations);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

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

  async function call(body: unknown, key: string) {
    setPending(key);
    setError(null);

    try {
      const response = await fetch(ENDPOINT, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "처리하지 못했어요.");

        return;
      }

      setRejectFor(null);
      setRejectReason("");
      await refresh();
    } catch {
      setError("처리하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(null);
    }
  }

  if (consultations.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6">
          <EmptyState
            assetId="vendor.dashboard.empty"
            title={VENDOR_CONSULTATIONS_EMPTY_TITLE}
            description={VENDOR_CONSULTATIONS_EMPTY_DESCRIPTION}
          />
        </CardContent>
      </Card>
    );
  }

  // 승인 대기 → 확정·진행 중 → 지난 것.
  const waiting = consultations.filter((item) => item.status === "requested");
  const live = consultations.filter(
    (item) => item.status !== "requested" && isLive(item.status as ConsultationStatus),
  );
  const past = consultations.filter((item) => !isLive(item.status as ConsultationStatus));

  return (
    <div className="space-y-4" data-testid="vendor-consultations">
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {[
        { key: "waiting", label: "승인 대기", items: waiting },
        { key: "live", label: "확정·진행 중", items: live },
        { key: "past", label: "지난 일정", items: past },
      ]
        .filter((group) => group.items.length > 0)
        .map((group) => (
          <section
            key={group.key}
            className="space-y-2"
            data-testid={`vendor-consultations-${group.key}`}
          >
            <h2 className="text-base font-semibold text-foreground">{group.label}</h2>

            {group.items.map((consultation) => (
              <ConsultationCard
                key={consultation.id}
                consultation={consultation}
                side="vendor"
                pending={pending === consultation.id}
                onConfirm={(outcome: ConsultationOutcome) =>
                  void call(
                    { action: "confirm", consultationId: consultation.id, outcome },
                    consultation.id,
                  )
                }
                actions={
                  consultation.status === "requested" ? (
                    rejectFor === consultation.id ? (
                      <div className="w-full space-y-2">
                        <Label htmlFor={`reject-${consultation.id}`}>거절 사유</Label>
                        <input
                          id={`reject-${consultation.id}`}
                          value={rejectReason}
                          maxLength={300}
                          placeholder="예: 그날은 이미 예약이 찼어요"
                          onChange={(event) => setRejectReason(event.target.value)}
                          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                        />
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={pending === consultation.id || rejectReason.trim().length < 2}
                            onClick={() =>
                              void call(
                                {
                                  action: "reject",
                                  consultationId: consultation.id,
                                  reason: rejectReason.trim(),
                                },
                                consultation.id,
                              )
                            }
                            data-testid="reject-consultation"
                          >
                            거절 보내기
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setRejectFor(null)}
                          >
                            그만두기
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          disabled={pending === consultation.id}
                          onClick={() =>
                            void call(
                              { action: "approve", consultationId: consultation.id },
                              consultation.id,
                            )
                          }
                          data-testid="approve-consultation"
                        >
                          승인
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setRejectFor(consultation.id)}
                        >
                          거절
                        </Button>
                      </>
                    )
                  ) : null
                }
              />
            ))}
          </section>
        ))}

      <p className="text-caption text-muted-foreground">
        {settings.confirmDueHours === null
          ? "이행 확인 응답 기한이 설정되지 않아 자동 판정이 돌지 않아요."
          : `예정 시각이 지나면 양측에 이행 확인을 요청하고, ${settings.confirmDueHours}시간 안에 답이 없으면 규칙에 따라 처리돼요.`}
      </p>
    </div>
  );
}

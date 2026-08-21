"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  GUEST_PARTY_SIZE_MAX,
  INVITE_SHARE_NOTICE,
  RSVP_STATUS_LABEL,
  type GuestAnswer,
  type RsvpStatus,
} from "@/lib/core/guest/guest";

/**
 * `/rsvp/[token]` 응답 폼 (F-C-22)
 *
 * ── 이름을 고칠 수 없다 ─────────────────────────────────────────────────────
 * 이름 입력 칸이 없다. 링크를 받은 사람은 **참석 여부와 인원만** 답한다 — 이름을
 * 고칠 수 있으면 명단의 주인(커플)이 적어 둔 것이 링크를 가진 사람에 의해 바뀐다.
 * DB 함수도 세 칸만 쓴다(0051).
 *
 * ── 이미 답한 뒤에도 열린다 ─────────────────────────────────────────────────
 * 사정이 바뀌는 것이 정상이고, 예식일까지는 고칠 수 있어야 한다. 다만 **지금 무엇으로
 * 되어 있는지**를 먼저 보여준다 — 안 보이면 같은 답을 또 누른다.
 */
export function RsvpForm({
  guestName,
  weddingDate,
  initialStatus,
  initialPartySize,
  closed,
}: {
  guestName: string;
  weddingDate: string | null;
  initialStatus: RsvpStatus;
  initialPartySize: number;
  closed: boolean;
}) {
  const [status, setStatus] = useState<RsvpStatus>(initialStatus);
  const [partySize, setPartySize] = useState(String(initialPartySize));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function answer(choice: GuestAnswer) {
    setBusy(true);
    setNotice(null);

    try {
      const response = await fetch(`${window.location.pathname.replace("/rsvp/", "/api/rsvp/")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: choice, partySize: Number(partySize) || 1 }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };

      if (!payload.ok) {
        setNotice(payload.error?.message ?? "응답을 저장하지 못했어요.");
        return;
      }

      setStatus(choice);
      setDone(true);
    } finally {
      setBusy(false);
    }
  }

  if (closed) {
    return (
      <div className="space-y-2 rounded-lg border border-border p-4" data-testid="rsvp-closed">
        <p className="text-sm text-foreground">{guestName} 님, 초대해 주셔서 감사합니다.</p>
        <p className="text-caption text-muted-foreground">
          예식일이 지나 더 이상 응답을 받지 않아요.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="rsvp-form">
      <section className="space-y-1">
        <p className="text-lg font-semibold text-foreground">{guestName} 님</p>
        {weddingDate === null ? null : (
          <p className="text-caption text-muted-foreground">{weddingDate.slice(0, 10)} 예식</p>
        )}
        {/* **지금 무엇으로 되어 있는지 먼저 보인다.** 안 보이면 같은 답을 또 누른다. */}
        <div className="pt-1">
          <Badge variant={status === "attending" ? "default" : "outline"}>
            현재 {RSVP_STATUS_LABEL[status]}
          </Badge>
        </div>
      </section>

      <section className="space-y-2">
        <label className="block text-sm text-foreground" htmlFor="rsvp-party">
          함께 오시는 분을 포함한 인원
        </label>
        <input
          id="rsvp-party"
          value={partySize}
          onChange={(event) => setPartySize(event.target.value)}
          inputMode="numeric"
          max={GUEST_PARTY_SIZE_MAX}
          className="w-24 rounded-lg border border-border bg-background p-2 text-sm text-foreground"
          data-testid="rsvp-party-size"
        />

        <div className="flex gap-2">
          <Button disabled={busy} onClick={() => answer("attending")} data-testid="rsvp-attending">
            참석합니다
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => answer("declined")}
            data-testid="rsvp-declined"
          >
            어렵습니다
          </Button>
        </div>
      </section>

      {done ? (
        <p className="text-sm text-foreground" data-testid="rsvp-done">
          답변 감사합니다. 예식일 전까지 이 링크에서 언제든 바꾸실 수 있어요.
        </p>
      ) : null}

      {notice === null ? null : (
        <p className="text-sm text-destructive" data-testid="rsvp-notice">
          {notice}
        </p>
      )}

      <p className="text-caption text-muted-foreground">{INVITE_SHARE_NOTICE}</p>
    </div>
  );
}

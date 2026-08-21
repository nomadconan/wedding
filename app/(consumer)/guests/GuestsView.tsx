"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  GUEST_ISSUE_NOTE,
  GUEST_PRIVACY_NOTICE,
  GUEST_SIDES,
  GUEST_SIDE_LABEL,
  INVITE_SHARE_NOTICE,
  INVITE_STATE_NOTE,
  NO_ESTIMATE_NOTE,
  RSVP_STATUSES,
  RSVP_STATUS_LABEL,
  SEATING_DRAFT_NOTICE,
  SEATING_ISSUE_NOTE,
  guestIssue,
  type GuestCountGap,
  type GuestCounts,
  type GuestSide,
  type InviteState,
  type RsvpStatus,
  type SeatingIssue,
  type SeatingLayout,
} from "@/lib/core/guest/guest";

/**
 * /guests — 하객·좌석 (F-C-22 · 명세서 §6.2)
 *
 * ── 이 화면이 지키는 것 ─────────────────────────────────────────────────────
 *  1. **답례품 수량을 하나의 숫자로 말하지 않는다.** 미응답이 남아 있는 동안
 *     "몇 개 준비하세요" 는 답이 아니다 — 확정·상한·미응답 셋을 적는다.
 *  2. **0에 근거를 붙인다.** 참석 0명이 "아무도 안 온다" 인지 "아직 아무도 답하지
 *     않았다" 인지 문장으로 가른다(S7-04 가 위약금 기준에서 세운 규칙).
 *  3. **예상 하객 수가 없으면 견주지 않는다.** 0과 견주면 한 줄만 넣어도 "예상보다
 *     많다" 가 뜨는데 그건 사실이 아니라 설정이 빈 것이다.
 *  4. **누가 이름을 볼 수 있는지 적는다.** 하객은 우리 사용자가 아니다.
 *  5. **초대 링크는 예식일이 있어야 만든다.** 없으면 버튼을 열지 않고 이유를 적는다.
 *
 * 판정·문구는 전부 `lib/core/guest` 가 갖는다. 375px 에서 **좌석은 목록**이다 —
 * 도면 편집기는 이 폭에서 쓸 수 없다.
 */

export type GuestRowView = {
  id: string;
  name: string;
  side: GuestSide;
  rsvpStatus: RsvpStatus;
  partySize: number;
  hasContact: boolean;
  hasInvite: boolean;
};

export function GuestsView({
  guests,
  counts,
  favorNote,
  gap,
  invite,
  canIssueInvite,
  layout,
  issues,
  unseated,
}: {
  guests: GuestRowView[];
  counts: GuestCounts;
  favorNote: string;
  gap: GuestCountGap;
  invite: InviteState;
  canIssueInvite: boolean;
  layout: SeatingLayout;
  issues: SeatingIssue[];
  unseated: string[];
}) {
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<{ guestId: string; url: string } | null>(null);

  const [name, setName] = useState("");
  const [side, setSide] = useState<GuestSide>("unassigned");
  const [partySize, setPartySize] = useState("1");

  const draftIssue =
    name.length === 0
      ? null
      : guestIssue({ name, partySize: Number(partySize) || 0, side });

  async function call(path: string, method: string, body: unknown) {
    setBusy(true);
    setNotice(null);

    try {
      const response = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        data?: { token?: string };
        error?: { message: string };
      };

      if (!payload.ok) {
        setNotice(payload.error?.message ?? "요청을 처리하지 못했어요.");
        return null;
      }

      router.refresh();

      return payload.data ?? {};
    } finally {
      setBusy(false);
    }
  }

  async function addGuest() {
    const result = await call("/api/guests", "POST", {
      action: "create",
      name,
      side,
      partySize: Number(partySize),
    });

    if (result !== null) {
      setName("");
      setPartySize("1");
    }
  }

  async function issue(guestId: string) {
    const result = await call("/api/guests/invites", "POST", { action: "issue", guestId });

    if (result?.token) {
      setInviteLink({ guestId, url: `${window.location.origin}/rsvp/${result.token}` });
    }
  }

  const seatedIds = new Set(layout.tables.flatMap((table) => table.guestIds));
  const nameOf = (id: string) => guests.find((guest) => guest.id === id)?.name ?? "알 수 없음";

  return (
    <div className="space-y-6" data-testid="guests">
      {/* ── 집계 ─────────────────────────────────────────────────────── */}
      <section className="space-y-2 rounded-lg border border-border p-4" data-testid="guests-summary">
        <div className="flex flex-wrap gap-1.5">
          {RSVP_STATUSES.map((status) => (
            <Badge key={status} variant={status === "attending" ? "default" : "outline"}>
              {RSVP_STATUS_LABEL[status]} {counts[status]}
            </Badge>
          ))}
        </div>

        {/* **하나의 숫자로 말하지 않는다.** 확정·상한·미응답이 문장에 함께 있다. */}
        <p className="text-sm text-foreground" data-testid="guests-favor">
          {favorNote}
        </p>

        {gap.known ? (
          <p className="text-caption text-muted-foreground">
            온보딩에서 적은 예상 {gap.estimate}명 대비 {gap.diff >= 0 ? "+" : ""}
            {gap.diff}명 (최대 {gap.maxPossible}명 기준)
          </p>
        ) : (
          /* **기준이 없으면 0과 견주지 않는다.** */
          <p className="text-caption text-muted-foreground" data-testid="guests-no-estimate">
            {NO_ESTIMATE_NOTE}
          </p>
        )}
      </section>

      <p className="rounded-lg border border-border p-3 text-caption text-muted-foreground">
        {GUEST_PRIVACY_NOTICE}
      </p>

      {/* ── 명단 추가 ────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <h2 className="text-base font-semibold text-foreground">하객 추가</h2>

        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="이름"
          className="w-full rounded-lg border border-border bg-background p-2 text-sm text-foreground"
          data-testid="guest-name-input"
        />

        <div className="flex gap-2">
          <select
            value={side}
            onChange={(event) => setSide(event.target.value as GuestSide)}
            className="flex-1 rounded-lg border border-border bg-background p-2 text-sm text-foreground"
          >
            {GUEST_SIDES.map((value) => (
              <option key={value} value={value}>
                {GUEST_SIDE_LABEL[value]}
              </option>
            ))}
          </select>

          <input
            value={partySize}
            onChange={(event) => setPartySize(event.target.value)}
            inputMode="numeric"
            className="w-24 rounded-lg border border-border bg-background p-2 text-sm text-foreground"
            aria-label="동반 포함 인원"
          />
        </div>

        {draftIssue === null ? null : (
          <p className="text-caption text-muted-foreground">{GUEST_ISSUE_NOTE[draftIssue]}</p>
        )}

        <Button disabled={busy || name.length === 0 || draftIssue !== null} onClick={addGuest}>
          추가하기
        </Button>
      </section>

      {/* ── 명단 ─────────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <h2 className="text-base font-semibold text-foreground">명단 {counts.entries}줄</h2>
        <p className="text-caption text-muted-foreground">{INVITE_STATE_NOTE[invite]}</p>

        {guests.length === 0 ? (
          <p className="rounded-lg border border-border p-3 text-sm text-muted-foreground">
            아직 하객을 추가하지 않았어요.
          </p>
        ) : (
          <ul className="space-y-2" data-testid="guest-list">
            {guests.map((guest) => (
              <li
                key={guest.id}
                className="space-y-2 rounded-lg border border-border p-3"
                data-testid={`guest-${guest.id}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{guest.name}</span>
                  <Badge variant={guest.rsvpStatus === "attending" ? "default" : "outline"}>
                    {RSVP_STATUS_LABEL[guest.rsvpStatus]}
                  </Badge>
                </div>

                <p className="text-caption text-muted-foreground">
                  {GUEST_SIDE_LABEL[guest.side]} · {guest.partySize}명
                  {guest.hasContact ? " · 연락처 있음" : ""}
                </p>

                <div className="flex flex-wrap gap-2">
                  {RSVP_STATUSES.filter((status) => status !== guest.rsvpStatus).map((status) => (
                    <Button
                      key={status}
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        call("/api/guests", "POST", {
                          action: "update",
                          guestId: guest.id,
                          rsvpStatus: status,
                        })
                      }
                    >
                      {RSVP_STATUS_LABEL[status]}로
                    </Button>
                  ))}

                  {/* **예식일이 없으면 버튼을 열지 않는다.** */}
                  {canIssueInvite ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => issue(guest.id)}
                      data-testid={`guest-invite-${guest.id}`}
                    >
                      {guest.hasInvite ? "링크 다시 보기" : "초대 링크"}
                    </Button>
                  ) : null}

                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      call("/api/guests", "POST", { action: "delete", guestId: guest.id })
                    }
                  >
                    삭제
                  </Button>
                </div>

                {inviteLink?.guestId === guest.id ? (
                  <div className="space-y-1" data-testid="guest-invite-link">
                    <p className="break-all rounded border border-border bg-muted/40 p-2 text-caption text-foreground">
                      {inviteLink.url}
                    </p>
                    <p className="text-caption text-muted-foreground">{INVITE_SHARE_NOTICE}</p>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── 좌석 초안 ────────────────────────────────────────────────── */}
      <section className="space-y-2" data-testid="guests-seating">
        <h2 className="text-base font-semibold text-foreground">좌석 초안</h2>
        <p className="text-caption text-muted-foreground">{SEATING_DRAFT_NOTICE}</p>

        {issues.length > 0 ? (
          <ul className="space-y-1" data-testid="seating-issues">
            {issues.map((issue, index) => (
              <li key={index} className="text-caption text-warning-foreground">
                {SEATING_ISSUE_NOTE[issue.code]}
                {issue.code === "over_capacity"
                  ? ` (${issue.tableId}: ${issue.assigned}/${issue.capacity})`
                  : ""}
              </li>
            ))}
          </ul>
        ) : null}

        {layout.tables.length === 0 ? (
          <p className="rounded-lg border border-border p-3 text-sm text-muted-foreground">
            아직 테이블을 만들지 않았어요. 명단이 모이면 테이블을 나눠 보세요.
          </p>
        ) : (
          <ul className="space-y-2">
            {layout.tables.map((table) => (
              <li key={table.id} className="space-y-1 rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{table.name}</span>
                  <span className="text-caption text-muted-foreground">
                    {table.guestIds.length}
                    {table.capacity > 0 ? ` / ${table.capacity}` : ""}
                  </span>
                </div>
                <p className="text-caption text-muted-foreground">
                  {table.guestIds.length === 0
                    ? "비어 있어요."
                    : table.guestIds.map(nameOf).join(" · ")}
                </p>
              </li>
            ))}
          </ul>
        )}

        <SeatingEditor
          guests={guests}
          layout={layout}
          busy={busy}
          onSave={(tables) => call("/api/guests/seating", "PUT", { tables })}
        />

        {unseated.length > 0 ? (
          <p className="text-caption text-muted-foreground" data-testid="seating-unseated">
            아직 자리를 못 정한 분 {unseated.length}명 ·{" "}
            {unseated.map(nameOf).slice(0, 5).join(" · ")}
            {unseated.length > 5 ? " 외" : ""}
          </p>
        ) : null}
      </section>

      {notice === null ? null : (
        <p className="text-sm text-destructive" data-testid="guests-notice">
          {notice}
        </p>
      )}
    </div>
  );
}

/**
 * 테이블을 만들고 하객을 옮긴다.
 *
 * **드래그가 아니라 고르기다.** 375px 에서 드래그 배치는 손가락으로 정확히 집을 수
 * 없고, 우리가 답해야 하는 물음은 "누구를 같은 테이블에 앉힐 것인가" 이지 "어디에
 * 놓을 것인가" 가 아니다.
 */
function SeatingEditor({
  guests,
  layout,
  busy,
  onSave,
}: {
  guests: GuestRowView[];
  layout: SeatingLayout;
  busy: boolean;
  onSave: (tables: SeatingLayout["tables"]) => void;
}) {
  const [tableName, setTableName] = useState("");
  const [capacity, setCapacity] = useState("10");
  const [target, setTarget] = useState("");
  const [guestId, setGuestId] = useState("");

  const addTable = () => {
    if (tableName.trim().length === 0) return;

    onSave([
      ...layout.tables,
      {
        // 브라우저가 만드는 id 다 — 서버가 정할 값이 아니다(배치는 사용자의 문서다).
        id: crypto.randomUUID(),
        name: tableName.trim(),
        capacity: Number(capacity) || 0,
        guestIds: [],
      },
    ]);
    setTableName("");
  };

  const assign = () => {
    if (target.length === 0 || guestId.length === 0) return;

    onSave(
      layout.tables.map((table) => ({
        ...table,
        // **먼저 어디서든 빼고 넣는다.** 안 그러면 같은 사람이 두 테이블에 앉는다.
        guestIds:
          table.id === target
            ? [...table.guestIds.filter((id) => id !== guestId), guestId]
            : table.guestIds.filter((id) => id !== guestId),
      })),
    );
    setGuestId("");
  };

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex gap-2">
        <input
          value={tableName}
          onChange={(event) => setTableName(event.target.value)}
          placeholder="테이블 이름"
          className="flex-1 rounded-lg border border-border bg-background p-2 text-sm text-foreground"
          data-testid="seating-table-name"
        />
        <input
          value={capacity}
          onChange={(event) => setCapacity(event.target.value)}
          inputMode="numeric"
          className="w-20 rounded-lg border border-border bg-background p-2 text-sm text-foreground"
          aria-label="정원"
        />
        <Button variant="outline" disabled={busy || tableName.trim().length === 0} onClick={addTable}>
          추가
        </Button>
      </div>

      {layout.tables.length > 0 && guests.length > 0 ? (
        <div className="flex gap-2">
          <select
            value={guestId}
            onChange={(event) => setGuestId(event.target.value)}
            className="flex-1 rounded-lg border border-border bg-background p-2 text-sm text-foreground"
            aria-label="하객"
          >
            <option value="">하객 고르기</option>
            {guests.map((guest) => (
              <option key={guest.id} value={guest.id}>
                {guest.name}
              </option>
            ))}
          </select>

          <select
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            className="flex-1 rounded-lg border border-border bg-background p-2 text-sm text-foreground"
            aria-label="테이블"
          >
            <option value="">테이블 고르기</option>
            {layout.tables.map((table) => (
              <option key={table.id} value={table.id}>
                {table.name}
              </option>
            ))}
          </select>

          <Button
            variant="outline"
            disabled={busy || guestId.length === 0 || target.length === 0}
            onClick={assign}
            data-testid="seating-assign"
          >
            배정
          </Button>
        </div>
      ) : null}
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  DELETION_CANCEL_BLOCKED_NOTE,
  DELETION_RETAINED_ITEMS,
  DELETION_RETAINED_NOTICE,
  DELETION_SCOPES,
  DELETION_SCOPE_LABEL,
  DELETION_SCOPE_NOTE,
  DELETION_STATUS_LABEL,
  PHONE_STATE_TEXT,
  UNLINK_KEEPS_NOTICE,
  canCancelRequest,
  type DeletionScope,
  type DeletionStatus,
} from "@/lib/core/schemas/me";

/**
 * 마이페이지 폼 (F-C-23, §6.2 `/me`)
 *
 * **되돌릴 수 없는 행동을 한 화면에 모아 둔 곳**이다. 그래서 각 버튼 옆에는 그것이
 * 무엇을 없애고 무엇을 남기는지가 함께 있다 — 눌러 본 뒤에 알게 되면 늦다.
 */
export type MeFormsProps = {
  profile: { displayName: string; email: string | null; phoneRegistered: boolean; marketingOptIn: boolean };
  couple: { role: string; memberCount: number } | null;
  openRequest: { id: string; scope: string; status: DeletionStatus; requestedAt: string } | null;
};

export function MeForms({ profile, couple, openRequest }: MeFormsProps) {
  const router = useRouter();

  const [displayName, setDisplayName] = useState(profile.displayName);
  const [phone, setPhone] = useState("");
  const [removePhone, setRemovePhone] = useState(false);
  const [marketingOptIn, setMarketingOptIn] = useState(profile.marketingOptIn);

  const [scope, setScope] = useState<DeletionScope>("account");
  const [acknowledged, setAcknowledged] = useState(false);

  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function call(path: string, init: RequestInit, key: string, done: string) {
    setPending(key);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(path, init);
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "처리하지 못했어요.");

        return;
      }

      setNotice(done);
      router.refresh();
    } catch {
      setError("처리하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-6" data-testid="me-forms">
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {notice ? <p className="text-sm text-success">{notice}</p> : null}

      {/* ── 프로필 ─────────────────────────────────────────────────────── */}
      <section className="space-y-3" data-testid="me-profile">
        <h2 className="text-base font-semibold text-foreground">내 정보</h2>

        <div className="space-y-1.5">
          <Label htmlFor="displayName">이름</Label>
          <Input
            id="displayName"
            value={displayName}
            maxLength={40}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label>이메일</Label>
          <p className="text-sm text-foreground" data-testid="me-email">
            {profile.email ?? "등록되지 않음"}
          </p>
          <p className="text-caption text-muted-foreground">
            이메일은 로그인 수단이라 여기서 바꾸지 않아요.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="phone">연락처</Label>
          {/* 해시로만 저장하므로 되돌려 보여줄 수 없다(§7.2). 등록 여부만 말한다. */}
          <p className="text-caption text-muted-foreground" data-testid="phone-state">
            {PHONE_STATE_TEXT[profile.phoneRegistered ? "registered" : "none"]}
          </p>
          <Input
            id="phone"
            inputMode="tel"
            placeholder="새 번호를 입력하면 바꿉니다"
            disabled={removePhone}
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
          {profile.phoneRegistered ? (
            <div className="flex items-center gap-2">
              <Checkbox
                id="removePhone"
                checked={removePhone}
                onCheckedChange={(checked) => {
                  setRemovePhone(checked === true);
                  if (checked === true) setPhone("");
                }}
              />
              <Label htmlFor="removePhone" className="font-normal">
                등록된 연락처 지우기
              </Label>
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="marketingOptIn"
            checked={marketingOptIn}
            onCheckedChange={(checked) => setMarketingOptIn(checked === true)}
          />
          <Label htmlFor="marketingOptIn" className="font-normal">
            마케팅 정보 수신에 동의합니다 (언제든 끌 수 있어요)
          </Label>
        </div>

        <Button
          type="button"
          disabled={pending !== null}
          onClick={() =>
            call(
              "/api/me",
              {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  displayName,
                  phone: phone.trim() === "" ? null : phone.trim(),
                  removePhone,
                  marketingOptIn,
                }),
              },
              "profile",
              "저장했어요.",
            )
          }
        >
          {pending === "profile" ? "저장 중…" : "내 정보 저장"}
        </Button>
      </section>

      <Separator />

      {/* ── 커플 연동 ──────────────────────────────────────────────────── */}
      <section className="space-y-2" data-testid="me-couple">
        <h2 className="text-base font-semibold text-foreground">커플 연동</h2>

        {couple === null ? (
          <p className="text-sm text-muted-foreground">아직 커플을 만들지 않았어요.</p>
        ) : couple.memberCount < 2 ? (
          <p className="text-sm text-muted-foreground">
            아직 배우자와 연동하지 않았어요. 온보딩 화면에서 초대 코드를 만들 수 있어요.
          </p>
        ) : (
          <>
            <p className="text-sm text-foreground">
              배우자와 연동돼 있어요 · 내 역할 {couple.role === "owner" ? "커플 생성자" : "배우자"}
            </p>
            {/* 해제가 무엇을 남기는지 버튼 옆에 둔다. */}
            <p className="text-caption text-muted-foreground" data-testid="unlink-note">
              {UNLINK_KEEPS_NOTICE}
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={pending !== null}
              data-testid="unlink-button"
              onClick={() => call("/api/me", { method: "DELETE" }, "unlink", "연동을 해제했어요.")}
            >
              연동 해제
            </Button>
          </>
        )}
      </section>

      <Separator />

      {/* ── 삭제 요청 ──────────────────────────────────────────────────── */}
      <section className="space-y-3" data-testid="me-deletion">
        <h2 className="text-base font-semibold text-foreground">계정·데이터 삭제</h2>

        {/*
          무엇이 남는지 **항상** 보여준다. 접수 뒤에 감추면, 기다리는 동안 무엇이
          남는지 다시 확인할 방법이 없어진다 — 그때가 오히려 확인하고 싶은 시점이다.
        */}
        <div className="space-y-1 rounded-lg border border-border p-4" data-testid="retained">
          <p className="text-sm font-medium text-foreground">바로 지울 수 없는 기록</p>
          <p className="text-caption text-muted-foreground">{DELETION_RETAINED_NOTICE}</p>
          <ul className="space-y-1 pt-1">
            {DELETION_RETAINED_ITEMS.map((item) => (
              <li key={item.key} className="text-caption text-muted-foreground">
                · <span className="text-foreground">{item.label}</span> — {item.reason}
              </li>
            ))}
          </ul>
        </div>

        {openRequest ? (
          <div className="space-y-2 rounded-lg border border-border p-4" data-testid="open-request">
            <p className="text-sm font-medium text-foreground">
              {DELETION_STATUS_LABEL[openRequest.status]} ·{" "}
              {DELETION_SCOPE_LABEL[openRequest.scope as DeletionScope] ?? openRequest.scope}
            </p>
            <p className="text-caption text-muted-foreground">
              접수 {openRequest.requestedAt.slice(0, 10)} · 처리 결과는 이메일로 알려드려요.
            </p>

            {canCancelRequest(openRequest.status) ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending !== null}
                data-testid="cancel-request"
                onClick={() =>
                  call(
                    `/api/me/delete-request?id=${encodeURIComponent(openRequest.id)}`,
                    { method: "DELETE" },
                    "cancel",
                    "요청을 거뒀어요.",
                  )
                }
              >
                요청 거두기
              </Button>
            ) : (
              <p className="text-caption text-warning" data-testid="cancel-blocked">
                {DELETION_CANCEL_BLOCKED_NOTE}
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {DELETION_SCOPES.map((value) => (
                <label key={value} className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="scope"
                    value={value}
                    checked={scope === value}
                    onChange={() => setScope(value)}
                    className="mt-1 h-4 w-4 accent-brand-600"
                    data-testid={`scope-${value}`}
                  />
                  <span>
                    <span className="block text-foreground">{DELETION_SCOPE_LABEL[value]}</span>
                    <span className="block text-caption text-muted-foreground">
                      {DELETION_SCOPE_NOTE[value]}
                    </span>
                  </span>
                </label>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="acknowledged"
                checked={acknowledged}
                onCheckedChange={(checked) => setAcknowledged(checked === true)}
              />
              <Label htmlFor="acknowledged" className="font-normal">
                위 기록이 남는다는 것을 확인했어요
              </Label>
            </div>

            <Button
              type="button"
              variant="outline"
              disabled={pending !== null || !acknowledged}
              data-testid="request-deletion"
              onClick={() =>
                call(
                  "/api/me/delete-request",
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ scope, acknowledgedRetention: acknowledged }),
                  },
                  "delete",
                  "삭제 요청을 접수했어요.",
                )
              }
            >
              삭제 요청하기
            </Button>

            <p className="text-caption text-muted-foreground">
              접수 즉시 지워지지 않아요. 확인 후 처리하며, 처리가 시작되기 전까지는 요청을
              거둘 수 있어요.
            </p>
          </>
        )}
      </section>
    </div>
  );
}

export default MeForms;

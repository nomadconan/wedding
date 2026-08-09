"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { INVITE_TTL_HOURS } from "@/lib/core/schemas/onboarding";

/**
 * 커플 연동 (F-C-02, §2.1)
 *
 * 초대 코드를 발급해 배우자에게 전달하고, 배우자는 코드로 수락해 같은 `couple_id` 를 쓴다.
 *
 * **메일 발송은 알림 인프라(S4-13) 대기다.** 지금은 코드와 링크를 화면에 띄우고
 * 복사하게 한다 — 발송 경로를 두 번 만들지 않기 위해서다.
 */
export type PartnerInviteProps = {
  role: "owner" | "partner" | null;
  paired: boolean;
  appUrl: string;
};

export function PartnerInvite({ role, paired, appUrl }: PartnerInviteProps) {
  const router = useRouter();

  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [inputCode, setInputCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function call(body: unknown) {
    setPending(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch("/api/couples/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "처리하지 못했어요.");

        return null;
      }

      return payload.data;
    } catch {
      setError("처리하지 못했어요. 잠시 후 다시 시도해 주세요.");

      return null;
    } finally {
      setPending(false);
    }
  }

  async function issue() {
    const data = await call({ action: "issue" });
    if (!data) return;

    setCode(data.code);
    setExpiresAt(data.expiresAt);
    setNotice("초대 코드를 만들었어요. 배우자에게 전달해 주세요.");
  }

  async function accept() {
    const data = await call({ action: "accept", code: inputCode });
    if (!data) return;

    setNotice("연결됐어요. 이제 두 분이 같은 정보를 보게 됩니다.");
    setInputCode("");
    router.refresh();
  }

  if (paired) {
    return (
      <div className="space-y-2" data-testid="partner-paired">
        <Badge>배우자와 연결됨</Badge>
        <p className="text-sm text-muted-foreground">
          두 분이 같은 정보를 보고 있어요. 누가 무엇을 바꿨는지는 활동 기록에 남습니다.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="partner-invite">
      {role === "owner" ? (
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium">배우자 초대</p>
            <p className="text-caption text-muted-foreground">
              코드는 {INVITE_TTL_HOURS}시간 동안 쓸 수 있어요. 새로 만들면 이전 코드는 바로
              쓸 수 없게 됩니다.
            </p>
          </div>

          {code ? (
            <div className="space-y-2 rounded-lg border border-border bg-muted p-3">
              <p className="text-caption text-muted-foreground">초대 코드</p>
              <p className="text-amount-sm tracking-widest text-foreground" data-testid="invite-code">
                {code}
              </p>
              {expiresAt ? (
                <p className="text-caption text-muted-foreground">
                  만료 {expiresAt.slice(0, 16).replace("T", " ")}
                </p>
              ) : null}
              <p className="break-all text-caption text-muted-foreground">
                {appUrl}/onboarding?code={code}
              </p>
              {/* 메일·알림톡 발송은 S4-13 이 붙으면 이 자리에서 한다. */}
              <p className="text-caption text-muted-foreground">
                지금은 코드를 직접 전달해 주세요. 메일 발송은 알림 기능이 준비되면 붙습니다.
              </p>
            </div>
          ) : null}

          <Button type="button" variant="outline" disabled={pending} onClick={issue}>
            {pending ? "처리 중…" : code ? "새 코드 만들기" : "초대 코드 만들기"}
          </Button>
        </div>
      ) : null}

      {role === "owner" ? <Separator /> : null}

      <div className="space-y-2">
        <Label htmlFor="invite-code-input">받은 초대 코드가 있나요?</Label>
        <div className="flex gap-2">
          <Input
            id="invite-code-input"
            value={inputCode}
            maxLength={8}
            placeholder="ABCD2345"
            className="uppercase tracking-widest"
            onChange={(event) => setInputCode(event.target.value.toUpperCase())}
          />
          <Button type="button" disabled={pending || inputCode.length !== 8} onClick={accept}>
            연결
          </Button>
        </div>
        <p className="text-caption text-muted-foreground">
          한 사람은 커플 하나에만 속할 수 있어요.
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {notice ? <p className="text-sm text-success">{notice}</p> : null}
    </div>
  );
}

export default PartnerInvite;

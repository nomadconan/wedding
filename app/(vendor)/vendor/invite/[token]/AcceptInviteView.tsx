"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  INVITE_STATUS_LABEL,
  type InviteStatus,
} from "@/lib/core/vendor/vendor-invite";

/**
 * 초대 수락 (S2-09)
 *
 * ── 화면이 하는 일은 셋뿐이다 ───────────────────────────────────────────────
 *  1. 어느 업체가 어떤 권한으로 불렀는지 보여준다.
 *  2. 로그인이 안 됐으면 로그인으로 보낸다(돌아올 곳을 `next` 로 넘긴다).
 *  3. 수락을 서버에 넘긴다.
 *
 * **이메일 일치 확인을 화면이 하지 않는다.** 서버가 한다 — 마스킹된 이메일로는
 * 비교할 수 없고, 화면이 판정하면 우회할 수 있다. 화면은 서버가 돌려준 문장을
 * 그대로 보여준다.
 */
export type InvitePreviewProps = {
  token: string;
  invite: {
    vendorName: string;
    email: string;
    role: string;
    status: string;
    expiresAt: string;
  };
  signedIn: boolean;
  accountEmail: string | null;
};

export function AcceptInviteView({ token, invite, signedIn, accountEmail }: InvitePreviewProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const usable = invite.status === "pending";

  async function accept() {
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/vendor/invites/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "합류하지 못했어요.");

        return;
      }

      setDone(true);
      // 멤버가 됐으므로 업체 대시보드로 보낸다.
      router.push("/vendor");
    } catch {
      setError("합류하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card data-testid="accept-invite" data-status={invite.status}>
      <CardContent className="space-y-4 pt-6">
        <div className="space-y-1">
          <p className="text-caption text-muted-foreground">업체 멤버 초대</p>
          <h1 className="text-display-sm text-foreground">{invite.vendorName}</h1>
          <p className="text-sm text-muted-foreground">
            {invite.email} 주소로 <strong>{invite.role === "owner" ? "대표" : "담당자"}</strong>{" "}
            권한 초대가 왔어요.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={usable ? "default" : "secondary"}>
            {INVITE_STATUS_LABEL[invite.status as InviteStatus] ?? invite.status}
          </Badge>
          {usable ? (
            <span className="text-caption text-muted-foreground">
              {new Date(invite.expiresAt).toLocaleString("ko-KR")}까지 유효
            </span>
          ) : null}
        </div>

        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}

        {!usable ? (
          <p className="text-sm text-muted-foreground">
            이 초대는 지금 사용할 수 없어요. 업체에 재발송을 요청해 주세요.
          </p>
        ) : !signedIn ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              초대받은 이메일로 로그인하거나 가입한 뒤 이 링크를 다시 열어 주세요.
            </p>
            <Button size="touch" asChild>
              <Link href={`/login?next=${encodeURIComponent(`/vendor/invite/${token}`)}`}>
                로그인 · 가입하고 계속
              </Link>
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {accountEmail ? (
              <p className="text-caption text-muted-foreground">
                지금 <strong>{accountEmail}</strong> 로 로그인돼 있어요. 초대받은 주소와 다르면
                합류할 수 없어요.
              </p>
            ) : null}

            <Button
              size="touch"
              disabled={pending || done}
              onClick={() => void accept()}
              data-testid="accept-invite-button"
            >
              {done ? "합류했어요" : pending ? "처리 중" : "이 업체에 합류하기"}
            </Button>
          </div>
        )}

        <p className="text-caption text-muted-foreground">
          합류하면 업체의 상품·문의·상담 정보를 볼 수 있어요. 판매가와 정산은 대표 권한에서만
          다룰 수 있어요.
        </p>
      </CardContent>
    </Card>
  );
}

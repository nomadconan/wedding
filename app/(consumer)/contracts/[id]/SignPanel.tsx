"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * 서명 패널 (FIX-57 · S5-05)
 *
 * **정본 해시를 함께 보낸다**(D-23). 화면이 보고 있던 내용과 서버의 정본이 다르면
 * 서버가 거절한다 — **다른 내용에 서명하는 것**을 한 층 더 막는다.
 *
 * **역할을 보내지 않는다.** 어느 편인지는 서버가 세션으로 판정한다(`/api/contracts/[id]/sign`).
 */
export function SignPanel({
  contractId,
  contentHash,
}: {
  contractId: string;
  contentHash: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sign() {
    setPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/contracts/${contractId}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentHash }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "서명하지 못했어요.");

        return;
      }

      router.refresh();
    } catch {
      setError("서명하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button onClick={() => void sign()} disabled={pending} data-testid="contract-sign">
        {pending ? "서명하는 중…" : "서명하기"}
      </Button>

      {error !== null ? (
        <p className="text-caption text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

"use client";

import { MessagesSquare } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * 업체와 대화 시작 (F-C-27 진입점)
 *
 * **방을 여는 것은 고객뿐이다**(S4-01). 업체에는 `chat_rooms` INSERT 정책이 없다 —
 * 업체가 먼저 말을 걸 수 있으면 채팅이 영업 창구가 되기 때문이다(§2.2). 그래서
 * 이 버튼이 대화의 유일한 시작점이다.
 *
 * 열기는 **멱등**이다. 이미 방이 있으면 그 방으로 간다 — 방은 커플·업체 조합당
 * 하나이므로 두 번 눌러도 방이 둘이 되지 않는다.
 */
export function StartChatButton({ vendorId }: { vendorId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/chat/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "open", vendorId }),
      });
      const payload = await response.json();

      if (response.status === 401) {
        router.push(`/login?next=${encodeURIComponent(`/explore/${vendorId}`)}`);

        return;
      }

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "대화를 시작하지 못했어요.");

        return;
      }

      router.push(`/chat/${payload.data.roomId}`);
    } catch {
      setError("대화를 시작하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        size="touch"
        variant="outline"
        disabled={pending}
        onClick={() => void start()}
        data-testid="start-chat"
      >
        <MessagesSquare aria-hidden="true" className="mr-1.5 h-4 w-4" />
        {pending ? "대화를 여는 중" : "업체에 문의하기"}
      </Button>

      {error ? (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

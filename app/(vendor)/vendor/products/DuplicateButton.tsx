"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * 상품 복제 (C-3 · F-V-03)
 *
 * ── 왜 확인을 묻지 않는가 ──────────────────────────────────────────────────
 * `DecidePanel`·`IssuePanel` 은 누르기 전에 "되돌릴 수 없다" 고 말한다. 여기는
 * **되돌릴 수 있다** — 사본은 `draft` 라 고객에게 안 보이고 지우면 그만이다.
 * 되돌릴 수 있는 일에 확인을 붙이면 되돌릴 수 없는 일의 확인이 값싸 보인다.
 *
 * ── 대신 **무엇이 안 따라왔는지**를 말한다 ─────────────────────────────────
 * 복제 뒤 화면이 조용하면 업체는 사본이 이미 고객에게 보이는 줄 안다. 서버가
 * 돌려준 `remainingSteps` 를 **그대로** 적는다 — 화면이 자기 말로 바꾸면 서버가
 * 아는 사실과 갈린다(`IssuePanel` 과 같은 규칙).
 *
 * 누를 자리는 **대표에게만** 보인다(§3.9). 최종 경계는 RLS 이고 여기는 UX 보조다 —
 * 스태프가 어떻게든 부르면 서버가 403 을 주고 그 문장을 그대로 보여준다.
 */
export function DuplicateButton({
  productId,
  productName,
}: {
  productId: string;
  productName: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<string[] | null>(null);

  async function duplicate() {
    setPending(true);
    setError(null);
    setSteps(null);

    try {
      const response = await fetch(`/api/vendor/products/${productId}/duplicate`, {
        method: "POST",
      });
      const payload = (await response.json()) as {
        ok: boolean;
        data?: { productId: string; remainingSteps: string[] };
        error?: { message?: string };
      };

      if (!response.ok || !payload.ok || !payload.data) {
        setError(payload.error?.message ?? "복제하지 못했습니다.");

        return;
      }

      setSteps(payload.data.remainingSteps);
      router.refresh();
    } catch {
      setError("네트워크 문제로 복제하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-1.5" data-testid="duplicate-product">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        aria-label={`${productName} 복제`}
        onClick={() => void duplicate()}
      >
        {pending ? "복제 중…" : "복제"}
      </Button>

      {steps !== null ? (
        <div className="rounded-md border border-border bg-secondary/40 p-2.5" data-testid="duplicate-done">
          <p className="text-caption font-medium text-foreground">사본을 만들었어요.</p>
          <ul className="mt-1 space-y-0.5">
            {steps.map((step) => (
              <li key={step} className="text-caption text-muted-foreground">
                · {step}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {error !== null ? (
        <p className="text-caption text-warning" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

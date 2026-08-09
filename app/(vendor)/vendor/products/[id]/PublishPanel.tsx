"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { PRODUCT_STATUS_LABEL, type ProductStatus } from "@/lib/core/schemas/product";

/**
 * 게시 토글 (F-V-03, §6.3)
 *
 * 체크리스트가 남아 있으면 **버튼을 누를 수 없다.** 서버(422)와 DB(CHECK)도 같은 조건을
 * 걸어 두었으므로 이 비활성화는 세 겹 중 가장 바깥이며, 우회해도 통과하지 못한다.
 */
export type PublishPanelProps = {
  productId: string;
  status: ProductStatus;
  blockers: { code: string; message: string }[];
  canEdit: boolean;
};

export function PublishPanel({ productId, status, blockers, canEdit }: PublishPanelProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: ProductStatus) {
    setPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/vendor/products/${productId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });

      const body = await response.json();

      if (!response.ok || !body.ok) {
        setError(body.error?.message ?? "상태를 바꾸지 못했어요.");

        return;
      }

      router.refresh();
    } catch {
      setError("상태를 바꾸지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3" data-testid="publish-panel">
      <div className="space-y-1">
        <p className="text-sm font-medium">현재 상태 · {PRODUCT_STATUS_LABEL[status]}</p>
        {blockers.length === 0 ? (
          <p className="text-caption text-success">게시 조건을 모두 채웠습니다.</p>
        ) : (
          <ul className="space-y-0.5">
            {blockers.map((blocker) => (
              <li key={blocker.code} className="text-caption text-warning">
                · {blocker.message}
              </li>
            ))}
          </ul>
        )}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {status === "published" ? (
          <Button variant="secondary" disabled={!canEdit || pending} onClick={() => change("draft")}>
            노출 내리기
          </Button>
        ) : (
          <Button
            disabled={!canEdit || pending || blockers.length > 0}
            onClick={() => change("published")}
            data-testid="publish-button"
          >
            {pending ? "처리 중…" : "고객에게 게시"}
          </Button>
        )}

        {status !== "archived" ? (
          <Button variant="outline" disabled={!canEdit || pending} onClick={() => change("archived")}>
            보관
          </Button>
        ) : (
          <Button variant="outline" disabled={!canEdit || pending} onClick={() => change("draft")}>
            보관 해제
          </Button>
        )}
      </div>

      {!canEdit ? (
        <p className="text-caption text-muted-foreground">
          상품·가격 변경은 업체 대표 계정만 할 수 있습니다.
        </p>
      ) : null}
    </div>
  );
}

export default PublishPanel;

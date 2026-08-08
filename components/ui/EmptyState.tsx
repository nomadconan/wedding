import type { ReactNode } from "react";

import { AssetImage } from "@/components/ui/AssetImage";
import type { AssetId } from "@/lib/assets/manifest";
import { cn } from "@/lib/utils";

/**
 * 빈 상태 (T-04b)
 *
 * 명세서 §6 공통 UI 규칙: 로딩·빈 상태·에러 상태 3종을 모든 데이터 화면에 정의한다.
 *
 * 일러스트는 T-02c 자산 규약과 맞물린다 — 경로가 아니라 **슬롯 id** 를 받는다.
 * 실제 이미지를 같은 경로에 덮어써도 이 컴포넌트를 쓰는 화면은 수정할 필요가 없다.
 *
 *   <EmptyState assetId="reports.empty" title="아직 검토한 계약서가 없어요" />
 *
 * 빈 상태는 "없음"을 알리는 화면이 아니라 **다음 행동을 제안하는 화면**이다.
 * 그래서 action 을 우선 노출한다.
 */
export type EmptyStateProps = {
  /** 매니페스트 슬롯 id. 생략하면 일러스트 없이 문구만 보여준다. */
  assetId?: AssetId;
  title: string;
  description?: string;
  /** 주요 행동 버튼 등. */
  action?: ReactNode;
  className?: string;
};

export function EmptyState({ assetId, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-4 px-gutter py-12 text-center",
        className,
      )}
      data-testid="empty-state"
    >
      {assetId ? (
        <AssetImage
          id={assetId}
          // 장식용이다. 의미는 아래 제목·설명이 전달하므로 중복해서 읽히지 않게 한다(§7.5).
          alt=""
          aria-hidden="true"
          className="h-auto w-40 max-w-full opacity-90"
        />
      ) : null}

      <div className="space-y-1.5">
        <p className="text-base font-semibold text-foreground">{title}</p>
        {description ? (
          <p className="mx-auto max-w-[22rem] text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>

      {action ? <div className="w-full max-w-[18rem] pt-1">{action}</div> : null}
    </div>
  );
}

export default EmptyState;

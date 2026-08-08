import type { ReactNode } from "react";

import { BottomTabNav, type ConsumerTabHref } from "@/components/layout/BottomTabNav";
import { cn } from "@/lib/utils";

/**
 * 소비자 화면 셸 (T-04b)
 *
 * 명세서 §6 공통 UI 규칙: "모바일 퍼스트. 소비자 화면은 **375px 기준** 설계."
 *
 * 375px 를 기준 폭으로 잡고, 데스크톱에서는 480px 컬럼으로 가운데 정렬한다.
 * 소비자 화면을 데스크톱에서 넓게 펼치지 않는 이유는 Capacitor 래핑(D-07)으로
 * 그대로 앱이 되기 때문이다 — 웹과 앱의 레이아웃이 갈리면 두 번 만들게 된다.
 *
 * 하단 탭은 화면 전환의 유일한 1차 경로다. 상단에 또 다른 내비게이션을 두지 않는다.
 */
export type ConsumerShellProps = {
  children: ReactNode;
  /** 상단 헤더 제목. 없으면 헤더를 렌더하지 않는다(랜딩·전체화면 단계 등). */
  title?: string;
  /** 헤더 우측 액션(설정, 도움말 등). */
  headerAction?: ReactNode;
  /** 하단 탭을 숨긴다 — 온보딩처럼 한 화면 한 질문에 집중해야 하는 단계에서 쓴다. */
  hideTabBar?: boolean;
  /** 현재 활성 탭. 미지정 시 경로로 자동 판정한다. */
  activeTab?: ConsumerTabHref;
  /** 화면 하단에 고정되는 주요 액션(예: '다음' 버튼). */
  footer?: ReactNode;
  className?: string;
};

export function ConsumerShell({
  children,
  title,
  headerAction,
  hideTabBar = false,
  activeTab,
  footer,
  className,
}: ConsumerShellProps) {
  return (
    <div className="min-h-dvh bg-background">
      <div className="mx-auto flex min-h-dvh w-full max-w-consumer flex-col border-border bg-background sm:border-x">
        {title ? (
          <header className="sticky top-0 z-20 flex h-header shrink-0 items-center justify-between gap-2 border-b border-border bg-background/95 px-gutter backdrop-blur">
            <h1 className="truncate text-base font-semibold text-foreground">{title}</h1>
            {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
          </header>
        ) : null}

        <main
          className={cn(
            "flex-1 px-gutter py-5",
            // 하단 탭·고정 푸터에 콘텐츠가 가리지 않도록 여백을 준다.
            !hideTabBar && "pb-[calc(theme(spacing.tab-bar)+1.5rem)]",
            className,
          )}
        >
          {children}
        </main>

        {footer ? (
          <div
            className={cn(
              "sticky bottom-0 z-20 border-t border-border bg-background px-gutter py-3",
              hideTabBar ? "pb-safe" : "mb-tab-bar",
            )}
          >
            {footer}
          </div>
        ) : null}

        {hideTabBar ? null : <BottomTabNav activeTab={activeTab} />}
      </div>
    </div>
  );
}

export default ConsumerShell;

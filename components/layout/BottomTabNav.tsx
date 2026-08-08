"use client";

import { CalendarCheck, FileSearch, MessageCircle, Search, Wallet } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

/**
 * 소비자 하단 탭 (T-04b)
 *
 * 라우트 그룹 `(consumer)` 의 1차 경로와 1:1로 대응한다(명세서 §6.2).
 * 탭은 5개를 넘기지 않는다 — 375px 에서 6개부터는 터치 타깃이 44px 아래로 내려간다(§7.5).
 *
 * 탐색을 첫 번째에 두는 이유: 이 서비스의 주인공은 **가격 정찰제**이고,
 * 사용자가 가장 먼저 만나야 하는 것은 총액이 공개된 업체 목록이기 때문이다.
 * AI 플래너·계약 검토는 신뢰를 보조하는 기능이라 그다음에 온다.
 */
const TABS = [
  { href: "/explore", label: "탐색", icon: Search },
  { href: "/planner", label: "플래너", icon: MessageCircle },
  { href: "/reports", label: "검토", icon: FileSearch },
  { href: "/budget", label: "예산", icon: Wallet },
  { href: "/checkin", label: "체크인", icon: CalendarCheck },
] as const;

export type ConsumerTabHref = (typeof TABS)[number]["href"];

export type BottomTabNavProps = {
  /** 활성 탭을 명시한다. 생략하면 현재 경로로 판정한다. */
  activeTab?: ConsumerTabHref;
  className?: string;
};

export function BottomTabNav({ activeTab, className }: BottomTabNavProps) {
  const pathname = usePathname();

  function isActive(href: ConsumerTabHref) {
    if (activeTab !== undefined) return activeTab === href;
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <nav
      aria-label="주요 화면"
      data-testid="bottom-tab-nav"
      className={cn(
        "sticky bottom-0 z-30 border-t border-border bg-background/95 pb-safe backdrop-blur",
        className,
      )}
    >
      <ul className="flex h-tab-bar items-stretch">
        {TABS.map((tab) => {
          const active = isActive(tab.href);
          const Icon = tab.icon;

          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-full flex-col items-center justify-center gap-0.5 text-caption font-medium transition-colors",
                  active ? "text-brand-600" : "text-neutral-400 hover:text-neutral-600",
                )}
              >
                <Icon aria-hidden="true" className="h-5 w-5" />
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export default BottomTabNav;

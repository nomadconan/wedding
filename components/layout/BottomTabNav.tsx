"use client";

import { Heart, Home, Search, ShoppingBag, User } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

/**
 * 소비자 하단 탭 (T-04b)
 *
 * 라우트 그룹 `(consumer)` 의 1차 경로와 1:1로 대응한다(명세서 §6.2).
 * 탭은 5개를 넘기지 않는다 — 375px 에서 6개부터는 터치 타깃이 44px 아래로 내려간다(§7.5).
 *
 * **지금 도달 가능한 화면만 가리킨다**(S3-11 에서 정리). T-04b 시점의 탭 넷
 * (플래너·검토·예산·체크인)은 대응 화면이 아직 없어 누르면 404 로 갔다. 없는 화면을
 * 가리키는 탭은 "만들어 두고 켜지 않는" 것이 아니라 **깨진 것을 켜 둔** 상태다.
 * 각 화면이 생기는 태스크는 `docs/TASKS.md` 에 적어 뒀다
 * (플래너 S7-06 · 검토 S7-03 · 예산 S7-07 · 체크리스트 S7-08 · 마이페이지 S3-09).
 *
 * 순서의 근거 —
 *  · **홈**이 첫째다. 로그인한 사용자가 돌아올 자리이고, 흩어진 화면의 진입점이다.
 *  · **탐색**이 둘째다. 이 서비스의 주인공은 가격 정찰제이고 사용자가 만나야 할 것은
 *    총액이 공개된 업체 목록이다.
 *  · **장바구니·찜**은 담아 둔 것으로 돌아오는 경로다. 비교(`/explore/compare`)와
 *    업체 상세는 2차 화면이라 각각의 1차 화면에서 들어간다.
 *  · **마이**가 마지막이다(S3-09). 계정·개인정보는 자주 오는 곳이 아니라 끝에 둔다.
 *    이로써 다섯 칸이 찼다 — 여기서 더 늘리지 않는다.
 *
 * 빈 자리를 채우려고 없는 화면을 넣지 않는다. 5개는 상한이지 목표가 아니다.
 */
const TABS = [
  { href: "/home", label: "홈", icon: Home },
  { href: "/explore", label: "탐색", icon: Search },
  { href: "/cart", label: "장바구니", icon: ShoppingBag },
  { href: "/wishlist", label: "찜", icon: Heart },
  { href: "/me", label: "마이", icon: User },
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

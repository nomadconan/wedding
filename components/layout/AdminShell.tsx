"use client";

import {
  BarChart3,
  CalendarClock,
  CalendarRange,
  Clock,
  FileText,
  Flag,
  HelpCircle,
  LayoutDashboard,
  MessageSquare,
  MessagesSquare,
  Package,
  Receipt,
  Settings,
  ShieldCheck,
  Store,
  Tag,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * 업체 어드민 · 운영자 콘솔 공용 셸 (T-04b)
 *
 * 명세서 §6 공통 UI 규칙: "업체·운영자 콘솔은 **데스크톱(1280px) 기준**으로 하되 반응형 대응."
 *
 * 두 콘솔은 정보 구조가 같다(좌측 사이드바 + 본문). 컴포넌트를 나누면 한쪽만
 * 고쳐지는 일이 생기므로 `role` 로 내비게이션 항목만 바꾼다.
 *
 * 소비자 셸과 달리 하단 탭이 없다 — 데스크톱에서 하단 고정 내비게이션은
 * 화면 하단까지 시선을 끌고 내려가 표 작업을 방해한다.
 */
/**
 * S6-02 가 `planner` 를 더했다.
 *
 * **새 셸을 만들지 않은 이유.** 플래너는 **공급자 측 업무 콘솔**이고 화면 구조가
 * 업체 어드민과 같다(좌측 내비 + 표·폼). ConsumerShell(375px 모바일 퍼스트 · 하단 탭
 * 5개)에는 맞지 않고, 별도 셸을 만들면 같은 레이아웃이 두 벌이 되어 한쪽만 고치는
 * 날이 온다. 다른 것은 **내비 항목뿐**이라 role 하나로 갈랐다.
 */
export type AdminRole = "vendor" | "admin" | "planner";

type NavItem = { href: string; label: string; icon: LucideIcon };

/** 업체 어드민 (F-V-01~F-V-14, §6.3) */
const VENDOR_NAV: NavItem[] = [
  { href: "/vendor", label: "대시보드", icon: LayoutDashboard },
  { href: "/vendor/profile", label: "업체 프로필", icon: Store },
  { href: "/vendor/products", label: "상품·가격", icon: Package },
  { href: "/vendor/pricing", label: "다이내믹 프라이싱", icon: Tag },
  { href: "/vendor/inventory", label: "재고 캘린더", icon: CalendarRange },
  // 채팅은 문의·견적 위다(S4-04) — 응답 SLA 가 걸린 유일한 화면이라 먼저 눈에 띄어야 한다.
  { href: "/vendor/chat", label: "채팅 응대", icon: MessagesSquare },
  { href: "/vendor/inquiries", label: "문의·견적", icon: MessageSquare },
  // 문의게시판은 견적 문의와 다른 일이다 — 공개 Q&A 라 다음 고객도 읽는다(S4-05).
  { href: "/vendor/qna", label: "문의게시판", icon: HelpCircle },
  // S7-16. 문의게시판과 다르다 — 그쪽은 **우리에게 온 질문**이고 이쪽은 **우리를 말한
  // 남의 글**이다. 할 수 있는 일도 다르다: 답변까지이고 내리는 것은 운영자다(F-V-18).
  { href: "/vendor/community", label: "커뮤니티 태그", icon: MessagesSquare },
  // 상담은 문의·견적 다음이다 — 견적을 주고받은 뒤에 만나는 순서가 실제 흐름이다.
  { href: "/vendor/consultations", label: "상담 일정", icon: CalendarClock },
  { href: "/vendor/availability", label: "상담 가능 시간", icon: Clock },
  { href: "/vendor/bookings", label: "예약", icon: CalendarRange },
  { href: "/vendor/settlements", label: "정산", icon: Receipt },
  { href: "/vendor/stats", label: "성과 통계", icon: BarChart3 },
  { href: "/vendor/members", label: "멤버 관리", icon: Users },
  { href: "/vendor/settings", label: "설정", icon: Settings },
];

/** 운영자 콘솔 (F-A-01~F-A-14, §6.4) */
const ADMIN_NAV: NavItem[] = [
  { href: "/admin", label: "대시보드", icon: LayoutDashboard },
  { href: "/admin/vendors", label: "입점 심사", icon: ShieldCheck },
  { href: "/admin/prices", label: "가격 큐레이션", icon: Tag },
  { href: "/admin/quality", label: "AI 품질·비용", icon: BarChart3 },
  { href: "/admin/content", label: "콘텐츠", icon: FileText },
  { href: "/admin/tickets", label: "CS·신고", icon: Flag },
  // S7-17. **CS·신고와 다른 큐다** — 이쪽은 커뮤니티 게시물이고 조치가 비공개·복구이며
  // 사유가 기록에 남는다. 한 큐에 섞으면 처리 절차가 서로 다른 건이 같은 목록에 놓인다.
  { href: "/admin/community-reports", label: "커뮤니티 신고", icon: Flag },
  { href: "/admin/disputes", label: "분쟁 중재", icon: Users },
  { href: "/admin/settings", label: "설정", icon: Settings },
];

/**
 * 플래너 콘솔 (F-C-18, §6.2 보완 제안)
 *
 * **`/planner` 를 쓰지 않는다.** §6.2 가 그 경로를 **AI 플래너 채팅**(F-C-03, 7단계)에
 * 이미 배정했다 — 같은 접두어를 쓰면 "AI 플래너" 와 "사람 플래너" 가 한 자리에서
 * 뒤섞인다. `/planners` 도 쓸 수 없다: 그쪽은 **소비자용 마켓**이라 셸도 RLS 전제도
 * 다르다. 그래서 업체(`/vendor`)·운영자(`/admin`)와 같은 모양의 접두어 **`/pro`** 를
 * 쓴다. 명세 §6 반영을 제안한다(§7.5).
 */
const PLANNER_NAV: NavItem[] = [
  { href: "/pro", label: "내 프로필", icon: Store },
];

const ROLE_LABEL: Record<AdminRole, string> = {
  vendor: "업체 어드민",
  admin: "운영자 콘솔",
  planner: "플래너 콘솔",
};

export type AdminShellProps = {
  children: ReactNode;
  role: AdminRole;
  /** 본문 상단 제목. */
  title: string;
  /** 제목 옆 보조 설명. */
  description?: string;
  /** 제목 우측 액션(신규 등록 버튼 등). */
  action?: ReactNode;
  className?: string;
};

export function AdminShell({
  children,
  role,
  title,
  description,
  action,
  className,
}: AdminShellProps) {
  const pathname = usePathname();
  const nav = role === "vendor" ? VENDOR_NAV : role === "planner" ? PLANNER_NAV : ADMIN_NAV;

  function isActive(href: string) {
    // 대시보드(루트)는 정확히 일치할 때만 활성으로 본다.
    const isRoot = href === "/vendor" || href === "/admin" || href === "/pro";
    return isRoot ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <div className="min-h-dvh bg-muted" data-testid="admin-shell">
      <div className="mx-auto flex min-h-dvh w-full max-w-admin">
        {/* 사이드바 — 1280px 기준. 좁은 화면에서는 접어 아이콘만 남긴다. */}
        <aside className="sticky top-0 hidden h-dvh w-16 shrink-0 flex-col border-r border-border bg-background md:flex lg:w-sidebar">
          <div className="flex h-header items-center gap-2 border-b border-border px-4">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand-500 text-sm font-bold text-primary-foreground"
            >
              W
            </span>
            <span className="hidden truncate text-sm font-semibold lg:inline">
              {ROLE_LABEL[role]}
            </span>
          </div>

          <nav aria-label={ROLE_LABEL[role]} className="flex-1 overflow-y-auto p-2">
            <ul className="space-y-0.5">
              {nav.map((item) => {
                const active = isActive(item.href);
                const Icon = item.icon;

                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      title={item.label}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                        active
                          ? "bg-brand-50 text-brand-700"
                          : "text-neutral-600 hover:bg-secondary hover:text-foreground",
                      )}
                    >
                      <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                      <span className="hidden truncate lg:inline">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 flex min-h-header flex-wrap items-center justify-between gap-3 border-b border-border bg-background/95 px-6 py-3 backdrop-blur">
            <div className="min-w-0">
              <h1 className="truncate text-display-sm text-foreground">{title}</h1>
              {description ? (
                <p className="mt-0.5 truncate text-sm text-muted-foreground">{description}</p>
              ) : null}
            </div>
            {action ? <div className="shrink-0">{action}</div> : null}
          </header>

          <main className={cn("flex-1 p-6", className)}>{children}</main>
        </div>
      </div>
    </div>
  );
}

export default AdminShell;

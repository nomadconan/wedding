import { ArrowUpDown } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingState } from "@/components/ui/LoadingState";
import {
  BOARD_DESCRIPTION,
  BOARD_LABEL,
  BOARD_TYPES,
  COMMUNITY_SORTS,
  COMMUNITY_SORT_BASIS_NOTICE,
  COMMUNITY_SORT_LABEL,
  UNVERIFIED_NOTE,
  type BoardType,
  type CommunitySort,
} from "@/lib/core/community/community";
import { isTaskCategory, prepCategoryLabel } from "@/lib/core/category/axes";
import { COMMUNITY_FLAG, isFeatureEnabled } from "@/lib/flags";
import { listPosts } from "@/lib/community/loader";
import { createPublicClient } from "@/lib/explore/query";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { PostCard } from "./PostCard";

export const metadata: Metadata = {
  title: "커뮤니티 — 웨딩클리어",
};

/**
 * /community — 커뮤니티 게시판 (F-C-32 · 명세서 §6.2)
 *
 * **플래그가 꺼져 있으면 404 다.** T-00f 가 "모더레이션 없이 커뮤니티를 열 수 없다" 고
 * 정했고 처리 큐는 S7-17 이 만든다. 기능을 미루지 않고 **만들어 두고 켜지 않는다**
 * (CLAUDE.md §2.1 — 공개 시점 제어는 `feature_flags` 로만).
 *
 * **게시판 셋의 화면을 나누지 않았다.** 자유·경험담·Q&A 는 같은 목록의 **필터**이며
 * 각각 다른 레이아웃을 주지 않는다 — 글의 모양이 같은데 화면만 다르면 사용자는 어느
 * 탭에 써야 할지 고민하게 되고, 그 고민은 글을 덜 쓰게 만든다. 차이는 **작성 화면의
 * 안내 문구**와 경험담의 업체 태그 권유에 둔다.
 *
 * **비로그인도 읽는다**(§3.9 — published 만 anon SELECT). 쓰기부터 로그인이다.
 *
 * 하단 탭은 '홈' 을 켠다 — 다섯 칸이 이미 찼고(D-55) 진입은 홈과 업체 상세다.
 */
export default async function CommunityPage(
  props: {
    searchParams: Promise<{ board?: string; sort?: string; prep?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  if (!(await isFeatureEnabled(COMMUNITY_FLAG))) notFound();

  const board = (BOARD_TYPES as readonly string[]).includes(searchParams.board ?? "")
    ? (searchParams.board as BoardType)
    : null;
  const sort = (COMMUNITY_SORTS as readonly string[]).includes(searchParams.sort ?? "")
    ? (searchParams.sort as CommunitySort)
    : "recent";

  /**
   * 준비 항목으로 좁혀 들어온 경우 (C-4c · 체크리스트 다리).
   *
   * **어휘 밖 값은 조용히 무시하지 않고 `null` 로 떨어뜨린다** — 그러면 전체
   * 목록이 뜨고, 위 안내가 "좁혀서 보고 있다" 고 말하지 않으므로 사용자가 무엇을
   * 보고 있는지 헷갈리지 않는다. 422 로 막지 않는 이유는 이것이 **읽기 화면**이고
   * 링크가 낡아도 글은 보여야 하기 때문이다.
   */
  const prep = isTaskCategory(searchParams.prep) ? searchParams.prep : null;

  return (
    <ConsumerShell title="커뮤니티" activeTab="/home">
      <div className="space-y-4">
        <nav aria-label="게시판" className="flex gap-2 overflow-x-auto pb-1">
          <BoardTab href="/community" label="전체" active={board === null} />
          {BOARD_TYPES.map((type) => (
            <BoardTab
              key={type}
              href={`/community?board=${type}`}
              label={BOARD_LABEL[type]}
              active={board === type}
            />
          ))}
        </nav>

        {board === null ? null : (
          <p className="text-caption text-muted-foreground">{BOARD_DESCRIPTION[board]}</p>
        )}

        {/* 정렬 기준을 화면에 적는다 — 조회수·좋아요가 순서에 없다는 사실이 증거다(D-03). */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-1 text-caption font-medium text-secondary-foreground">
            <ArrowUpDown aria-hidden="true" className="h-3 w-3" />
            정렬 기준 · {COMMUNITY_SORT_LABEL[sort]}
          </span>
          {COMMUNITY_SORTS.filter((value) => value !== sort).map((value) => (
            <Link
              key={value}
              href={`/community?${board === null ? "" : `board=${board}&`}sort=${value}`}
              className="text-caption font-medium text-brand-600"
            >
              {COMMUNITY_SORT_LABEL[value]}으로 보기
            </Link>
          ))}
        </div>

        <p className="text-caption text-neutral-500" data-testid="community-sort-basis">
          {COMMUNITY_SORT_BASIS_NOTICE}
        </p>

        <Link
          href="/community/write"
          className="block rounded-lg bg-brand-500 px-4 py-3 text-center text-sm font-semibold text-primary-foreground"
          data-testid="community-write-link"
        >
          글쓰기
        </Link>

        {/*
          좁혀 보고 있다는 사실을 화면이 말한다 (C-4c). 말하지 않으면 사용자는
          **글이 적은 것**을 커뮤니티가 한산한 것으로 읽는다.
        */}
        {prep === null ? null : (
          <p className="text-caption text-muted-foreground" data-testid="community-prep-filter">
            <strong className="text-foreground">{prepCategoryLabel(prep)}</strong> 준비에 붙은 글만
            보고 있어요.{" "}
            <Link href="/community" className="text-brand-600 underline-offset-2 hover:underline">
              전체 보기
            </Link>
          </p>
        )}

        <Suspense
          key={`${board ?? "all"}-${sort}-${prep ?? "all"}`}
          fallback={<LoadingState label="글을 불러오는 중" rows={4} variant="list" />}
        >
          <PostList board={board} sort={sort} prep={prep} />
        </Suspense>

        <p className="text-caption text-muted-foreground">{UNVERIFIED_NOTE}</p>
      </div>
    </ConsumerShell>
  );
}

function BoardTab({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`shrink-0 rounded-full border px-3 py-1 text-caption ${
        active ? "border-brand-500 text-brand-600" : "border-border text-muted-foreground"
      }`}
    >
      {label}
    </Link>
  );
}

async function PostList({
  board,
  sort,
  prep,
}: {
  board: BoardType | null;
  sort: CommunitySort;
  prep: string | null;
}) {
  const user = await getSessionUser();
  const supabase = await createClient();

  const posts = await listPosts(supabase, createPublicClient(), {
    board,
    sort,
    prep,
    viewerId: user?.id ?? null,
  });

  if (posts.length === 0) {
    return (
      <EmptyState
        title={prep === null ? "아직 글이 없어요" : "이 준비에 붙은 글이 아직 없어요"}
        description={
          prep === null
            ? "먼저 겪은 이야기를 남기면 다음 사람이 덜 헤맵니다."
            : "다른 준비의 글은 전체 목록에서 볼 수 있어요. 먼저 겪으셨다면 남겨 주세요."
        }
      />
    );
  }

  return (
    <ul className="space-y-2" data-testid="community-list">
      {posts.map((post) => (
        <li key={post.id}>
          <PostCard post={post} />
        </li>
      ))}
    </ul>
  );
}

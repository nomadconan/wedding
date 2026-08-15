import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import {
  BOARD_LABEL,
  UNVERIFIED_LABEL,
  mentionLabel,
} from "@/lib/core/community/community";
import type { CommunityPostRow } from "@/lib/community/loader";

/**
 * 글 카드 (S7-15 · 명세서 §6.2 `/community`)
 *
 * **업체 태그는 검증 후기처럼 보이면 안 된다**(D-26). 태그 칩 옆에 '미검증 경험담'
 * 라벨을 붙이고, `verified_purchase` 가 참이어도 **라벨은 그대로 둔다** — 거래 이력은
 * 힌트일 뿐이고 검증 후기(F-C-17)는 결제 이력자만 쓰는 다른 것이다.
 *
 * **조회수·좋아요를 크게 그리지 않는다.** 순서에 쓰지 않기로 한 값을 화면에서 키우면
 * 사용자는 그것이 중요한 신호라고 읽는다(D-03 을 다른 방식으로 무너뜨린다).
 */
export function PostCard({ post }: { post: CommunityPostRow }) {
  return (
    <Link
      href={`/community/${post.id}`}
      className="block space-y-2 rounded-lg border border-border p-4"
      data-testid="community-post-card"
      data-board={post.boardType}
    >
      <div className="flex items-center gap-2">
        <Badge variant="secondary">{BOARD_LABEL[post.boardType]}</Badge>
        {post.isPinned ? <Badge variant="outline">고정</Badge> : null}
        {post.isMine ? <Badge variant="outline">내 글</Badge> : null}
      </div>

      <p className="text-sm font-medium text-foreground">{post.title}</p>

      {post.tags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="community-post-tags">
          {post.tags.map((tag) => {
            const label = mentionLabel({ verifiedPurchase: tag.verifiedPurchase });

            return (
              <span
                key={tag.vendorId}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-caption text-muted-foreground"
              >
                {tag.vendorName}
                <span className="text-neutral-400">·</span>
                <span className="text-neutral-500">{label.label}</span>
              </span>
            );
          })}
        </div>
      ) : null}

      {/* 순서에 쓰지 않는 값이라 작게 둔다. */}
      <p className="text-caption text-neutral-400">
        댓글 {post.commentCount} · 좋아요 {post.likeCount} · 조회 {post.viewCount}
        {post.tags.length > 0 ? ` · ${UNVERIFIED_LABEL}` : ""}
      </p>
    </Link>
  );
}

export default PostCard;

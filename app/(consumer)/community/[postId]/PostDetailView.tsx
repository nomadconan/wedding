"use client";

import { Bookmark, Flag, Heart, MessageCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  BOARD_LABEL,
  COMMENT_BODY_MAX_LENGTH,
  REPORT_REASONS,
  REPORT_REASON_LABEL,
  UNVERIFIED_LABEL,
  UNVERIFIED_NOTE,
  commentProblem,
  mentionLabel,
  type ReportReason,
} from "@/lib/core/community/community";
import type { CommunityPostDetail } from "@/lib/community/loader";
import { cn } from "@/lib/utils";

/**
 * /community/[postId] — 글 상세 (F-C-32·33·34 · 명세서 §6.2)
 *
 * **업체 태그는 '미검증 경험담' 으로 라벨링하고 검증 후기와 시각적으로 분리한다**
 * (D-26). 이 화면에는 검증 후기가 없지만 업체 상세(§6.2)에서 둘이 나란히 놓이므로,
 * 라벨과 설명 문구를 여기서도 같은 문장으로 쓴다 — 두 화면이 다르게 말하면 라벨이
 * 장식이 된다.
 *
 * **신고는 접수만 한다.** 처리 큐는 운영자 콘솔(S7-17)이며, 신고자에게 목록을 주지
 * 않는다 — 같은 대상을 두 번 신고할 수 없으므로 "접수됨" 만 알면 된다.
 */
export function PostDetailView({ initial }: { initial: CommunityPostDetail }) {
  const router = useRouter();

  const [post, setPost] = useState(initial);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);

  const problem = commentProblem(draft);

  async function refresh() {
    const response = await fetch(`/api/community/posts/${post.id}`);
    const payload = await response.json();

    if (response.ok && payload.ok) setPost(payload.data.post);
  }

  async function toggleLike() {
    setBusy(true);

    try {
      const response = await fetch(`/api/community/posts/${post.id}/like`, {
        method: post.liked ? "DELETE" : "POST",
      });
      const payload = await response.json();

      if (response.ok && payload.ok) {
        setPost((prev) => ({
          ...prev,
          liked: payload.data.liked,
          likeCount: payload.data.likeCount ?? prev.likeCount,
        }));
      }
    } finally {
      setBusy(false);
    }
  }

  async function toggleScrap() {
    setBusy(true);

    try {
      const response = await fetch(`/api/community/posts/${post.id}/scrap`, {
        method: post.scrapped ? "DELETE" : "POST",
      });
      const payload = await response.json();

      if (response.ok && payload.ok) {
        setPost((prev) => ({ ...prev, scrapped: payload.data.scrapped }));
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitComment() {
    if (problem !== null || busy) return;

    setBusy(true);
    setNotice(null);

    try {
      const response = await fetch(`/api/community/posts/${post.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: draft.trim(),
          ...(replyTo === null ? {} : { parentId: replyTo }),
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setNotice(payload.error?.message ?? "댓글을 달지 못했어요.");

        return;
      }

      setDraft("");
      setReplyTo(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function report(reason: ReportReason) {
    setBusy(true);
    setReporting(false);

    try {
      const response = await fetch("/api/community/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetType: "post", targetId: post.id, reasonCode: reason }),
      });
      const payload = await response.json();

      setNotice(
        response.ok && payload.ok
          ? "신고가 접수됐어요. 운영자가 확인합니다."
          : (payload.error?.message ?? "신고하지 못했어요."),
      );
    } finally {
      setBusy(false);
    }
  }

  async function removePost() {
    setBusy(true);

    try {
      const response = await fetch(`/api/community/posts/${post.id}`, { method: "DELETE" });

      if (response.ok) router.push("/community");
    } finally {
      setBusy(false);
    }
  }

  const topLevel = post.comments.filter((comment) => comment.parentId === null);

  return (
    <div className="space-y-4" data-testid="community-detail" data-status={post.status}>
      <article className="space-y-3">
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{BOARD_LABEL[post.boardType]}</Badge>
          {post.isMine ? <Badge variant="outline">내 글</Badge> : null}
        </div>

        <h2 className="text-lg font-semibold text-foreground">{post.title}</h2>

        {/* 업체 태그 — **검증 후기와 시각적으로 분리한다**(§6.2). 카드 모양을 쓰지 않고
            테두리 있는 칩으로 두어 후기 카드와 섞이지 않게 한다. */}
        {post.tags.length > 0 ? (
          <section
            className="space-y-1 rounded-lg border border-dashed border-border p-3"
            data-testid="community-detail-tags"
          >
            <p className="text-caption font-medium text-muted-foreground">
              언급된 업체 · {UNVERIFIED_LABEL}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {post.tags.map((tag) => {
                const label = mentionLabel({ verifiedPurchase: tag.verifiedPurchase });

                return (
                  <span
                    key={tag.vendorId}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-caption text-foreground"
                  >
                    {tag.vendorName}
                    {label.hint === null ? null : (
                      <span className="text-neutral-400">· {label.hint}</span>
                    )}
                  </span>
                );
              })}
            </div>
            <p className="text-caption text-neutral-500">{UNVERIFIED_NOTE}</p>
          </section>
        ) : null}

        <p className="whitespace-pre-wrap text-sm text-foreground">{post.body}</p>
      </article>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void toggleLike()}>
          <Heart
            aria-hidden="true"
            className={cn("mr-1 h-4 w-4", post.liked && "fill-brand-500 text-brand-500")}
          />
          좋아요 {post.likeCount}
        </Button>

        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void toggleScrap()}>
          <Bookmark
            aria-hidden="true"
            className={cn("mr-1 h-4 w-4", post.scrapped && "fill-brand-500 text-brand-500")}
          />
          {post.scrapped ? "스크랩됨" : "스크랩"}
        </Button>

        {post.isMine ? (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void removePost()}>
            지우기
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setReporting((value) => !value)}>
            <Flag aria-hidden="true" className="mr-1 h-4 w-4" />
            신고
          </Button>
        )}
      </div>

      {reporting ? (
        <div className="space-y-2 rounded-lg border border-border p-3" data-testid="community-report">
          <p className="text-caption text-muted-foreground">어떤 문제인가요?</p>
          <div className="flex flex-wrap gap-1.5">
            {REPORT_REASONS.map((reason) => (
              <Button
                key={reason}
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void report(reason)}
              >
                {REPORT_REASON_LABEL[reason]}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {notice ? (
        <p role="status" className="text-sm text-muted-foreground" data-testid="community-notice">
          {notice}
        </p>
      ) : null}

      <section className="space-y-3">
        <h3 className="flex items-center gap-1 text-sm font-semibold text-foreground">
          <MessageCircle aria-hidden="true" className="h-4 w-4" />
          댓글 {post.comments.length}
        </h3>

        <ul className="space-y-2" data-testid="community-comments">
          {topLevel.map((comment) => (
            <li key={comment.id} className="space-y-2">
              <CommentRow comment={comment} onReply={() => setReplyTo(comment.id)} />

              {post.comments
                .filter((child) => child.parentId === comment.id)
                .map((child) => (
                  <div key={child.id} className="ml-4">
                    <CommentRow comment={child} onReply={null} />
                  </div>
                ))}
            </li>
          ))}
        </ul>

        <div className="space-y-1">
          {replyTo === null ? null : (
            <p className="text-caption text-muted-foreground">
              답글을 씁니다.{" "}
              <button type="button" className="font-medium text-brand-600" onClick={() => setReplyTo(null)}>
                취소
              </button>
            </p>
          )}

          <div className="flex items-end gap-2">
            <label className="sr-only" htmlFor="community-comment">
              댓글
            </label>
            <textarea
              id="community-comment"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={COMMENT_BODY_MAX_LENGTH}
              rows={2}
              placeholder="댓글을 남겨 주세요"
              className="min-h-11 flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm"
              data-testid="community-comment-input"
            />
            <Button type="button" disabled={problem !== null || busy} onClick={() => void submitComment()}>
              등록
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}

function CommentRow({
  comment,
  onReply,
}: {
  comment: CommunityPostDetail["comments"][number];
  onReply: (() => void) | null;
}) {
  return (
    <div
      className="space-y-1 rounded-lg border border-border p-3"
      data-testid="community-comment"
      data-vendor-reply={comment.isVendorReply}
    >
      <div className="flex items-center gap-2">
        {/* 업체 답변은 구분해 보인다(F-V-18) — 누가 말했는지가 읽는 사람의 판단을 바꾼다. */}
        {comment.isVendorReply ? <Badge variant="secondary">업체 답변</Badge> : null}
        {comment.isMine ? <Badge variant="outline">내 댓글</Badge> : null}
      </div>

      <p className="whitespace-pre-wrap text-sm text-foreground">{comment.body}</p>

      {onReply === null ? null : (
        <button type="button" className="text-caption font-medium text-brand-600" onClick={onReply}>
          답글
        </button>
      )}
    </div>
  );
}

export default PostDetailView;

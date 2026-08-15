"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  COMMENT_BODY_MAX_LENGTH,
  REPORT_REASONS,
  REPORT_REASON_LABEL,
  UNVERIFIED_LABEL,
  type ReportReason,
} from "@/lib/core/community/community";
import {
  TAGGED_POST_STATE_LABEL,
  VENDOR_REPLY_LIMIT_NOTE,
  VENDOR_REPLY_MODERATED_NOTE,
  VENDOR_REPLY_SCOPE_NOTE,
  vendorReplyProblem,
} from "@/lib/core/community/vendor-reply";
import type { TaggedPost } from "@/lib/community/vendor";

/**
 * /vendor/community — 자사 태그 글 (F-V-18 · §6.3)
 *
 * ── 이 화면이 하지 않는 일 ──────────────────────────────────────────────────
 * **본문 수정 수단을 만들지 않는다.** 입력칸도 버튼도 없다 — RLS 가 막는 것과 별개로,
 * 화면에 자리가 있으면 "왜 안 되나" 를 묻게 되고 그 질문의 답이 "권한이 없다" 이면
 * 화면이 거짓 기대를 만든 것이다.
 *
 * **글을 내리는 버튼도 없다.** 부당하다고 판단하면 **신고**한다 — 내리는 것은
 * 운영자의 일이고(F-A-18) 우리는 조율자다(D-24).
 *
 * 태그된 글은 **'미검증 경험담'** 이다. 업체 화면에서도 그 라벨을 유지한다 — 여기서만
 * 다르게 부르면 같은 글이 두 이름을 갖는다.
 */
export function VendorCommunityView({ posts }: { posts: TaggedPost[] }) {
  if (posts.length === 0) {
    return (
      <EmptyState
        title="자사가 태그된 글이 없어요"
        description="회원이 글에 우리 업체를 태그하면 여기에서 보고 답변할 수 있어요."
      />
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-caption text-muted-foreground">{VENDOR_REPLY_SCOPE_NOTE}</p>

      {posts.map((post) => (
        <TaggedCard key={post.postId} post={post} />
      ))}

      <p className="text-caption text-neutral-500">{VENDOR_REPLY_MODERATED_NOTE}</p>
    </div>
  );
}

function TaggedCard({ post }: { post: TaggedPost }) {
  const router = useRouter();

  const [draft, setDraft] = useState(post.reply?.body ?? "");
  const [editing, setEditing] = useState(post.reply === null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);

  const problem =
    post.reply !== null
      ? null
      : vendorReplyProblem({
          body: draft,
          existingReplies: 0,
          targetStatus: post.status,
        });

  async function submit() {
    if (busy) return;

    setBusy(true);
    setNotice(null);

    try {
      const response = await fetch("/api/vendor/community-tags", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          post.reply === null
            ? { action: "reply", postId: post.postId, body: draft.trim() }
            : { action: "edit_reply", commentId: post.reply.id, body: draft.trim() },
        ),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setNotice(payload.error?.message ?? "답변을 남기지 못했어요.");

        return;
      }

      setEditing(false);
      router.refresh();
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
        body: JSON.stringify({ targetType: "post", targetId: post.postId, reasonCode: reason }),
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

  return (
    <section
      className="space-y-3 rounded-lg border border-border p-4"
      data-testid="vendor-tagged-post"
      data-state={post.state}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{TAGGED_POST_STATE_LABEL[post.state]}</Badge>
        <Badge variant="outline">{UNVERIFIED_LABEL}</Badge>
        {post.reported ? <Badge variant="outline">신고함</Badge> : null}
      </div>

      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{post.title}</p>
        <p className="whitespace-pre-wrap text-caption text-muted-foreground">{post.body}</p>
      </div>

      {post.status === "published" ? null : (
        <p className="text-caption text-warning">
          {post.status === "deleted"
            ? "작성자가 지운 글이라 답변할 수 없어요."
            : "지금 비공개인 글이라 답변할 수 없어요."}
        </p>
      )}

      {post.reply !== null && !editing ? (
        <div className="space-y-2 rounded-md bg-muted p-3">
          <p className="text-caption font-medium text-muted-foreground">우리 업체 답변</p>
          <p className="whitespace-pre-wrap text-sm text-foreground">{post.reply.body}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
            답변 고치기
          </Button>
        </div>
      ) : post.status === "published" ? (
        <div className="space-y-2">
          <label className="block space-y-1">
            <span className="text-caption font-medium text-foreground">
              {post.reply === null ? "공식 답변 (글마다 한 번)" : "답변 고치기"}
            </span>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={3}
              maxLength={COMMENT_BODY_MAX_LENGTH}
              className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm"
              data-testid="vendor-reply-input"
            />
          </label>

          {problem !== null && draft !== "" ? (
            <p role="alert" className="text-sm text-warning">
              {problem.message}
            </p>
          ) : null}

          <div className="flex gap-2">
            <Button
              type="button"
              disabled={busy || draft.trim() === "" || (post.reply === null && problem !== null)}
              onClick={() => void submit()}
            >
              {busy ? "저장 중…" : post.reply === null ? "답변 남기기" : "고치기"}
            </Button>

            {post.reply !== null ? (
              <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                취소
              </Button>
            ) : null}
          </div>

          <p className="text-caption text-neutral-500">{VENDOR_REPLY_LIMIT_NOTE}</p>
        </div>
      ) : null}

      {/* **내리는 버튼이 없다.** 부당하다고 보면 신고하고 판단은 운영자가 한다(D-24). */}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || post.reported}
          onClick={() => setReporting((value) => !value)}
        >
          {post.reported ? "이미 신고함" : "부당 게시물 신고"}
        </Button>
      </div>

      {reporting ? (
        <div className="space-y-2 rounded-lg border border-border p-3" data-testid="vendor-report">
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

      {notice !== null ? (
        <p role="status" className="text-sm text-muted-foreground" data-testid="vendor-community-notice">
          {notice}
        </p>
      ) : null}
    </section>
  );
}

export default VendorCommunityView;

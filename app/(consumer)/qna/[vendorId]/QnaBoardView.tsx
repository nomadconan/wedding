"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { Label } from "@/components/ui/label";
import {
  QNA_BODY_MAX,
  QNA_EMPTY_DESCRIPTION,
  QNA_EMPTY_TITLE,
  QNA_PRIVATE_NOTE,
  QNA_STATUS_LABEL,
  QNA_TITLE_MAX,
  SIMILAR_HINT,
  type QnaPostView,
  type QnaStatus,
} from "@/lib/core/schemas/qna";

/**
 * 문의게시판 (F-C-28, §6.2 `/qna/[vendorId]`)
 *
 * ── 유사 질문을 **쓰기 전에** 보여준다 ──────────────────────────────────────
 * F-C-28 이 든 목적이 "중복 문의를 줄인다" 이므로, 다 쓰고 나서 보여주면 늦다.
 * 제목을 입력하는 동안 조회해 같은 질문이 이미 있으면 먼저 읽게 한다.
 *
 * ── 공개/비공개 ─────────────────────────────────────────────────────────────
 * 기본은 공개다 — 공개 질문이 다음 사람을 돕고, 그것이 이 게시판의 존재 이유다.
 * 비공개를 고르면 작성자와 해당 업체만 본다(RLS 가 판정한다).
 */
export function QnaBoardView({
  vendorId,
  initialPosts,
  signedIn,
  viewerId,
}: {
  vendorId: string;
  initialPosts: QnaPostView[];
  signedIn: boolean;
  viewerId: string | null;
}) {
  const [posts, setPosts] = useState(initialPosts);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [similar, setSimilar] = useState<{ id: string; title: string; answered: boolean }[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/qna?vendorId=${encodeURIComponent(vendorId)}`);
      const payload = await response.json();

      if (response.ok && payload.ok) setPosts(payload.data.posts as QnaPostView[]);
    } catch {
      // 목록은 이미 그려져 있다.
    }
  }, [vendorId]);

  // 제목을 치는 동안 유사 질문을 찾는다. 타이핑마다 부르지 않도록 잠깐 기다린다.
  useEffect(() => {
    if (title.trim().length < 2) {
      setSimilar([]);

      return;
    }

    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/qna?vendorId=${encodeURIComponent(vendorId)}&similar=${encodeURIComponent(title)}`,
        );
        const payload = await response.json();

        if (response.ok && payload.ok) setSimilar(payload.data.similar ?? []);
      } catch {
        setSimilar([]);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [title, vendorId]);

  async function submit() {
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/qna", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", vendorId, title, body, isPublic }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "질문을 등록하지 못했어요.");

        return;
      }

      setTitle("");
      setBody("");
      setSimilar([]);
      await refresh();
    } catch {
      setError("질문을 등록하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  async function withdraw(postId: string) {
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/qna", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "withdraw", postId }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "내리지 못했어요.");

        return;
      }

      await refresh();
    } catch {
      setError("내리지 못했어요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="qna-board">
      {/* ── 작성 ─────────────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="space-y-3 pt-5">
          <p className="text-sm font-semibold text-foreground">질문 남기기</p>

          {signedIn ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="qna-title">제목</Label>
                <input
                  id="qna-title"
                  value={title}
                  maxLength={QNA_TITLE_MAX}
                  placeholder="예: 주차 공간이 얼마나 되나요?"
                  onChange={(event) => setTitle(event.target.value)}
                  className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
                />
              </div>

              {similar.length > 0 ? (
                <div
                  className="rounded-md bg-secondary/60 p-2.5"
                  data-testid="similar-questions"
                >
                  <p className="text-caption font-medium text-foreground">{SIMILAR_HINT}</p>
                  <ul className="mt-1 space-y-0.5">
                    {similar.map((item) => (
                      <li key={item.id} className="truncate text-caption text-muted-foreground">
                        · {item.title}
                        {item.answered ? " (답변 완료)" : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="space-y-1.5">
                <Label htmlFor="qna-body">내용</Label>
                <textarea
                  id="qna-body"
                  rows={3}
                  value={body}
                  maxLength={QNA_BODY_MAX}
                  onChange={(event) => setBody(event.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </div>

              <div className="flex items-center gap-2">
                <Checkbox
                  id="qna-public"
                  checked={!isPublic}
                  onCheckedChange={(next) => setIsPublic(next !== true)}
                />
                <Label htmlFor="qna-public" className="text-sm font-normal">
                  비공개로 남기기
                </Label>
              </div>
              <p className="text-caption text-muted-foreground">{QNA_PRIVATE_NOTE}</p>

              {error ? (
                <p role="alert" className="text-sm text-danger">
                  {error}
                </p>
              ) : null}

              <Button
                type="button"
                size="touch"
                disabled={pending}
                onClick={() => void submit()}
                data-testid="submit-qna"
              >
                질문 등록
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              질문을 남기려면{" "}
              <Link
                href={`/login?next=${encodeURIComponent(`/qna/${vendorId}`)}`}
                className="font-medium text-brand-600"
              >
                로그인
              </Link>
              이 필요해요. 공개 질문과 답변은 로그인 없이도 읽을 수 있어요.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── 목록 ─────────────────────────────────────────────────────────── */}
      {posts.length === 0 ? (
        <EmptyState assetId="explore.empty" title={QNA_EMPTY_TITLE} description={QNA_EMPTY_DESCRIPTION} />
      ) : (
        <ul className="space-y-2" data-testid="qna-posts">
          {posts.map((post) => (
            <li key={post.id}>
              <Card data-testid="qna-post" data-public={post.isPublic}>
                <CardContent className="space-y-2 pt-5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="min-w-0 flex-1 text-sm font-semibold text-foreground">
                      {post.title}
                    </p>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {!post.isPublic ? <Badge variant="secondary">비공개</Badge> : null}
                      <Badge variant={post.status === "answered" ? "default" : "outline"}>
                        {QNA_STATUS_LABEL[post.status as QnaStatus] ?? post.status}
                      </Badge>
                    </div>
                  </div>

                  <p className="whitespace-pre-wrap text-sm text-foreground">{post.body}</p>

                  {post.answers.map((answer) => (
                    <div
                      key={answer.id}
                      className="rounded-md bg-secondary/60 p-2.5"
                      data-testid="qna-answer"
                    >
                      <p className="text-caption font-medium text-foreground">업체 답변</p>
                      <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">
                        {answer.body}
                      </p>
                    </div>
                  ))}

                  {viewerId !== null && post.authorId === viewerId && post.status !== "withdrawn" ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => void withdraw(post.id)}
                    >
                      내 질문 내리기
                    </Button>
                  ) : null}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

"use client";

import { useCallback, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Label } from "@/components/ui/label";
import {
  QNA_BODY_MAX,
  QNA_STATUS_LABEL,
  QNA_VENDOR_VISIBILITY_NOTE,
  type QnaPostView,
  type QnaStatus,
} from "@/lib/core/schemas/qna";
import { cn } from "@/lib/utils";

const ENDPOINT = "/api/vendor/qna";

/**
 * 업체 문의게시판 (F-V-16, §6.3 `/vendor/qna`)
 *
 * ── 이 화면에 **없는 것** ───────────────────────────────────────────────────
 * 고객 질문의 제목·본문을 고치는 칸이 없다. 업체가 고객 질문을 고쳐 쓸 수 있으면
 * 게시판이 업체의 홍보물이 된다 — S4-01 트리거가 DB 에서도 막는다.
 *
 * **공개 설정은 내리는 방향만 열려 있다.** 비공개 질문을 공개로 바꾸는 것은 설정
 * 변경이 아니라 유출이므로 작성자만 할 수 있다. 화면은 그 사실을 적고, 판정은 DB 가
 * 한다 — 화면이 버튼을 숨기는 것으로 끝내지 않는다.
 */
export function VendorQnaView({
  initialPosts,
  viewerId,
}: {
  initialPosts: QnaPostView[];
  viewerId: string;
}) {
  const [posts, setPosts] = useState(initialPosts);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"unanswered" | "all">("unanswered");

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(ENDPOINT);
      const payload = await response.json();

      if (response.ok && payload.ok) setPosts(payload.data.posts as QnaPostView[]);
    } catch {
      // 목록은 이미 그려져 있다.
    }
  }, []);

  async function call(body: unknown, key: string) {
    setPending(key);
    setError(null);

    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "처리하지 못했어요.");

        return;
      }

      await refresh();
    } catch {
      setError("처리하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(null);
    }
  }

  const visible = filter === "unanswered" ? posts.filter((post) => post.status === "open") : posts;

  if (posts.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6">
          <EmptyState
            assetId="vendor.dashboard.empty"
            title="아직 등록된 질문이 없어요"
            description="고객이 업체 문의게시판에 질문을 남기면 여기에 쌓여요."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3" data-testid="vendor-qna">
      <div className="flex items-center gap-2">
        {(["unanswered", "all"] as const).map((key) => (
          <Button
            key={key}
            type="button"
            variant={filter === key ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter(key)}
          >
            {key === "unanswered" ? "답변 대기" : "전체"}
          </Button>
        ))}
      </div>

      <p className="text-caption text-muted-foreground">{QNA_VENDOR_VISIBILITY_NOTE}</p>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {visible.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          답변 대기 중인 질문이 없어요.
        </p>
      ) : (
        <ul className="space-y-2">
          {visible.map((post) => (
            <li key={post.id}>
              <Card data-testid="vendor-qna-post" data-status={post.status}>
                <CardContent className="space-y-3 pt-5">
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
                    <div key={answer.id} className="rounded-md bg-secondary/60 p-2.5">
                      <p className="text-caption font-medium text-foreground">내 답변</p>
                      <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">
                        {answer.body}
                      </p>

                      <details className="mt-1">
                        <summary className="cursor-pointer text-caption text-muted-foreground">
                          답변 고치기
                        </summary>
                        <textarea
                          rows={2}
                          maxLength={QNA_BODY_MAX}
                          defaultValue={answer.body}
                          onChange={(event) =>
                            setDrafts((current) => ({ ...current, [answer.id]: event.target.value }))
                          }
                          className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                        />
                        <Button
                          type="button"
                          size="sm"
                          disabled={pending === answer.id}
                          onClick={() =>
                            void call(
                              {
                                action: "update_answer",
                                answerId: answer.id,
                                body: drafts[answer.id] ?? answer.body,
                              },
                              answer.id,
                            )
                          }
                        >
                          저장
                        </Button>
                      </details>
                    </div>
                  ))}

                  {post.status === "open" ? (
                    <div className="space-y-1.5">
                      <Label htmlFor={`answer-${post.id}`}>답변</Label>
                      <textarea
                        id={`answer-${post.id}`}
                        rows={2}
                        maxLength={QNA_BODY_MAX}
                        value={drafts[post.id] ?? ""}
                        onChange={(event) =>
                          setDrafts((current) => ({ ...current, [post.id]: event.target.value }))
                        }
                        className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                      />
                      <Button
                        type="button"
                        size="sm"
                        disabled={pending === post.id || (drafts[post.id] ?? "").trim().length < 2}
                        onClick={() =>
                          void call(
                            { action: "answer", postId: post.id, body: drafts[post.id] ?? "" },
                            post.id,
                          )
                        }
                        data-testid="submit-answer"
                      >
                        답변 등록
                      </Button>
                    </div>
                  ) : null}

                  <div className={cn("flex items-center gap-2", post.status === "open" && "pt-1")}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pending === `vis-${post.id}`}
                      onClick={() =>
                        void call(
                          {
                            action: "set_visibility",
                            postId: post.id,
                            isPublic: !post.isPublic,
                          },
                          `vis-${post.id}`,
                        )
                      }
                      data-testid="toggle-visibility"
                    >
                      {post.isPublic ? "비공개로 내리기" : "공개로 올리기"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

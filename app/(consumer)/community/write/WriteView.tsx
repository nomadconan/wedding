"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  BOARD_DESCRIPTION,
  BOARD_LABEL,
  BOARD_TYPES,
  POST_BODY_MAX_LENGTH,
  POST_TAG_MAX_COUNT,
  POST_TITLE_MAX_LENGTH,
  UNVERIFIED_NOTE,
  VENDOR_FILTER_LIMIT_NOTE,
  VENDOR_MENTION_PROMPT,
  findVendorMentions,
  postProblem,
  type BoardType,
} from "@/lib/core/community/community";

/**
 * /community/write — 글쓰기 (F-C-32·33 · 명세서 §6.2)
 *
 * **본문 필터는 막지 않고 제안한다**(D-60). 등록된 업체명이 본문에 보이면 "태그로
 * 붙이시겠어요?" 를 묻고, 사용자가 고른다 — 자동으로 지우거나 바꾸면 그것은 그 사람의
 * 글이 아니게 된다. 그리고 **완전 차단을 약속하는 문구를 쓰지 않는다**: 필터는 첫 층일
 * 뿐이고 둘째가 신고·모더레이션, 셋째가 라벨링이라는 사실을 화면이 그대로 적는다.
 *
 * **게시판 셋의 차이는 여기에 있다.** 목록은 같은 레이아웃을 쓰고(글의 모양이 같다),
 * 다른 것은 **무엇을 쓰라는 안내**와 경험담의 업체 태그 권유다.
 */
export function WriteView({ vendors }: { vendors: { id: string; name: string }[] }) {
  const router = useRouter();

  const [boardType, setBoardType] = useState<BoardType>("experience");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tagged, setTagged] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // **막는 목록이 아니라 제안이다.** 아직 태그하지 않은 것만 권한다.
  const mentions = useMemo(
    () => findVendorMentions(body, vendors).filter((mention) => !tagged.includes(mention.vendorId)),
    [body, vendors, tagged],
  );

  const problem = postProblem({ title, body, tagCount: tagged.length });

  async function submit() {
    if (problem !== null || busy) return;

    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/community/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boardType,
          title: title.trim(),
          body: body.trim(),
          vendorIds: tagged,
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "글을 올리지 못했어요.");

        return;
      }

      router.push(`/community/${payload.data.postId}`);
    } catch {
      setError("글을 올리지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="community-write">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-foreground">어디에 쓸까요</legend>
        <div className="flex gap-2">
          {BOARD_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setBoardType(type)}
              aria-pressed={boardType === type}
              className={`flex-1 rounded-md border px-3 py-2 text-sm ${
                boardType === type
                  ? "border-brand-500 text-brand-600"
                  : "border-border text-muted-foreground"
              }`}
            >
              {BOARD_LABEL[type]}
            </button>
          ))}
        </div>
        <p className="text-caption text-muted-foreground">{BOARD_DESCRIPTION[boardType]}</p>
      </fieldset>

      <label className="block space-y-1">
        <span className="text-sm font-medium text-foreground">제목</span>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={POST_TITLE_MAX_LENGTH}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          data-testid="community-title"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-sm font-medium text-foreground">내용</span>
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          maxLength={POST_BODY_MAX_LENGTH}
          rows={8}
          className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm"
          data-testid="community-body"
        />
      </label>

      {/* 제안 — **막지 않는다.** 사용자가 태그로 붙일지 정한다(D-60). */}
      {mentions.length > 0 ? (
        <section className="space-y-2 rounded-lg border border-border bg-muted p-3" data-testid="community-mention-prompt">
          <p className="text-caption text-muted-foreground">{VENDOR_MENTION_PROMPT}</p>
          <div className="flex flex-wrap gap-1.5">
            {mentions.map((mention) => (
              <Button
                key={mention.vendorId}
                type="button"
                variant="outline"
                size="sm"
                disabled={tagged.length >= POST_TAG_MAX_COUNT}
                onClick={() => setTagged((prev) => [...prev, mention.vendorId])}
              >
                {mention.name} 태그로 붙이기
              </Button>
            ))}
          </div>
        </section>
      ) : null}

      {tagged.length > 0 ? (
        <section className="space-y-1" data-testid="community-tagged">
          <p className="text-sm font-medium text-foreground">태그한 업체</p>
          <div className="flex flex-wrap gap-1.5">
            {tagged.map((vendorId) => (
              <button
                key={vendorId}
                type="button"
                onClick={() => setTagged((prev) => prev.filter((id) => id !== vendorId))}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-caption text-foreground"
              >
                {vendors.find((vendor) => vendor.id === vendorId)?.name ?? "업체"}
                <span className="text-neutral-400">×</span>
              </button>
            ))}
          </div>
          <p className="text-caption text-neutral-500">{UNVERIFIED_NOTE}</p>
        </section>
      ) : null}

      {/* **완전 차단을 약속하지 않는다**(D-60). 그 사실을 화면이 그대로 적는다. */}
      <p className="text-caption text-neutral-500" data-testid="community-filter-note">
        {VENDOR_FILTER_LIMIT_NOTE}
      </p>

      {problem !== null && (title !== "" || body !== "") ? (
        <p role="alert" className="text-sm text-warning">
          {problem.message}
        </p>
      ) : null}

      {error !== null ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <Button type="button" className="w-full" disabled={problem !== null || busy} onClick={() => void submit()}>
        {busy ? "올리는 중…" : "올리기"}
      </Button>
    </div>
  );
}

export default WriteView;

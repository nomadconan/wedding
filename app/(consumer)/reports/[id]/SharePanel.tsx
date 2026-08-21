"use client";

import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  SHARE_OWNER_NOTICE,
  SHARE_STATE_LABEL,
  remainingHours,
  type ShareState,
} from "@/lib/core/share/share";
import { cn } from "@/lib/utils";

/**
 * 리포트 공유 링크 (S7-12 · F-C-20 · 명세서 §6.2)
 *
 * S7-03 이 "공유는 S7-12" 로 남긴 자리다. 이 화면이 **기다리고 있던 진입점**이며
 * 커버리지 표의 `/reports/[id]` 행도 그렇게 적혀 있었다.
 *
 * ── 만든 사람에게만 토큰이 보인다 ───────────────────────────────────────────
 * 링크를 넘기는 일은 만든 사람이 한다. 목록에는 **주소·기한·열람 수·상태**를 보이고
 * **거두기**를 붙인다 — 잘못 보낸 순간 할 수 있는 일이 기한을 기다리는 것뿐이면
 * 그것은 통제가 아니다.
 *
 * ── 상태를 뭉뚱그리지 않는다 ────────────────────────────────────────────────
 * 살아 있음 · 만료 · 거둠을 **각각 다른 문장**으로 적는다(`SHARE_STATE_LABEL`).
 * 판정은 순수 함수가 하고 화면은 그린다.
 */
type Link = {
  id: string;
  url: string;
  expiresAt: string;
  revokedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  createdAt: string;
  state: ShareState;
};

export function SharePanel({ analysisId }: { analysisId: string }) {
  const [links, setLinks] = useState<Link[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const query = `resourceType=report&resourceId=${analysisId}`;

  useEffect(() => {
    let alive = true;

    void (async () => {
      try {
        const response = await fetch(`/api/share-links?${query}`);
        const payload = await response.json();

        if (alive && response.ok && payload.ok) setLinks(payload.data.links ?? []);
      } finally {
        if (alive) setLoaded(true);
      }
    })();

    return () => {
      alive = false;
    };
  }, [query]);

  async function refresh() {
    const response = await fetch(`/api/share-links?${query}`);
    const payload = await response.json();

    if (response.ok && payload.ok) setLinks(payload.data.links ?? []);
  }

  async function create() {
    setBusy(true);
    setNotice(null);

    try {
      const response = await fetch("/api/share-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceType: "report", resourceId: analysisId }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        // 서버 문장을 그대로 쓴다 — 기한 미설정(`SHARE_TTL_UNCONFIGURED`) 같은 사유를
        // 화면이 다시 쓰면 두 곳이 다른 말을 하게 된다.
        setNotice(payload.error?.message ?? "링크를 만들지 못했어요.");

        return;
      }

      await refresh();
      setNotice("링크를 만들었어요. 아래에서 복사해 전달해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    setNotice(null);

    try {
      const response = await fetch(`/api/share-links?id=${id}`, { method: "DELETE" });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setNotice(payload.error?.message ?? "링크를 거두지 못했어요.");

        return;
      }

      await refresh();
      setNotice("링크를 거뒀어요. 더 이상 열리지 않습니다.");
    } finally {
      setBusy(false);
    }
  }

  const now = new Date().toISOString();

  return (
    <section className="space-y-3 rounded-lg border border-border p-4" data-testid="report-share">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">공유 링크</h2>
        <Button type="button" size="sm" disabled={busy} onClick={() => void create()} data-testid="share-create">
          {busy ? "만드는 중…" : "링크 만들기"}
        </Button>
      </div>

      <p className="text-caption text-muted-foreground">{SHARE_OWNER_NOTICE}</p>

      {notice ? (
        <p role="status" className="text-caption text-foreground" data-testid="share-notice">
          {notice}
        </p>
      ) : null}

      {loaded && links.length === 0 ? (
        <p className="text-caption text-neutral-500" data-testid="share-empty">
          아직 만든 링크가 없어요.
        </p>
      ) : null}

      {links.length > 0 ? (
        <ul className="space-y-2" data-testid="share-link-list">
          {links.map((link) => {
            const left = remainingHours(link.expiresAt, now);

            return (
              <li
                key={link.id}
                className="space-y-2 rounded-lg border border-border p-3"
                data-testid="share-link"
                data-state={link.state}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={link.state === "live" ? "default" : "outline"}>
                    {SHARE_STATE_LABEL[link.state]}
                  </Badge>
                  {link.state === "live" && left !== null ? (
                    <span className="text-caption text-muted-foreground">{left}시간 남음</span>
                  ) : null}
                  <span className="text-caption text-muted-foreground">
                    {link.viewCount}번 열림
                  </span>
                </div>

                <p
                  className={cn(
                    "break-all text-caption",
                    link.state === "live" ? "text-foreground" : "text-neutral-500",
                  )}
                >
                  {link.url}
                </p>

                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      await navigator.clipboard.writeText(link.url);
                      setCopiedId(link.id);
                    }}
                  >
                    {copiedId === link.id ? "복사했어요" : "주소 복사"}
                  </Button>

                  {/* 이미 닫힌 링크에는 거두기를 두지 않는다 — 할 일이 없는 버튼이다. */}
                  {link.state === "live" ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void revoke(link.id)}
                      data-testid="share-revoke"
                    >
                      거두기
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

export default SharePanel;

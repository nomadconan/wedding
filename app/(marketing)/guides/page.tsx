import type { Metadata } from "next";
import Link from "next/link";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { Badge } from "@/components/ui/badge";
import {
  CONTENT_TYPES,
  CONTENT_TYPE_DESCRIPTION,
  CONTENT_TYPE_LABEL,
  EMPTY_TYPE_NOTICE,
} from "@/lib/core/content/content";
import { listContentByType } from "@/lib/content/loader";
import { ROBOTS_META, appUrl } from "@/lib/seo";

/**
 * /guides — SEO 콘텐츠 허브 (F-C-24 · 명세서 §6.2 · §7.1)
 *
 * **비로그인 화면이다**(§1.4 guest). 검색으로 들어오는 자리이므로 로그인 뒤에 숨기지
 * 않는다 — 숨기면 이 화면을 만든 이유가 사라진다.
 *
 * **쿠키를 읽지 않는다.** 읽는 순간 라우트가 동적이 되어 정적 생성이 무너지고,
 * SEO 대상 화면이 매 요청 렌더된다. 로그인이 필요한 도구는 **CTA 에 그 사실을 적어**
 * 알린다(상세 화면).
 *
 * **색인은 `ALLOW_INDEXING` 이 쥐고 있다**(S3-10). 여기서 따로 열지 않는다 —
 * `robots.txt` 와 이 메타가 같은 값을 보므로 둘이 어긋날 수 없다.
 */

/**
 * **Next 가 리터럴을 요구한다.** 이 값은 요율·상한 같은 운영 파라미터가 아니라
 * **캐시 신선도의 상한**이며, `app_settings` 에서 읽어 올 수 없다(빌드 시점에 정해진다).
 * 발행을 내려도 이 창 동안은 이전 목록이 나갈 수 있고 **그 사실을 알고 고른 값**이다 —
 * 공개 데이터라 권한 문제가 아니다. `db:rls` 가 두 화면의 값이 같은지 대조한다.
 */
export const revalidate = 300;

export const metadata: Metadata = {
  title: "웨딩 준비 가이드 — 웨딩클리어",
  description:
    "웨딩홀 계약, 스드메 총액, 위약금, 견적 비교. 광고 없이 사실만 적은 준비 가이드와 용어사전입니다.",
  alternates: { canonical: `${appUrl()}/guides` },
  robots: ROBOTS_META,
};

export default async function GuidesPage() {
  const grouped = await listContentByType();

  return (
    <ConsumerShell title="가이드">
      <div className="space-y-6" data-testid="guides">
        <p className="text-sm text-muted-foreground">
          광고나 제휴 없이, 계약에서 실제로 걸리는 것만 적었어요.
        </p>

        {CONTENT_TYPES.map((type) => (
          <section key={type} className="space-y-2" data-testid={`guides-${type}`}>
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-foreground">
                {CONTENT_TYPE_LABEL[type]}
              </h2>
              <p className="text-caption text-muted-foreground">
                {CONTENT_TYPE_DESCRIPTION[type]}
              </p>
            </div>

            {grouped[type].length === 0 ? (
              /* **빈 자리에 이유를 적는다.** 가격 리포트는 표본이 없어 쓰지 않았고,
                 "준비 중" 만 적으면 사용자는 우리가 게으른 줄 안다(S7-11 FIX-29 와
                 같은 규칙 — 화면이 사실대로 말한다). */
              <p
                className="rounded-lg border border-border p-3 text-caption text-muted-foreground"
                data-testid={`guides-empty-${type}`}
              >
                {EMPTY_TYPE_NOTICE[type]}
              </p>
            ) : (
              <ul className="space-y-2">
                {grouped[type].map((post) => (
                  <li key={post.slug}>
                    <Link
                      href={`/guides/${post.slug}`}
                      className="block space-y-1 rounded-lg border border-border p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-foreground">{post.title}</span>
                        <Badge variant="outline">{CONTENT_TYPE_LABEL[post.type]}</Badge>
                      </div>
                      {post.description === null ? null : (
                        <p className="text-caption text-muted-foreground">{post.description}</p>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </ConsumerShell>
  );
}

import Link from "next/link";

import type { ContentBlock, InlineNode } from "@/lib/core/content/markdown";

/**
 * 콘텐츠 본문 렌더러 (S7-10 · §6.2 `/guides/[slug]`)
 *
 * ── `dangerouslySetInnerHTML` 을 쓰지 않는다 ────────────────────────────────
 * `lib/core/content/markdown.ts` 가 본문을 **블록 구조**로 돌려주고 이 파일이 그것을
 * React 요소로 그린다. 문자열 HTML 을 만들지 않으므로 본문에 `<script>` 가 들어 있어도
 * **글자로 보일 뿐** 실행되지 않는다 — 살균기(새 의존성)가 필요 없고, 직접 만든
 * 살균기가 언젠가 뚫릴 걱정도 없다.
 *
 * ── 서버 컴포넌트다 ─────────────────────────────────────────────────────────
 * 상태가 없다. 클라이언트로 내리면 본문 전체가 번들에 실리고, 그건 SEO 화면에서
 * 가장 하기 싫은 일이다.
 *
 * 색·타이포는 DESIGN.md 토큰만 쓴다.
 */

function Inline({ nodes }: { nodes: InlineNode[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        if (node.kind === "strong") {
          return (
            <strong key={index} className="font-semibold text-foreground">
              {node.text}
            </strong>
          );
        }

        if (node.kind === "link") {
          // 파서가 **내부 경로만** 링크로 만든다. 외부 URL 은 글자로 남는다.
          return (
            <Link key={index} href={node.href} className="font-medium text-brand-600 underline">
              {node.text}
            </Link>
          );
        }

        return <span key={index}>{node.text}</span>;
      })}
    </>
  );
}

export function ContentBody({ blocks }: { blocks: ContentBlock[] }) {
  return (
    <div className="space-y-4" data-testid="content-body">
      {blocks.map((block, index) => {
        if (block.kind === "heading") {
          // **앵커를 id 로 단다.** 목차가 이 id 로 온다.
          return block.level === 2 ? (
            <h2
              key={index}
              id={block.anchor}
              className="scroll-mt-header pt-2 text-lg font-semibold text-foreground"
            >
              {block.text}
            </h2>
          ) : (
            <h3
              key={index}
              id={block.anchor}
              className="scroll-mt-header pt-1 text-base font-semibold text-foreground"
            >
              {block.text}
            </h3>
          );
        }

        if (block.kind === "paragraph") {
          return (
            <p key={index} className="text-sm leading-relaxed text-foreground">
              <Inline nodes={block.nodes} />
            </p>
          );
        }

        if (block.kind === "list") {
          const className = "space-y-1 pl-5 text-sm leading-relaxed text-foreground";

          return block.ordered ? (
            <ol key={index} className={`list-decimal ${className}`}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>
                  <Inline nodes={item} />
                </li>
              ))}
            </ol>
          ) : (
            <ul key={index} className={`list-disc ${className}`}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>
                  <Inline nodes={item} />
                </li>
              ))}
            </ul>
          );
        }

        if (block.kind === "quote") {
          return (
            <blockquote
              key={index}
              className="border-l-2 border-border pl-3 text-sm leading-relaxed text-muted-foreground"
            >
              <Inline nodes={block.nodes} />
            </blockquote>
          );
        }

        // 표는 **가로로 넘칠 수 있다.** 375px 에서 본문이 밀리지 않게 표만 스크롤한다.
        return (
          <div key={index} className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {block.head.map((cell, cellIndex) => (
                    <th
                      key={cellIndex}
                      className="px-2 py-1.5 text-left font-medium text-muted-foreground"
                    >
                      {cell}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex} className="border-b border-border/60">
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex} className="px-2 py-1.5 text-foreground">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

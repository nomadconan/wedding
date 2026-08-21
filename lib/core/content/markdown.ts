/**
 * 본문 마크다운 → **블록 구조** (S7-10 · 명세서 §2.1 F-C-24 · §6.2 `/guides/[slug]`)
 *
 * ── 왜 HTML 문자열을 만들지 않는가 ──────────────────────────────────────────
 * 마크다운을 HTML **문자열**로 바꾸면 그것을 화면에 넣는 방법은 하나뿐이다 —
 * `dangerouslySetInnerHTML`. 그러면 **살균(sanitize)이 필수**가 되고 살균기는 새
 * 의존성이다. 직접 만든 살균기는 언젠가 뚫린다.
 *
 * 그래서 이 파일은 **구조만 돌려준다.** 화면이 그 구조를 React 요소로 그리므로
 * 본문에 `<script>` 가 들어 있어도 **글자로 보일 뿐** 실행되지 않는다 —
 * XSS 표면 자체가 없다. 새 의존성도 필요 없다.
 *
 * ── 지원하는 문법과 지원하지 않는 문법 ─────────────────────────────────────
 * **지원** — `##`·`###` 제목 · 문단 · `-` 목록 · `1.` 번호 목록 · `>` 인용 ·
 * 표(`|`) · `**굵게**` · `[글자](경로)` 링크.
 *
 * **지원하지 않음** — 이미지·HTML 삽입·코드 펜스·각주. 넣지 않은 이유는 각각
 * 다르다: 이미지는 `lib/assets/manifest.ts` 가 관리하는 자산이라 본문이 임의 경로를
 * 가리키면 안 되고, HTML 삽입은 위 문단의 전제를 무너뜨리며, 코드 펜스는 이
 * 제품의 글에 나올 일이 없다. **지원하지 않는 문법은 무시하지 않고 문단 글자
 * 그대로 보인다** — 조용히 사라지면 글쓴이는 자기가 쓴 문장이 어디 갔는지 모른다.
 *
 * ── 링크는 내부 경로만 ─────────────────────────────────────────────────────
 * 외부 링크를 허용하지 않는다. 우리 글에서 나가는 링크는 **우리 도구**로 가야 하고
 * (§2.1 "콘텐츠 → 도구 전환"), 외부로 나가는 순간 `rel`·새 창·추적 같은 판단이
 * 줄줄이 붙는다. 외부 URL 은 **링크가 아니라 글자로** 남긴다.
 */

export type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "link"; text: string; href: string };

export type ContentBlock =
  | { kind: "heading"; level: 2 | 3; text: string; anchor: string }
  | { kind: "paragraph"; nodes: InlineNode[] }
  | { kind: "list"; ordered: boolean; items: InlineNode[][] }
  | { kind: "quote"; nodes: InlineNode[] }
  | { kind: "table"; head: string[]; rows: string[][] };

// =============================================================================
// 인라인
// =============================================================================

const STRONG = /\*\*([^*]+)\*\*/;
const LINK = /\[([^\]]+)\]\(([^)]+)\)/;

/** **내부 경로만 링크가 된다.** `/` 로 시작하고 `//`(프로토콜 상대)가 아닌 것. */
export function isInternalHref(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}

/**
 * 한 줄을 인라인 노드로 쪼갠다.
 *
 * 굵게와 링크만 본다. **겹치면 먼저 나오는 것이 이긴다** — 중첩을 지원하지 않는
 * 이유는 `[**글자**](/경로)` 같은 조합을 위해 파서를 재귀로 만들 만큼 이 제품의
 * 글이 복잡하지 않기 때문이다. 필요해지면 그때 넓힌다.
 */
export function parseInline(line: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let rest = line;

  while (rest.length > 0) {
    const strong = STRONG.exec(rest);
    const link = LINK.exec(rest);

    const strongAt = strong?.index ?? Infinity;
    const linkAt = link?.index ?? Infinity;

    if (strongAt === Infinity && linkAt === Infinity) {
      nodes.push({ kind: "text", text: rest });
      break;
    }

    const at = Math.min(strongAt, linkAt);
    if (at > 0) nodes.push({ kind: "text", text: rest.slice(0, at) });

    if (strongAt <= linkAt && strong) {
      nodes.push({ kind: "strong", text: strong[1] });
      rest = rest.slice(strongAt + strong[0].length);
      continue;
    }

    if (link) {
      const href = link[2].trim();

      // 외부 링크는 **글자로 남긴다.** 지우면 글쓴이가 쓴 문장이 사라진다.
      nodes.push(
        isInternalHref(href)
          ? { kind: "link", text: link[1], href }
          : { kind: "text", text: link[0] },
      );
      rest = rest.slice(linkAt + link[0].length);
    }
  }

  return nodes.filter((node) => node.kind !== "text" || node.text.length > 0);
}

// =============================================================================
// 앵커
// =============================================================================

/**
 * 제목 → 목차 앵커.
 *
 * **한글을 그대로 둔다.** 로마자로 옮기면 같은 발음의 다른 제목이 같은 앵커가 되고,
 * 지우면 앵커가 전부 `section-1` 같은 번호가 되어 URL 이 글의 내용을 말하지 않는다.
 * 브라우저·검색엔진 모두 퍼센트 인코딩된 한글 조각을 다룬다.
 */
export function anchorOf(text: string): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[^0-9a-z가-힣\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return base.length > 0 ? base : "section";
}

/** 같은 제목이 두 번 나오면 뒤엣것에 번호를 붙인다 — 목차 링크가 겹치면 안 된다. */
function uniqueAnchor(text: string, used: Map<string, number>): string {
  const base = anchorOf(text);
  const seen = used.get(base) ?? 0;

  used.set(base, seen + 1);

  return seen === 0 ? base : `${base}-${seen + 1}`;
}

// =============================================================================
// 블록
// =============================================================================

const HEADING = /^(#{2,3})\s+(.*)$/;
const UL = /^[-*]\s+(.*)$/;
const OL = /^\d+\.\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;

function splitRow(line: string): string[] {
  return line
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** 표의 구분선(`|---|---|`)인가. */
function isDivider(line: string): boolean {
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line.trim());
}

/**
 * 본문 전체를 블록으로.
 *
 * **`#`(h1)을 블록으로 만들지 않는다.** 한 화면의 h1 은 글 제목 하나여야 하고 그것은
 * `content_posts.title` 이 갖는다. 본문에 h1 이 또 나오면 문서 구조가 깨지고 검색엔진이
 * 무엇이 제목인지 판단하지 못한다 — 본문의 `#` 는 `##` 로 낮춰 받는다.
 */
export function parseMarkdown(source: string | null): ContentBlock[] {
  if (source === null) return [];

  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ContentBlock[] = [];
  const used = new Map<string, number>();

  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;

    blocks.push({ kind: "paragraph", nodes: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      flushParagraph();
      continue;
    }

    // 제목 — `#` 하나짜리도 받되 **h2 로 낮춘다**(위 주석).
    const heading = HEADING.exec(trimmed) ?? /^(#)\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();

      const text = heading[2].trim();
      blocks.push({
        kind: "heading",
        level: heading[1].length === 3 ? 3 : 2,
        text,
        anchor: uniqueAnchor(text, used),
      });
      continue;
    }

    // 표 — 머리줄 + 구분선이 이어질 때만 표로 본다.
    if (trimmed.startsWith("|") && isDivider(lines[i + 1]?.trim() ?? "")) {
      flushParagraph();

      const head = splitRow(trimmed);
      const rows: string[][] = [];

      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(splitRow(lines[i].trim()));
        i += 1;
      }
      i -= 1;

      blocks.push({ kind: "table", head, rows });
      continue;
    }

    // 목록 — 같은 종류가 이어지는 동안 한 블록이다.
    const ul = UL.exec(trimmed);
    const ol = OL.exec(trimmed);
    if (ul || ol) {
      flushParagraph();

      const ordered = ol !== null;
      const items: InlineNode[][] = [parseInline((ol ?? ul)![1])];

      while (i + 1 < lines.length) {
        const next = lines[i + 1].trim();
        const nextMatch = ordered ? OL.exec(next) : UL.exec(next);

        if (!nextMatch) break;

        items.push(parseInline(nextMatch[1]));
        i += 1;
      }

      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    const quote = QUOTE.exec(trimmed);
    if (quote) {
      flushParagraph();
      blocks.push({ kind: "quote", nodes: parseInline(quote[1]) });
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();

  return blocks;
}

// =============================================================================
// 목차
// =============================================================================

export type TocEntry = { level: 2 | 3; text: string; anchor: string };

/**
 * 목차.
 *
 * **제목이 둘 미만이면 목차를 만들지 않는다.** 항목 하나짜리 목차는 정보가 아니라
 * 장식이고, 375px 화면에서 본문을 한 번 더 밀어낸다.
 */
export const TOC_MIN_HEADINGS = 2;

export function tableOfContents(blocks: ContentBlock[]): TocEntry[] {
  const headings = blocks.filter(
    (block): block is Extract<ContentBlock, { kind: "heading" }> => block.kind === "heading",
  );

  if (headings.length < TOC_MIN_HEADINGS) return [];

  return headings.map(({ level, text, anchor }) => ({ level, text, anchor }));
}

/**
 * 본문 요약 — 메타 설명이 비었을 때 쓴다.
 *
 * **첫 문단의 글자만** 쓴다. 제목·목록·표를 섞으면 검색 결과에 조각난 문장이 뜬다.
 * 잘릴 때는 말줄임을 붙여 **잘렸다는 사실을 보이게** 한다.
 */
export function excerpt(blocks: ContentBlock[], limit = 140): string | null {
  const first = blocks.find(
    (block): block is Extract<ContentBlock, { kind: "paragraph" }> => block.kind === "paragraph",
  );

  if (first === undefined) return null;

  const text = first.nodes.map((node) => node.text).join("").trim();
  if (text.length === 0) return null;

  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

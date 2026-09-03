// =============================================================================
// app/ 라우트 열거 (S0-04)
// -----------------------------------------------------------------------------
// `audit-routes.mjs`(정적 대조)와 `audit-runtime.mjs`(실제 열기)가 **같은 목록**을
// 봐야 한다. 각자 세면 두 표의 분모가 갈리고, 그것이 애초에 S0-04 가 생긴 이유다.
// =============================================================================
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** `app/(consumer)/cart/page.tsx` -> `/cart`. 라우트 그룹 `(x)` 는 URL 에 없다. */
export function fileToRoute(root, file) {
  const parts = relative(join(root, "app"), join(root, file)).split(sep);
  parts.pop();
  const segs = parts.filter((p) => !(p.startsWith("(") && p.endsWith(")")));
  return "/" + segs.join("/");
}

/** 동적 세그먼트 이름 차이를 지운 '모양'. `[id]` 와 `[bookingId]` 는 같은 라우트다. */
export const shape = (r) => r.replace(/\[[^\]]+\]/g, "[*]").replace(/\/$/, "") || "/";

export function listRoutes(root) {
  const files = walk(join(root, "app")).map((f) => relative(root, f).split(sep).join("/"));
  const pages = files
    .filter((f) => f.endsWith("/page.tsx") || f === "app/page.tsx")
    .map((f) => ({ route: fileToRoute(root, f), file: f }))
    .sort((a, b) => a.route.localeCompare(b.route));
  const apis = files
    .filter((f) => f.endsWith("/route.ts"))
    .map((f) => ({ route: fileToRoute(root, f), file: f }))
    .sort((a, b) => a.route.localeCompare(b.route));
  return { pages, apis, files };
}

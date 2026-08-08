import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * lib/core 는 프레임워크 무관이어야 한다 (CLAUDE.md §3.1).
 *
 * Expo 전환 시 lib/core 를 패키지로 승격해 그대로 재사용하는 것이 전제이므로,
 * React/Next 를 import 하는 순간 그 전제가 깨진다. ESLint 규칙과 별개로
 * `npm run test` 에서도 깨지게 만들어 둔다.
 */
const CORE_DIR = join(__dirname);

const BANNED_MODULES = [
  "react",
  "react-dom",
  "next",
  "next/navigation",
  "next/headers",
  "next/server",
  "@supabase/supabase-js",
  "@supabase/ssr",
  "@anthropic-ai/sdk",
];

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }

    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }

  return files;
}

/** import/require 로 끌어오는 모듈 지정자를 뽑는다. */
function extractModuleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bimport\s+(?:[\s\S]*?)\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      specifiers.push(match[1]);
    }
  }

  return specifiers;
}

describe("lib/core 프레임워크 독립성", () => {
  const files = collectSourceFiles(CORE_DIR);

  it("스캔 대상 소스 파일이 존재한다", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("React/Next/DB/AI SDK 를 import 하지 않는다", () => {
    const violations: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");

      for (const specifier of extractModuleSpecifiers(source)) {
        if (BANNED_MODULES.includes(specifier) || specifier.startsWith("next/")) {
          violations.push(`${file} → ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("lib/core 밖의 모듈을 상대 경로로 끌어오지 않는다 (types 제외)", () => {
    const violations: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");

      for (const specifier of extractModuleSpecifiers(source)) {
        if (!specifier.startsWith(".")) continue;

        const resolved = join(file, "..", specifier);
        if (!resolved.startsWith(CORE_DIR)) {
          violations.push(`${file} → ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("도메인 로직이 console 을 호출하지 않는다 (원문·마스킹 맵 유출 방지)", () => {
    const violations: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      // 주석 안의 언급은 제외하고 실제 호출만 본다.
      const withoutComments = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");

      if (/\bconsole\s*\./.test(withoutComments)) {
        violations.push(file);
      }
    }

    expect(violations).toEqual([]);
  });
});

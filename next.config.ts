import type { NextConfig } from "next";

/**
 * Next 설정.
 *
 * **`.mjs` 에서 옮겨 왔다(FIX-61 · next 15 판올림).** 이전 파일은
 * "Next.js 14 는 next.config.ts 를 지원하지 않는다(Next 15+ 기능)" 라고 적고 타입 힌트를
 * JSDoc 으로 우회하고 있었다. **그 우회의 이유가 사라졌다** — 낡은 우회를 남겨 두면
 * 다음 사람이 그것을 제약으로 읽는다.
 */
const nextConfig: NextConfig = {
  // 이미지 원격 도메인은 Supabase Storage 도메인 확정 후 추가
  experimental: {},
};

export default nextConfig;

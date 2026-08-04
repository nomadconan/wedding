// Next.js 14 는 next.config.ts 를 지원하지 않는다(Next 15+ 기능).
// 타입 힌트는 JSDoc 으로 유지한다.
/** @type {import('next').NextConfig} */
const nextConfig = {
  // 이미지 원격 도메인은 Supabase Storage 도메인 확정 후 추가
  experimental: {},
};

export default nextConfig;

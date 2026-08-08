import type { Metadata } from "next";
import { Suspense } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/LoadingState";

import { LoginForm } from "./LoginForm";

export const metadata: Metadata = {
  title: "로그인 — 웨딩클리어",
};

/**
 * /login (§6.1)
 *
 * 소셜 4종은 S3-01 에서 붙인다. 이번 태스크(S2-01)에서는 업체 신청자가 들어올
 * 이메일·비밀번호 경로만 만든다.
 */
export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted px-gutter py-12">
      <Card className="w-full max-w-consumer">
        <CardHeader>
          <CardTitle className="text-display-sm">웨딩클리어</CardTitle>
          <CardDescription>
            투명 가격 웨딩 직거래 플랫폼. 업체 입점 신청도 여기서 시작합니다.
          </CardDescription>
        </CardHeader>

        <CardContent>
          {/* useSearchParams 를 쓰는 클라이언트 폼이라 Suspense 경계가 필요하다. */}
          <Suspense fallback={<LoadingState variant="block" />}>
            <LoginForm />
          </Suspense>
        </CardContent>
      </Card>
    </main>
  );
}

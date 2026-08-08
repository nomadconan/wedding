"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/ErrorState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";

/**
 * 이메일·비밀번호 로그인 (S2-01)
 *
 * 소셜 로그인(카카오/네이버/구글/애플)은 **S3-01 소비자 온보딩**에서 붙인다.
 * 여기서는 업체 신청자가 들어올 수 있는 최소 경로만 만든다 —
 * 로그인이 없으면 입점 신청 자체가 성립하지 않기 때문이다.
 *
 * 세션은 `@supabase/ssr` 브라우저 클라이언트가 **쿠키**에 넣는다.
 * 그래서 서버 컴포넌트·미들웨어·Route Handler 가 같은 세션을 그대로 읽는다.
 */
type Mode = "signin" | "signup";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get("next") ?? "/vendor/apply";
  const denied = searchParams.get("denied") === "1";

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNotice(null);

    const supabase = createClient();

    try {
      if (mode === "signup") {
        const { data, error: signUpError } = await supabase.auth.signUp({ email, password });
        if (signUpError) throw signUpError;

        if (!data.session) {
          // 이메일 확인이 켜진 환경. 확인 메일을 받고 다시 로그인해야 한다.
          setNotice("확인 메일을 보냈어요. 메일에서 인증한 뒤 로그인해 주세요.");
          setMode("signin");

          return;
        }

        // 프로필 행은 가입 직후 한 번만 만든다. 역할 기본값은 consumer 이며
        // 운영자 승격은 DB(운영자 콘솔·S8) 쪽에서만 한다.
        await supabase
          .from("profiles")
          .upsert(
            { user_id: data.session.user.id, display_name: displayName || null },
            { onConflict: "user_id" },
          );
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
      }

      router.push(nextPath);
      router.refresh();
    } catch (caught) {
      // 서버 예외 메시지를 그대로 보여주지 않는다(CLAUDE.md §5.3).
      const message =
        caught instanceof Error && caught.message.includes("Invalid login credentials")
          ? "이메일 또는 비밀번호가 올바르지 않습니다."
          : "로그인에 실패했어요. 잠시 후 다시 시도해 주세요.";

      setError(message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-5">
      {denied ? (
        <ErrorState
          title="접근 권한이 없어요"
          description="운영자 계정으로 로그인해 주세요."
          code="AUTH_FORBIDDEN"
          className="py-6"
        />
      ) : null}

      <form onSubmit={handleSubmit} className="space-y-4" data-testid="login-form">
        {mode === "signup" ? (
          <div className="space-y-1.5">
            <Label htmlFor="login-name">이름</Label>
            <Input
              id="login-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="담당자 이름"
              autoComplete="name"
            />
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="login-email">이메일</Label>
          <Input
            id="login-email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="login-password">비밀번호</Label>
          <Input
            id="login-password"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="8자 이상"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
          />
        </div>

        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}

        {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}

        <Button type="submit" size="touch" className="w-full" disabled={pending}>
          {pending ? "처리 중…" : mode === "signup" ? "가입하고 시작하기" : "로그인"}
        </Button>
      </form>

      <div className="text-center">
        <Button
          type="button"
          variant="link"
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setError(null);
            setNotice(null);
          }}
        >
          {mode === "signin" ? "처음이신가요? 회원가입" : "이미 계정이 있어요"}
        </Button>
      </div>
    </div>
  );
}

export default LoginForm;

"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/ErrorState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { landingForRole } from "@/lib/core/auth/landing";
import {
  type LoginErrorView,
  classifyLoginError,
  withLoginTimeout,
} from "@/lib/core/auth/login-error";
import { createClient } from "@/lib/supabase/client";

/**
 * 이메일·비밀번호 로그인 (S2-01) + 소셜 로그인 자리 (S3-01)
 *
 * 소셜 4종(카카오·네이버·구글·애플)은 **콜백 라우트와 버튼까지만** 만들어 두고
 * `NEXT_PUBLIC_SOCIAL_AUTH_ENABLED` 로 노출을 제어한다. provider 키 발급·등록은
 * 코드가 아니라 계정 작업이라 별도 태스크(S3-01b)로 분리했다 —
 * "만들어 두고 켜지 않는다"(CLAUDE.md §2.1).
 *
 * 세션은 `@supabase/ssr` 브라우저 클라이언트가 **쿠키**에 넣는다.
 * 그래서 서버 컴포넌트·미들웨어·Route Handler 가 같은 세션을 그대로 읽는다.
 */
type Mode = "signin" | "signup";

/** §2.1 이 요구하는 소셜 4종. 켜기 전까지 버튼은 비활성이다. */
const SOCIAL_PROVIDERS = [
  { id: "kakao", label: "카카오" },
  { id: "naver", label: "네이버" },
  { id: "google", label: "구글" },
  { id: "apple", label: "애플" },
] as const;

const SOCIAL_ENABLED = process.env.NEXT_PUBLIC_SOCIAL_AUTH_ENABLED === "true";

/**
 * 역할별 착지 지점.
 *
 * 프로필 행이 아직 없으면(가입 직후 upsert 전이거나 실패) 소비자로 본다 —
 * `profiles.role` 기본값이 consumer 이고, 잘못 보내더라도 운영자·업체 화면은
 * 각자의 가드가 다시 막는다. 최종 경계는 RLS 다(§1.4 NOTE).
 */
async function landingFor(supabase: ReturnType<typeof createClient>): Promise<string> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return "/home";

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  return landingForRole(profile?.role ?? null);
}

/**
 * 세션 쿠키가 **실제로 보일 때까지** 기다린다.
 *
 * `signInWithPassword` 가 resolve 해도 `@supabase/ssr` 브라우저 클라이언트가
 * `document.cookie` 를 쓰는 것은 그 다음 tick 이다. 그 사이에 `router.push` 를 하면
 * RSC 요청이 **쿠키 없이** 나가고 미들웨어가 미인증으로 보아 `/login` 으로 되돌린다 —
 * 사용자에게는 "로그인했는데 로그인 화면으로 튕긴다" 로 보인다(FIX-24 계열).
 *
 * 못 기다려도 이동은 막지 않는다. 여기서 멈추면 고칠 수 있는 상황까지 못 넘어간다.
 */
async function waitForSessionCookie(
  supabase: ReturnType<typeof createClient>,
  attempts = 20,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    const { data } = await supabase.auth.getSession();
    // 쿠키 이름은 URL 에서 파생돼 환경마다 다르다. 이름 대신 `sb-` 접두어만 본다.
    if (data.session && document.cookie.includes("sb-")) return;

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  /**
   * `next` 가 있으면 그리로 간다(보호 경로에서 튕겨 온 경우).
   * 없으면 **역할에 따라** 정한다 — S3-11 이전에는 업체 화면뿐이라 `/vendor/apply` 로
   * 고정돼 있었고, 소비자가 로그인하면 자기와 무관한 입점 신청 화면에 떨어졌다.
   */
  const nextPath = searchParams.get("next");
  const denied = searchParams.get("denied") === "1";

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<LoginErrorView | null>(null);
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
        // 제한 시간을 건다. 이것이 없으면 인증 서버가 죽었을 때 auth-js 가 30초 동안
        // 조용히 재시도하고 화면은 "처리 중…" 에 멈춘 채 아무 문구도 내지 않는다 —
        // FIX-24 를 진단 불가로 만든 구간이다.
        const { error: signInError } = await withLoginTimeout(
          supabase.auth.signInWithPassword({ email, password }),
        );
        if (signInError) throw signInError;
      }

      // 세션이 **쿠키로 실제로 보이는지** 확인한 뒤에 이동한다. 브라우저 클라이언트가
      // 쿠키를 쓰기 전에 이동하면 미들웨어가 그 요청을 미인증으로 보고 /login 으로
      // 되돌린다 — 로그인은 됐는데 로그인 화면으로 튕기는 것처럼 보인다.
      await waitForSessionCookie(supabase);

      router.push(nextPath ?? (await landingFor(supabase)));
      router.refresh();
    } catch (caught) {
      // 서버 예외 메시지를 그대로 보여주지 않는다(CLAUDE.md §5.3).
      // 대신 실패한 **계층**을 고른다 — 자격증명 문제와 인프라 문제는 할 일이 다르다.
      setError(classifyLoginError(caught));
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
          <div role="alert" className="space-y-1">
            <p className="text-sm text-danger">{error.message}</p>
            {/*
              환경 문제일 때 힌트를 함께 낸다. "비밀번호가 틀렸나" 를 30분 더
              들여다보게 만드는 것이 FIX-24 의 실제 비용이었다.
            */}
            <p className="text-caption text-muted-foreground">{error.hint}</p>
            <p className="text-caption text-muted-foreground">코드: {error.code}</p>
          </div>
        ) : null}

        {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}

        <Button type="submit" size="touch" className="w-full" disabled={pending}>
          {pending ? "처리 중…" : mode === "signup" ? "가입하고 시작하기" : "로그인"}
        </Button>
      </form>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="h-px flex-1 bg-border" />
          <span className="text-caption text-muted-foreground">또는</span>
          <span className="h-px flex-1 bg-border" />
        </div>

        <div className="grid grid-cols-2 gap-2" data-testid="social-buttons">
          {SOCIAL_PROVIDERS.map((provider) => (
            <Button
              key={provider.id}
              type="button"
              variant="outline"
              disabled={!SOCIAL_ENABLED || pending}
              onClick={async () => {
                const supabase = createClient();
                await supabase.auth.signInWithOAuth({
                  provider: provider.id as "google",
                  options: {
                    // 소셜은 콜백에서 돌아오므로 역할을 아직 모른다. `next` 가 없으면 홈으로
                    // 보내고, 업체·운영자는 각 화면의 가드가 다시 자기 자리로 돌린다.
                    redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextPath ?? "/home")}`,
                  },
                });
              }}
            >
              {provider.label}
            </Button>
          ))}
        </div>

        {SOCIAL_ENABLED ? null : (
          <p className="text-center text-caption text-muted-foreground">
            소셜 로그인은 준비 중이에요. 지금은 이메일로 시작해 주세요.
          </p>
        )}
      </div>

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

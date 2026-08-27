import { describe, expect, it } from "vitest";

import {
  LOGIN_TIMEOUT_MS,
  LoginTimeoutError,
  classifyLoginError,
  withLoginTimeout,
} from "./login-error";

/** auth-js 가 실제로 던지는 모양을 흉내낸다. */
function authApiError(message: string, status: number, code?: string) {
  const error = new Error(message) as Error & { status: number; code?: string };
  error.name = "AuthApiError";
  error.status = status;
  if (code) error.code = code;

  return error;
}

describe("classifyLoginError — 자격증명", () => {
  it("잘못된 자격증명은 환경 문제가 아니다", () => {
    const view = classifyLoginError(authApiError("Invalid login credentials", 400, "invalid_credentials"));

    expect(view.code).toBe("AUTH_INVALID_CREDENTIALS");
    expect(view.isEnvironment).toBe(false);
  });

  it("code 없이 message 만 와도 잡는다 (auth-js 구버전)", () => {
    expect(classifyLoginError(authApiError("Invalid login credentials", 400)).code).toBe(
      "AUTH_INVALID_CREDENTIALS",
    );
  });

  it("이메일 미확인은 따로 안내한다", () => {
    expect(classifyLoginError(authApiError("Email not confirmed", 400, "email_not_confirmed")).code).toBe(
      "AUTH_EMAIL_NOT_CONFIRMED",
    );
  });

  it("429 는 재시도 안내다", () => {
    expect(classifyLoginError(authApiError("rate limit exceeded", 429)).code).toBe("AUTH_RATE_LIMITED");
  });

  it("계정 존재 여부를 드러내지 않는다 — 없는 계정도 같은 코드다", () => {
    const missing = classifyLoginError(authApiError("Invalid login credentials", 400, "invalid_credentials"));
    const wrongPassword = classifyLoginError(
      authApiError("Invalid login credentials", 400, "invalid_credentials"),
    );

    expect(missing).toEqual(wrongPassword);
  });
});

describe("classifyLoginError — 환경 (FIX-24 가 밟은 자리)", () => {
  // Kong 은 상류 GoTrue 가 죽으면 500·502·503 중 하나를 돌려준다. 셋 다 같은 뜻이다.
  it.each([500, 502, 503, 504])("%i 는 인증 서버 문제로 분류한다", (status) => {
    const view = classifyLoginError(authApiError("server error", status));

    expect(view.code).toBe("AUTH_SERVICE_UNAVAILABLE");
    expect(view.isEnvironment).toBe(true);
    expect(view.hint).toContain("비밀번호 문제가 아닙니다");
  });

  it("네트워크 실패(status 0)도 인증 서버 문제다", () => {
    expect(classifyLoginError(authApiError("Failed to fetch", 0)).code).toBe("AUTH_SERVICE_UNAVAILABLE");
  });

  it("AuthRetryableFetchError 를 이름으로 알아본다", () => {
    const error = new Error("Failed to fetch");
    error.name = "AuthRetryableFetchError";

    expect(classifyLoginError(error).code).toBe("AUTH_SERVICE_UNAVAILABLE");
  });

  it("맨 TypeError: Failed to fetch 도 잡는다", () => {
    expect(classifyLoginError(new TypeError("Failed to fetch")).code).toBe("AUTH_SERVICE_UNAVAILABLE");
  });

  it("401/403 은 자격증명이 아니라 키 설정 문제다", () => {
    expect(classifyLoginError(authApiError("Invalid API key", 401)).code).toBe("AUTH_CONFIG");
    expect(classifyLoginError(authApiError("No API key found in request", 403)).code).toBe("AUTH_CONFIG");
  });

  it("타임아웃은 status 가 없어도 타임아웃이다", () => {
    const view = classifyLoginError(new LoginTimeoutError());

    expect(view.code).toBe("AUTH_TIMEOUT");
    expect(view.isEnvironment).toBe(true);
  });
});

describe("classifyLoginError — 경계", () => {
  it("모르는 실패는 일반 문구로 떨어진다", () => {
    const view = classifyLoginError(new Error("something else"));

    expect(view.code).toBe("AUTH_UNKNOWN");
    expect(view.isEnvironment).toBe(false);
  });

  it.each([null, undefined, "", 0, {}])("%s 를 던져도 죽지 않는다", (thrown) => {
    expect(classifyLoginError(thrown).code).toBe("AUTH_UNKNOWN");
  });

  it("서버 문장을 그대로 노출하지 않는다 (CLAUDE.md §5.3)", () => {
    const leaky = authApiError("pq: relation auth.users does not exist at /var/lib/secret", 500);

    expect(classifyLoginError(leaky).message).not.toContain("auth.users");
    expect(classifyLoginError(leaky).hint).not.toContain("/var/lib");
  });

  it("모든 코드가 문구와 힌트를 갖는다", () => {
    const codes = [
      authApiError("Invalid login credentials", 400),
      authApiError("Email not confirmed", 400),
      authApiError("rate limit", 429),
      authApiError("boom", 503),
      authApiError("Invalid API key", 401),
      new LoginTimeoutError(),
      new Error("?"),
    ];

    for (const error of codes) {
      const view = classifyLoginError(error);
      expect(view.message.length).toBeGreaterThan(0);
      expect(view.hint.length).toBeGreaterThan(0);
    }
  });
});

describe("withLoginTimeout", () => {
  it("제한 시간 안에 끝나면 그대로 통과시킨다", async () => {
    await expect(withLoginTimeout(Promise.resolve("ok"), 50)).resolves.toBe("ok");
  });

  it("원래 오류는 원래 오류대로 올린다", async () => {
    await expect(withLoginTimeout(Promise.reject(new Error("nope")), 50)).rejects.toThrow("nope");
  });

  it("시간을 넘기면 LoginTimeoutError 다", async () => {
    const never = new Promise(() => {});

    await expect(withLoginTimeout(never, 20)).rejects.toBeInstanceOf(LoginTimeoutError);
  });

  it("기본 제한 시간은 auth-js 의 30초 재시도보다 짧다", () => {
    expect(LOGIN_TIMEOUT_MS).toBeLessThan(30_000);
  });
});

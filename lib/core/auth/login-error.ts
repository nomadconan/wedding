/**
 * 로그인 실패 분류 (FIX-24)
 *
 * **왜 이 파일이 생겼나.** FIX-24 는 "시드 계정으로 로그인이 되지 않는다" 였는데
 * **화면에 뜨는 오류 문구를 아무도 확보하지 못해** 몇 주 동안 원인이 좁혀지지 않았다.
 * 확보하지 못한 이유는 사람이 게을러서가 아니라 **코드가 문구를 만들지 않았기 때문**이다:
 *
 *   1. 로그인 POST 는 브라우저에서 **Supabase 로 직접** 나간다. Next 서버를 지나지
 *      않으므로 Route Handler·미들웨어 로그에는 **아무것도 남지 않는다.**
 *      (TASKS.md 가 찾던 "서버 로그" 는 원래 존재할 수 없었다.)
 *   2. GoTrue 가 죽어 502/503 을 돌려주면 auth-js 가 **약 30초 동안 조용히 재시도**한다.
 *      그 사이 화면은 "처리 중…" 에서 멈춘 채 **`[role=alert]` 이 비어 있다.**
 *   3. 30초 뒤에 겨우 뜨는 문구가 비밀번호가 틀렸을 때와 **완전히 같은 한 줄**이라,
 *      본 사람은 자격증명을 의심하고 인프라를 보지 않는다.
 *
 * 그래서 판정을 화면에서 꺼내 순수 함수로 고정한다(CLAUDE.md 공통 제약).
 * 이 함수는 **서버가 준 문장을 그대로 보여주지 않는다** — 실패의 *계층*만 고른다.
 * 어느 계정이 존재하는지는 여전히 알려주지 않는다(계정 열거 방지).
 */

/** 도메인 접두어 `AUTH_` 를 쓴다(CLAUDE.md §6). */
export type LoginErrorCode =
  | "AUTH_INVALID_CREDENTIALS"
  | "AUTH_EMAIL_NOT_CONFIRMED"
  | "AUTH_RATE_LIMITED"
  | "AUTH_SERVICE_UNAVAILABLE"
  | "AUTH_TIMEOUT"
  | "AUTH_CONFIG"
  | "AUTH_UNKNOWN";

export type LoginErrorView = {
  code: LoginErrorCode;
  /** 사용자에게 보여줄 한 줄. */
  message: string;
  /**
   * 사용자가 **다음에 할 일**. 자격증명 문제와 인프라 문제는 할 일이 다르다 —
   * 이것이 없어서 FIX-24 가 자격증명 문제로 오해됐다.
   */
  hint: string;
  /** 자격증명이 아니라 **환경**의 문제인가. 화면이 안내 톤을 바꾸는 데 쓴다. */
  isEnvironment: boolean;
};

/**
 * auth-js 가 던지는 오류의 모양은 버전마다 다르다. 필요한 것만 좁게 읽는다.
 * (`AuthApiError` 는 `status`·`code`, `AuthRetryableFetchError` 는 `status: 0` 이거나
 *  `TypeError: Failed to fetch` 가 그대로 올라온다.)
 */
type AuthLike = {
  message?: unknown;
  status?: unknown;
  code?: unknown;
  name?: unknown;
};

function read(caught: unknown): { message: string; status: number | null; code: string; name: string } {
  const e = (caught ?? {}) as AuthLike;

  return {
    message: typeof e.message === "string" ? e.message : "",
    status: typeof e.status === "number" ? e.status : null,
    code: typeof e.code === "string" ? e.code : "",
    name: typeof e.name === "string" ? e.name : "",
  };
}

const VIEWS: Record<LoginErrorCode, Omit<LoginErrorView, "code">> = {
  AUTH_INVALID_CREDENTIALS: {
    message: "이메일 또는 비밀번호가 올바르지 않습니다.",
    hint: "입력을 다시 확인해 주세요.",
    isEnvironment: false,
  },
  AUTH_EMAIL_NOT_CONFIRMED: {
    message: "이메일 인증이 아직 끝나지 않았어요.",
    hint: "받은 메일의 인증 링크를 먼저 눌러 주세요.",
    isEnvironment: false,
  },
  AUTH_RATE_LIMITED: {
    message: "시도가 너무 잦아 잠시 막혔어요.",
    hint: "1분쯤 뒤에 다시 시도해 주세요.",
    isEnvironment: false,
  },
  AUTH_SERVICE_UNAVAILABLE: {
    message: "인증 서버에 연결하지 못했어요.",
    hint: "비밀번호 문제가 아닙니다. 인증 서비스가 응답하지 않습니다.",
    isEnvironment: true,
  },
  AUTH_TIMEOUT: {
    message: "인증 서버가 제한 시간 안에 응답하지 않았어요.",
    hint: "비밀번호 문제가 아닙니다. 잠시 후 다시 시도해 주세요.",
    isEnvironment: true,
  },
  AUTH_CONFIG: {
    message: "인증 설정이 올바르지 않아요.",
    hint: "비밀번호 문제가 아닙니다. 접속 주소와 키 설정을 확인해야 합니다.",
    isEnvironment: true,
  },
  AUTH_UNKNOWN: {
    message: "로그인에 실패했어요.",
    hint: "잠시 후 다시 시도해 주세요.",
    isEnvironment: false,
  },
};

/**
 * 실패를 계층으로 분류한다.
 *
 * 순서가 중요하다 — 자격증명 판정을 **먼저** 확정하고, 그 다음에 5xx·네트워크를 본다.
 * 반대로 두면 GoTrue 가 400 을 주는 정상적인 "비밀번호 틀림" 이 환경 문제로 보인다.
 */
export function classifyLoginError(caught: unknown): LoginErrorView {
  const { message, status, code, name } = read(caught);
  const text = message.toLowerCase();

  const code_ = ((): LoginErrorCode => {
    // 1) 자격증명 — GoTrue 는 이메일이 없든 비밀번호가 틀리든 같은 응답을 준다.
    //    그 구분을 여기서 되살리지 않는다(계정 열거 방지).
    if (code === "invalid_credentials" || text.includes("invalid login credentials")) {
      return "AUTH_INVALID_CREDENTIALS";
    }
    if (code === "email_not_confirmed" || text.includes("email not confirmed")) {
      return "AUTH_EMAIL_NOT_CONFIRMED";
    }
    if (status === 429 || code === "over_request_rate_limit" || text.includes("rate limit")) {
      return "AUTH_RATE_LIMITED";
    }

    // 2) 우리가 건 제한 시간. 아래 5xx 판정보다 먼저 봐야 한다 — 타임아웃에는 status 가 없다.
    if (name === "LoginTimeoutError" || code === "AUTH_TIMEOUT") return "AUTH_TIMEOUT";

    // 3) 인증 계층이 서 있지 않다. FIX-24 가 실제로 밟은 자리다.
    //    Kong 이 상류(GoTrue)가 죽었을 때 500·502·503 을 돌려준다.
    if (typeof status === "number" && status >= 500) return "AUTH_SERVICE_UNAVAILABLE";
    if (status === 0 || name === "AuthRetryableFetchError") return "AUTH_SERVICE_UNAVAILABLE";
    if (name === "TypeError" && (text.includes("fetch") || text.includes("network"))) {
      return "AUTH_SERVICE_UNAVAILABLE";
    }

    // 4) 키·URL 이 틀렸다. 401/403 은 자격증명이 아니라 apikey 쪽 문제다 —
    //    자격증명 실패는 위에서 이미 400 으로 걸러졌다.
    if (status === 401 || status === 403) return "AUTH_CONFIG";
    if (text.includes("invalid api key") || text.includes("no api key")) return "AUTH_CONFIG";

    return "AUTH_UNKNOWN";
  })();

  return { code: code_, ...VIEWS[code_] };
}

/** 제한 시간을 넘긴 로그인. `classifyLoginError` 가 이름으로 알아본다. */
export class LoginTimeoutError extends Error {
  readonly code = "AUTH_TIMEOUT";

  constructor() {
    super("login timed out");
    this.name = "LoginTimeoutError";
  }
}

/**
 * 로그인 호출의 제한 시간(ms).
 *
 * auth-js 는 재시도 가능한 실패를 **약 30초** 동안 조용히 되풀이한다. 그동안 화면은
 * "처리 중…" 에 멈춰 있고 아무 문구도 없다 — FIX-24 를 진단 불가로 만든 바로 그 구간이다.
 * 정상 로그인은 로컬에서 100ms 안쪽이라 12초면 넉넉하고, 죽은 인증 서버는 12초 만에 드러난다.
 */
export const LOGIN_TIMEOUT_MS = 12_000;

/** 제한 시간을 건다. 시간을 넘기면 `LoginTimeoutError` 로 거절한다. */
export function withLoginTimeout<T>(
  work: Promise<T>,
  timeoutMs: number = LOGIN_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LoginTimeoutError()), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

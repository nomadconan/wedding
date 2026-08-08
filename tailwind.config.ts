import type { Config } from "tailwindcss";

/**
 * 디자인 토큰 (T-04b)
 * 근거: docs/07_개발명세서.md §6 공통 UI 규칙
 *
 * 색상 값의 단일 진실은 `app/globals.css` 의 CSS 변수다.
 * 여기서는 그 변수를 Tailwind 이름에 연결하기만 한다 — 색 리터럴을 적지 않는다.
 *
 * 다크모드는 이번 범위가 아니므로 `darkMode` 를 설정하지 않는다(docs/DESIGN.md §5).
 */
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./hooks/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // ── 무채색 스케일 ────────────────────────────────────────────
        neutral: {
          0: "hsl(var(--neutral-0))",
          50: "hsl(var(--neutral-50))",
          100: "hsl(var(--neutral-100))",
          200: "hsl(var(--neutral-200))",
          300: "hsl(var(--neutral-300))",
          400: "hsl(var(--neutral-400))",
          500: "hsl(var(--neutral-500))",
          600: "hsl(var(--neutral-600))",
          700: "hsl(var(--neutral-700))",
          800: "hsl(var(--neutral-800))",
          900: "hsl(var(--neutral-900))",
        },

        // ── 강조색(브랜드) — 파랑 하나 ───────────────────────────────
        // Tailwind 의 `accent-*` 는 shadcn 규약상 hover 표면색이라 이름이 겹친다.
        // 브랜드 강조는 항상 `brand-*` 또는 `primary` 로 부른다.
        brand: {
          50: "hsl(var(--brand-50))",
          100: "hsl(var(--brand-100))",
          200: "hsl(var(--brand-200))",
          500: "hsl(var(--brand-500))",
          600: "hsl(var(--brand-600))",
          700: "hsl(var(--brand-700))",
          DEFAULT: "hsl(var(--brand-500))",
        },

        // ── 시맨틱 3종 ───────────────────────────────────────────────
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
          surface: "hsl(var(--success-surface))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
          surface: "hsl(var(--warning-surface))",
        },
        danger: {
          DEFAULT: "hsl(var(--danger))",
          foreground: "hsl(var(--danger-foreground))",
          surface: "hsl(var(--danger-surface))",
        },

        // ── shadcn/ui 시맨틱 ─────────────────────────────────────────
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
      },

      // ── 타이포 스케일 ─────────────────────────────────────────────
      // display: 화면 제목 / amount: 금액 전용 / unit: 금액 옆 단위
      // 금액은 서비스의 주인공이라 본문 스케일과 분리해서 관리한다.
      fontSize: {
        "display-lg": ["2.5rem", { lineHeight: "1.15", letterSpacing: "-0.02em", fontWeight: "700" }],
        display: ["2rem", { lineHeight: "1.2", letterSpacing: "-0.02em", fontWeight: "700" }],
        "display-sm": ["1.5rem", { lineHeight: "1.3", letterSpacing: "-0.01em", fontWeight: "700" }],

        "amount-lg": ["2.25rem", { lineHeight: "1.1", letterSpacing: "-0.03em", fontWeight: "800" }],
        amount: ["1.75rem", { lineHeight: "1.15", letterSpacing: "-0.02em", fontWeight: "700" }],
        "amount-sm": ["1.25rem", { lineHeight: "1.2", letterSpacing: "-0.01em", fontWeight: "700" }],

        // 금액 옆 '원', '부가세 포함' 처럼 작게 붙는 글자
        unit: ["0.875rem", { lineHeight: "1.4", fontWeight: "500" }],
        caption: ["0.75rem", { lineHeight: "1.5" }],
      },

      // ── 간격 스케일 ───────────────────────────────────────────────
      // 레이아웃 상수는 이름으로 부른다. 화면마다 다른 숫자를 쓰지 않기 위해서다.
      spacing: {
        gutter: "1.25rem", // 375px 기준 좌우 여백
        header: "3.5rem", // 상단 헤더 높이
        "tab-bar": "3.5rem", // 하단 탭 높이
        sidebar: "15rem", // 어드민 좌측 사이드바 폭
      },

      maxWidth: {
        consumer: "30rem", // 480px — 모바일 화면을 데스크톱에서 가운데 정렬
        admin: "80rem", // 1280px — 어드민 기준 폭
      },

      // ── 모서리 ────────────────────────────────────────────────────
      borderRadius: {
        xl: "calc(var(--radius) + 4px)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 4px)",
        sm: "calc(var(--radius) - 6px)",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;

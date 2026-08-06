# ASSETS.md — 이미지·아이콘 자산 규약 (T-02c)

> 단일 진실은 **`lib/assets/manifest.ts`** 다. 이 문서는 그 규약과 운용 절차를 적는다.
> 근거: `docs/07_개발명세서.md` §6 화면 명세 / §6 공통 UI 규칙 / §7.1 성능 / §7.5 접근성.

---

## 1. 핵심 원칙

**실제 이미지 교체에 코드 수정이 없어야 한다.**

지금 `public/images/` 에 들어 있는 것은 정확한 치수의 **자리표시 이미지**다.
나중에 실제 이미지를 제작하면 **같은 경로·같은 파일명으로 덮어쓰기**만 하면 교체가 끝난다.
화면 코드는 항상 경로가 아니라 **슬롯 id** 로만 자산을 참조하기 때문이다.

```tsx
<AssetImage id="landing.hero" priority />   // 경로·치수·alt 는 매니페스트가 안다
```

자리표시 이미지도 **git 에 커밋한다.** 파일이 없으면 빌드가 깨지고 CI(T-02b)가 돌지 않는다.

---

## 2. 파일명 규칙

```
{화면}-{슬롯}@{W}x{H}.{png|svg}
```

| 예시 | 의미 |
|---|---|
| `landing-hero@1600x900.png` | 랜딩 화면의 히어로 슬롯, 1600×900 |
| `onboarding-step-3@480x360.png` | 온보딩 3단계 일러스트, 480×360 |
| `vendor-dashboard-empty@320x240.svg` | 업체 대시보드 빈 상태, 320×240 |

- **치수를 파일명에 박는 것이 규약의 핵심이다.** 파일명만 보고 필요한 원본 크기를 알 수 있고,
  `assets:check` 가 파일명·매니페스트·실제 픽셀 세 값의 일치를 검사한다.
- 코드 파일명은 영문(CLAUDE.md §4.1). 자산 파일명도 **영문 소문자 + 하이픈**으로 통일한다.

### 폴더

| 경로 | 용도 |
|---|---|
| `public/images/brand/` | 로고·심볼·OG 이미지 |
| `public/images/marketing/` | 랜딩 히어로·가이드 썸네일 |
| `public/images/consumer/` | 온보딩 일러스트·소비자 빈 상태 |
| `public/images/vendor/` | 업체 어드민 빈 상태 |
| `public/images/admin/` | 운영 콘솔 빈 상태 |
| `public/images/icons/` | 브랜드성 아이콘(SVG) |

### 확장자 선택

| 확장자 | 쓰는 곳 |
|---|---|
| `svg` | 로고·심볼·브랜드 아이콘·빈 상태 일러스트 — 벡터로 제작·교체되는 것 |
| `png` | OG·히어로·가이드 썸네일·온보딩 일러스트 — 래스터로 제작·교체되는 것 |

> OG 이미지는 반드시 **래스터(png/jpg)** 여야 한다. SNS 크롤러는 SVG 를 og:image 로 받지 않는다.

---

## 3. 실제 이미지 교체 절차

1. `lib/assets/manifest.ts` 에서 슬롯의 `path` 와 `width`/`height` 를 확인한다.
2. **정확히 그 치수로** 이미지를 제작한다.
3. **같은 경로에 같은 파일명으로 덮어쓴다.** 파일명을 바꾸지 않는다.
4. 검증:

```bat
npm run assets:check
```

5. 통과하면 커밋한다. **코드 수정은 없다.**

치수를 바꿔야 한다면 매니페스트의 `width`/`height` **와** 파일명의 `@WxH` 를 **함께** 고친다.
셋 중 하나만 바뀌면 `assets:check` 가 실패한다.

> 확장자를 바꾸는 것(`.svg` → `.png`)도 교체가 아니라 **슬롯 변경**이다.
> 매니페스트 `path` 를 고치고 옛 파일을 지운다.

---

## 4. 새 슬롯 추가 절차

1. 근거를 먼저 잡는다 — `docs/07_개발명세서.md` §6 에서 **어느 화면의 어느 요소**인지.
   근거 없는 슬롯은 추가하지 않는다.
2. `lib/assets/manifest.ts` 의 `ASSETS` 에 항목을 추가한다.
   `alt` 는 **필수**다(§7.5 WCAG 2.1 AA). `note` 에 화면·기능 ID 를 적는다.
3. 자리표시 이미지 생성 — 기존 파일은 건드리지 않는다:

```bat
npm run assets:gen
npm run assets:check
```

4. 생성된 파일을 **커밋한다.**

`id` 는 `{영역}.{슬롯}` 점 표기다(`landing.hero`, `reports.empty`).
`AssetImage` 의 `id` 는 `AssetId` 로 좁혀져 있어 **매니페스트에 없는 값은 타입 에러**가 난다.

---

## 5. 아이콘 정책

| 구분 | 처리 |
|---|---|
| **브랜드 정체성이 담긴 아이콘** | `public/images/icons/` 에 SVG 파일 슬롯으로 관리 |
| **기능성 글리프**(화살표·닫기·검색·체크 등) | **`lucide-react`** 사용. 파일 슬롯을 만들지 않는다 |

브랜드성 아이콘의 예 — AI 플래너 '클리어' 아바타(`icon.clear-avatar`),
'유료 노출 없음' 정렬 기준 배지(`icon.no-paid-placement`).
후자는 CLAUDE.md §2.2 / 명세서 §6 공통 UI 규칙이 요구하는 **유료 노출 없음의 화면 증명**이라
브랜드 자산으로 취급한다.

> `lucide-react` 는 아직 의존성에 없다. 기능성 글리프가 처음 필요해지는 시점에
> 별도로 추가한다(신규 의존성이므로 사용자 확인 후).

---

## 6. 명령

| 명령 | 동작 |
|---|---|
| `npm run assets:gen` | 매니페스트를 읽어 **없는 파일만** 자리표시 이미지로 생성. 기존 파일은 절대 덮어쓰지 않는다 |
| `npm run assets:check` | 전 슬롯의 파일 존재·실제 치수·파일명 `@WxH` 일치 검사. 불일치 시 **비영 종료 코드** |

- 두 스크립트는 **새 의존성이 없다.** PNG 는 `scripts/lib/png-writer.mjs`(Node 내장 `zlib` 기반
  자체 인코더 + 5×7 비트맵 폰트)로, SVG 는 텍스트로 생성한다.
- `assets:check` 는 **T-02b CI 게이트에 그대로 얹는 용도**다. 실패하면 병합을 막는다.
- `public/images/` 에 있지만 어떤 슬롯도 가리키지 않는 파일은 **경고**로 보고한다(실패 아님).
  화면에서 쓰이지 않는 파일이므로 매니페스트에 등록하거나 삭제한다.

### 자리표시 이미지의 모양

회색 배판 + 테두리 + 대각선 위에 **슬롯 id / `1600x900` 형태의 치수 / 파일명**을 인쇄한다.
치수가 너무 작아 id 가 읽히지 않는 아이콘 슬롯(예: 24×24)은 치수만 인쇄하고,
슬롯 id 는 SVG `<title>` 에 남긴다.

---

## 7. 화면에서 쓰는 법

```tsx
import { AssetImage } from "@/components/ui/AssetImage";

// 기본 — src·width·height·alt 전부 매니페스트에서 주입된다
<AssetImage id="reports.empty" />

// LCP 대상은 priority 를 붙인다 (명세서 §7.1: SEO 페이지 LCP 2.5초)
<AssetImage id="landing.hero" priority className="w-full h-auto" />

// 맥락상 다른 대체 텍스트가 필요할 때만 alt 를 덮어쓴다
<AssetImage id="brand.logo" alt="웨딩클리어 홈으로" />

// 장식용이라 대체 텍스트가 불필요하면 빈 문자열을 명시한다
<AssetImage id="icon.clear-avatar" alt="" />
```

- 목록 이미지는 lazy 가 기본이다(명세서 §6 공통 UI 규칙). `priority` 는 LCP 대상에만 붙인다.
- SVG 슬롯은 `unoptimized` 가 자동으로 붙는다. Next 이미지 최적화는 SVG 를 거부하고,
  벡터라 최적화 이득도 없다. `next.config.mjs` 에 `dangerouslyAllowSVG` 를 켜지 않는다.

---

## 8. 현재 슬롯 (18개)

| 슬롯 id | 치수 | 화면 · 근거 |
|---|---|---|
| `brand.logo` | 240×48 | 헤더·푸터 워드마크 (공통) |
| `brand.symbol` | 512×512 | 앱 아이콘·파비콘 원본 (D-07 Capacitor) |
| `brand.og-default` | 1200×630 | OG 기본값 (미지정 시) |
| `landing.hero` | 1600×900 | `/` 랜딩 히어로 · F-C-24 |
| `guide.thumbnail-default` | 800×450 | `/guides/[slug]` 대표 이미지 기본값 · F-C-24 |
| `onboarding.step1` | 480×360 | `/onboarding` 1단계 예식 예정일 · F-C-01 |
| `onboarding.step2` | 480×360 | `/onboarding` 2단계 지역 · F-C-01 |
| `onboarding.step3` | 480×360 | `/onboarding` 3단계 예산 총액 · F-C-01 |
| `onboarding.step4` | 480×360 | `/onboarding` 4단계 하객 규모 · F-C-01 |
| `onboarding.step5` | 480×360 | `/onboarding` 5단계 스타일 선호 · F-C-01 |
| `onboarding.step6` | 480×360 | `/onboarding` 6단계 진행 단계 · F-C-01 |
| `reports.empty` | 320×240 | `/reports` 빈 상태 · F-C-07 |
| `budget.empty` | 320×240 | `/budget` 빈 상태 · F-C-05 |
| `explore.empty` | 320×240 | `/explore` 결과 0건 · F-C-10 |
| `vendor.dashboard.empty` | 320×240 | `/vendor` 빈 상태 · F-V-12 |
| `admin.dashboard.empty` | 320×240 | `/admin` 빈 상태 · F-A-07 |
| `icon.clear-avatar` | 64×64 | `/planner` 클리어 아바타 · F-C-03 |
| `icon.no-paid-placement` | 24×24 | 정렬 기준 배지 · CLAUDE.md §2.2 |

> R2/R3 화면(문의함·예약·전자계약·후기·정산 등)의 슬롯은 **아직 정의하지 않았다.**
> 범위 축소가 아니라, 화면 구현 시점에 §6 근거로 추가하는 항목이다(§4 절차).

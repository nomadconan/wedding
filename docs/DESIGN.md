# DESIGN.md — 디자인 시스템 (T-04b)

> 근거: `docs/07_개발명세서.md` §6 공통 UI 규칙 / §7.5 접근성, `CLAUDE.md` §2.2·§2.3
> 토큰의 단일 진실은 **`app/globals.css`**, Tailwind 이름 연결은 **`tailwind.config.ts`** 다.
> 눈으로 확인하려면 `npm run dev` 후 **`/design-system`** 을 연다.

---

## 0. 이 서비스가 화면에서 지켜야 하는 것

**주인공은 가격 정찰제다.** 총액이 공개되고 추가금이 사전에 등록돼 있다는 사실이
화면에서 가장 먼저 읽혀야 한다.

AI 플래너와 계약 검토는 **신뢰를 보조하는 기능**이다. 화면 위계에서 주인공이 아니다.
하단 탭 첫 자리가 `탐색`인 것도, `PriceDisplay`가 도메인 컴포넌트 중 가장 큰 것도 그래서다.

톤은 무채색 기반에 강조색 하나. 여백을 넉넉히 두고 한 화면에 담는 정보를 줄인다.
숫자는 크고 굵게, 단위는 작게.

---

## 1. 토큰

### 색

| 그룹 | 토큰 | 용도 |
|---|---|---|
| 무채색 | `neutral-0` … `neutral-900` (11단계) | 배경·경계·본문. 화면의 기본값 |
| 강조 | `brand-50/100/200/500/600/700` | 강조색은 **파랑 하나**. `brand-500`(#3182F6)이 기준 |
| 시맨틱 | `success` `warning` `danger` (각 `-foreground` `-surface`) | 상태 표시 **3종만**. 그 이상 늘리지 않는다 |

- 값은 `app/globals.css`에 **HSL 3요소**(`215 92% 58%`)로 적는다.
  `tailwind.config.ts`가 `hsl(var(--x))`로 감싸므로 `hsl()`·`oklch()`를 그대로 넣으면 깨진다.
- 시맨틱 색은 검출 룰 등급과 맞물린다: `high → danger`, `mid → warning`, `low → neutral`.

> **이름 함정** Tailwind의 `accent-*`는 shadcn 규약상 **hover 표면색**이다.
> 브랜드 강조색은 `brand-*` 또는 `primary`다. 강조하려고 `bg-accent`를 쓰면 회색이 나온다.

### 타이포

| 스케일 | 크기 | 용도 |
|---|---|---|
| `display-lg` / `display` / `display-sm` | 40 / 32 / 24px | 화면 제목 |
| `amount-lg` / `amount` / `amount-sm` | 36 / 28 / 20px | **금액 전용**. 본문 스케일과 분리 |
| `base` / `sm` | 16 / 14px | 본문·보조 |
| `unit` | 14px | 금액 옆 `원`, `부가세 포함` |
| `caption` | 12px | 각주·배지 |

금액에는 `tabular-nums`가 필요하다. `data-amount` 속성이 붙은 요소와 `table`은
`globals.css`에서 자동 적용된다.

### 간격 · 모서리

| 토큰 | 값 | 용도 |
|---|---|---|
| `gutter` | 20px | 375px 기준 좌우 여백 |
| `header` | 56px | 상단 헤더 높이 |
| `tab-bar` | 56px | 하단 탭 높이 |
| `sidebar` | 240px | 어드민 좌측 사이드바 폭 |
| `max-w-consumer` | 480px | 소비자 화면 최대 폭 |
| `max-w-admin` | 1280px | 어드민 기준 폭 |

`--radius: 0.75rem`(12px)이 기준이고 `sm/md/lg/xl`이 여기서 파생된다.
레이아웃 숫자를 화면마다 새로 정하지 않는다 — 위 이름을 쓴다.

---

## 2. 컴포넌트

### 도메인 (`components/domain/`)

세 컴포넌트는 장식이 아니라 **규칙의 구현체**다. 우회하지 않는다.

| 컴포넌트 | 규칙 | 강제 방식 |
|---|---|---|
| `PriceDisplay` | 가격은 항상 총액, 부가세 여부 명시, 추가금은 동일 화면 (§6) | `taxIncluded`·`addOns`가 **필수 prop**이다. 생략하면 컴파일이 안 된다 |
| `SortCriteriaBadge` | 정렬·추천 결과에 기준 배지 노출 (§6, D-03) | 목록 화면은 이 배지 없이 렌더하지 않는다. API가 내려준 정렬 코드를 그대로 넘긴다 |
| `AiDisclaimer` | AI 결과 화면에 고지 **상시 고정** 노출 (§5.1, CLAUDE.md §2.3) | 접기·닫기·툴팁 prop이 **없다**. 추가하지 말 것. 문구는 `lib/core/legal.ts` 단일 진실 |

`addOns`에 `{ kind: "unknown" }`이 있는 이유: "추가금이 없다"와 "업체가 등록하지 않았다"는
사용자에게 전혀 다른 정보다. 후자는 사실만 적고 평가적 단정을 하지 않는다.

### 상태 3종 (`components/ui/`)

**모든 데이터 화면에 셋 다 정의한다**(§6). 하나라도 빠지면 미완성 화면이다.

- `LoadingState` — 스피너가 아니라 스켈레톤. `variant`: `list` / `block` / `amount`
- `EmptyState` — 자산 **슬롯 id**를 받는다(T-02c). 경로를 직접 쓰지 않는다.
  "없음"을 알리는 화면이 아니라 **다음 행동을 제안하는 화면**이라 `action`을 우선 노출한다
- `ErrorState` — 사용자가 할 수 있는 일을 먼저. 에러 코드는 작게만.
  **서버 예외 메시지를 `description`에 그대로 넘기지 않는다** — 원문·Storage 경로가
  화면에 실려 나갈 수 있다(CLAUDE.md §5.3)

### 레이아웃 (`components/layout/`)

- `ConsumerShell` — 375px 기준 모바일 퍼스트, 데스크톱에서 480px 컬럼으로 가운데 정렬.
  하단 탭이 1차 경로의 전부다. 상단에 또 다른 내비게이션을 두지 않는다.
  온보딩처럼 집중이 필요한 단계는 `hideTabBar`로 탭을 감춘다
- `AdminShell` — 1280px 기준, 좌측 사이드바. `role="vendor" | "admin"`으로 항목만 바뀐다.
  두 콘솔을 별도 컴포넌트로 나누지 않는 이유는 한쪽만 고쳐지는 사고를 막기 위해서다

### 기본 (`components/ui/`)

shadcn/ui 14종(button, input, label, card, badge, dialog, select, checkbox, radio-group,
tabs, toast, skeleton, separator, progress). 필요할 때 `npx shadcn@2 add <name>`으로 추가한다.

> **CLI 버전 고정** 이 프로젝트는 React 18 / Next 14 / Tailwind 3이다.
> `shadcn@latest`(4.x)는 Tailwind 4 + React 19 세대라 호환되지 않는다. **`shadcn@2`를 쓴다.**

---

## 3. 화면을 만들 때 지킬 원칙 5개

1. **총액 먼저.** 가격을 보여주는 곳은 예외 없이 `PriceDisplay`를 쓴다.
   부가세 여부와 추가금을 같은 블록에 둔다 — 스크롤해야 보이면 규칙 위반이다.
2. **상태 3종을 먼저 정의한다.** 데이터를 부르는 화면은 로딩·빈 상태·에러를 다 갖춘 뒤에
   성공 화면을 만든다. 순서를 바꾸면 빈 상태가 끝까지 안 만들어진다.
3. **한 화면 한 질문.** 특히 온보딩 6단계는 단계당 입력 하나. 진행률(`Progress`)을 보여주고
   되돌아갈 수 있게 한다.
4. **강조색은 한 화면에 하나.** `brand-500`은 "지금 눌러야 할 것" 하나에만 쓴다.
   두 개가 동시에 파랑이면 둘 다 강조가 아니다. 나머지는 무채색으로 충분하다.
5. **터치 타깃 44px.** 소비자 화면의 주요 액션은 `<Button size="touch">`.
   대비는 WCAG 2.1 AA(본문 4.5:1) 기준을 지키고, 색만으로 상태를 전달하지 않는다(§7.5).

---

## 4. `/design-system` 카탈로그

`app/(dev)/design-system/page.tsx`. **개발 확인용이며 프로덕션 라우트가 아니다.**
배포 전 `(dev)` 그룹을 미들웨어나 `feature_flags`로 차단한다.

**새 공통 컴포넌트를 만들면 카탈로그에 반드시 추가한다.** 카탈로그에 없으면 없는 컴포넌트다.

---

## 5. 이번 범위가 아닌 것

| 항목 | 사유 |
|---|---|
| 다크모드 | T-04b 범위 밖. `.dark` 블록과 `darkMode` 설정을 두지 않았다. 도입 시 `globals.css`에 `.dark` 토큰만 추가하면 컴포넌트는 그대로 동작한다 |
| 차트 색 | 예산 배분 그래프(F-C-05) 착수 시 시맨틱과 별개 팔레트로 정의한다 |
| 웹폰트 | 지금은 시스템 폰트 스택. §7.1 성능 예산 확정 후 도입 여부를 결정한다 |
| 애니메이션 | `tailwindcss-animate`만 들여왔다. WebView 성능 가드(§6)에 따라 `transform`·`opacity` 위주로만 쓴다 |
| 목록 가상화 | §6이 요구하지만 실제 목록 화면(T-07 이후)에서 도입한다 |

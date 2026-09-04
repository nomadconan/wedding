# ROUTES.md — 실동작 점검 결과 (S0-04)

> **이 문서가 답하는 것.** "그 화면, 로그인해서 실제로 열리는가."
> 그 축은 `[x]`(코드 축)와 **다른 축**이다(D-75). 코드 축은 `docs/TASKS.md` 의 커버리지
> 검증표가 들고, 실동작 축은 이 문서가 든다.
>
> **측정일** 2026-09-03 · **측정 대상** `npm run build` 로 만든 프로덕션 서버
> (`http://localhost:3000`) · **측정 방법** 실제 Chrome 을 CDP 로 몰아 로그인 폼을 지나
> 라우트를 하나씩 열었다.
>
> **이 표는 `FIX-56` 을 고친 뒤 다시 잰 값이며, `FIX-12` 뒤에 한 번 더 확인했다.**
> 첫 회차에서 화면 다섯이 시드에 행이 없어 **없는 id 로만** 열렸고, 그 다섯을 채운 뒤
> 전수를 다시 돌렸다 — 시드를 바꾸면 **이 표는 낡는다.** 다시 돌리는 방법은 §2 에 있다.
>
> **`FIX-12`(요율 무효화) 뒤 재측정** — 화면 970 은 **판정이 한 칸도 바뀌지 않았고**
> API 는 라우트가 하나 늘어(`POST /api/admin/commission-rates/void`) 128 → **129**,
> 건수 1,280 → **1,290** 이 됐다. 5xx·하드 실패는 여전히 **0**.
>
> **`FIX-11`(오픈 준비 점검) 뒤 재측정** — 화면·API **둘 다 수가 그대로**다.
> `/admin/ops` 에 절이 하나 늘었지만 판정(정상)은 같고 새 라우트는 없다.
>
> **`FIX-14`(에스크로 자동 릴리즈) 뒤 재측정** — 화면 970 은 **일곱 칸이 한 건도
> 안 바뀌었고**(정상 377 · 빈 상태 273 · 권한 거부 126 · 오류 상태 82 · 로그인 요구 79 ·
> 404 24 · 리다이렉트 9), API 는 라우트가 하나 늘어(`POST/GET /api/jobs/escrow-release`)
> 129 → **130**, 건수 1,290 → **1,300** 이 됐다. 5xx·하드 실패는 여전히 **0**.
> 새 라우트는 **계정 열 축 모두에게 401** 이며 이는 배치 라우트가 세션이 아니라
> `CRON_SECRET`·서비스롤 키로 인가되기 때문이다(D-149) — 형제 여덟과 같은 값이다.
>
> **`FIX-08`(정산 기간 집계) 뒤 재측정** — 화면 970 은 **또 한 칸도 안 바뀌었고**,
> API 는 라우트가 하나 늘어(`POST/GET /api/jobs/settlement-aggregate`) 130 → **131**,
> 건수 1,300 → **1,310** 이 됐다. 5xx·하드 실패는 여전히 **0** 이고 새 라우트도
> 계정 열 축 모두에게 401 이다.

---

## 1. 분모를 먼저 정한다

세는 목록이 **넷**이고 넷이 서로 달랐다. 그래서 어느 것이 전수인지부터 적는다.

| 목록 | 수 | 무엇인가 |
|---|---|---|
| 실제 `app/**/page.tsx` | **97** | **이 점검의 분모** |
| 실제 `app/**/route.ts` | **128** | **API 점검의 분모** |
| 명세 `docs/07` §6 의 경로 행 | 83 | 문서가 약속한 화면 |
| 커버리지 검증표 D(`docs/TASKS.md`) | 87 | 태스크 대응을 적은 세 번째 목록 |

**분모는 `page.tsx` 97 개 · `route.ts` 128 개다.** 근거 셋 —

1. **점검이 묻는 것은 "열리는가" 다.** 열 수 있는 것은 파일이 있는 것뿐이다.
   명세에만 있는 경로는 열 대상이 아니라 **미착수**이며, 그것은 다른 표(커버리지)가 센다.
2. **문서 둘은 서로도 다르다.** 명세 83 · 커버리지 87 이고 차집합이 양방향으로 있다.
   둘 중 하나를 분모로 삼으면 **실제로 배포되는 화면 중 세지 않는 것**이 생긴다 —
   `/support`·`/admin/ops`·`/bookings` 처럼 실재하고 라우팅되는 화면들이다.
3. **직전 회차가 지적한 수(87 vs 97 vs 127)는 세 목록이 아니라 네 목록이었다.**
   87 은 명세가 아니라 **커버리지 표**의 수이고 명세는 83 이다. 127 은 그 뒤 한 건이
   늘어 지금 128 이다. 이 문서의 수는 전부 `npm run audit:routes` 가 센 값이다.

> **왜 프로덕션 빌드인가.** 처음에는 `npm run dev` 를 상대로 돌렸는데 Windows 에서
> `next dev` 가 `page_client-reference-manifest.js` 를 못 열어 **전 라우트가 500** 이 되는
> 상태에 두 번 빠졌다(앱 결함이 아니라 개발 서버 문제다). 그 상태의 500 을 표에 적으면
> 표가 거짓말을 한다. 프로덕션 빌드는 요청마다 컴파일하지 않아 그 사고가 없고,
> **FIX-22 계열(서버 컴포넌트 캐시)은 오히려 프로덕션에서만 드러난다.**
> `/design-system` 은 프로덕션에서 의도적으로 404 이므로(S8-05) 점검 때만
> `ENABLE_DEV_ROUTES=true` 로 열었다.

---

## 2. 다시 돌리는 방법

**표를 손으로 옮겨 적지 않는다.** 아래가 이 문서의 표를 만든다.

```bat
:: 0) 환경 (Docker Desktop 이 떠 있어야 한다)
npm run db:start
npm run db:reset
npm run db:types
npm run seed:accounts
npm run db:rls

:: 1) 정적 대조 — 명세 §6 · 커버리지 표 D · 실제 라우트 · 내비 · 도달 가능성
npm run audit:routes

:: 2) 앱을 띄운다. **프로덕션 빌드를 쓴다** (아래 주의 참조)
npm run build
set ENABLE_DEV_ROUTES=true
npm run start

:: 3) 실제 Chrome 으로 화면을 연다 (계정 10축 x 화면 97)
npm run audit:screens

:: 4) 세션 쿠키로 API 를 친다 (계정 10축 x route.ts 128)
npm run audit:api

:: 5) 결과를 마크다운 표로
npm run audit:report -- --out=tmp/audit-tables.md

:: 6) API 단계는 쓰기를 치므로 로컬 DB 를 되돌린다
npm run db:reset
npm run seed:accounts
```

| 스크립트 | 하는 일 | 산출 |
|---|---|---|
| `npm run audit:routes` | 명세 §6·커버리지 표 D·실제 라우트를 대조하고 내비 링크와 도달 가능성을 전수로 센다 | `tmp/audit-static.json` |
| `npm run audit:screens` | **실제 Chrome 을 CDP 로 몰아** 로그인 폼을 지나 화면을 연다 | `tmp/audit-screens.json` |
| `npm run audit:api` | 화면 단계에서 걷은 세션 쿠키로 `route.ts` 를 전수로 친다 | `tmp/audit-api.json` |
| `npm run audit:report` | 위 셋을 읽어 이 문서의 표를 만든다 | 표준출력 또는 `--out` |
| `npm run check:escrow` | **에스크로 자동 릴리즈 배치를 실제로 두드린다**(FIX-14). `?now=` 를 옮겨 가며 기한 전·예식 전·**예식 당일**(경계)에 조용한지 먼저 보고 그 다음 릴리즈를 본다. **DB 를 더럽히므로 `audit:api` 와 같이 되돌린다** | 종료 코드 |
| `npm run check:settlement` | **정산 기간 집계 배치를 실제로 두드린다**(FIX-08). 기준 미결(O-15) → `blocked` 이고 실행은 `failed`, **열린 홀드가 있으면 정산에서 빠지고** `escrow-release` 뒤에는 같은 예약이 정산에 든다 — **두 배치의 순서 의존을 눈으로 본다.** **DB 를 더럽히므로 `audit:api` 와 같이 되돌린다** | 종료 코드 |
| `npm run check:tables` | **문서 표의 칸 수가 머리글과 맞는지** 센다(`verify` 에 포함) | 종료 코드 |

### 새 의존성은 넣지 않았다

Playwright·Puppeteer 를 쓰지 않는다. **Chrome DevTools Protocol 을 직접 문다** —
설치된 Chrome 을 `--remote-debugging-port` 로 띄우고 Node 20 의
`--experimental-websocket` 으로 켠 전역 `WebSocket` 으로 CDP 메시지를 주고받는다.
계정마다 `Target.createBrowserContext` 로 **별도 쿠키 통**을 쓰므로 세션이 섞이지 않는다.

E2E 프레임워크(Playwright)는 **기술 부채로 남아 있다**(S8-05 · D-75 의 "갚는 조건").
이 스크립트는 그때까지의 다리다.

### 주의 다섯 (여기서 시간을 잃었다)

1. **`npm run dev` 로 돌리지 않는다.** Windows 에서 `next dev` 가 요청 폭주에
   `page_client-reference-manifest.js` 를 못 열고 **전 라우트를 500 으로 만든다**.
   앱 결함이 아니라 개발 서버 문제이며, 그 상태의 500 을 표에 적으면 **표가 거짓말을 한다**.
   프로덕션 빌드는 요청마다 컴파일하지 않아 그 사고가 없다.
2. **점검을 두 번 겹쳐 돌리지 않는다.** 위 사고는 스크립트 두 개가 같은 dev 서버를
   동시에 두드릴 때 처음 났다. 중단할 때는 `node`(audit-runtime)와 `chrome`(`wc-audit-*`
   프로필) **둘 다** 죽인다 — 셸만 끊으면 자식이 계속 돈다.
3. **`/design-system` 은 프로덕션에서 404 가 정상이다**(S8-05). 점검할 때만
   `ENABLE_DEV_ROUTES=true` 로 연다. **`FIX-56` 뒤 재측정 때 이 플래그를 빼먹어**
   세 샤드가 전부 그 한 화면에서 오류를 적었다 — 서버를 다시 띄우고 처음부터 돌렸다.
   플래그는 **서버를 띄울 때** 필요하지 점검 스크립트에 주는 것이 아니다.
4. **시드를 바꾸면 이 문서는 낡는다.** 표의 값은 그 시점의 DB 를 잰 것이다 —
   `seed:accounts` 에 픽스처를 더하면 `빈 상태` 가 `정상` 으로 바뀌므로 **다시 돌려
   표를 갈아 끼운다.** `FIX-56` 이 실제로 그렇게 만들었다(정상 +70 · 404 −33).
5. **API 단계는 쓰기를 친다.** `GET` 이 없는 핸들러는 빈 본문으로 `POST`/`PATCH` 를
   보낸다 — **인가가 본문 검증보다 앞에 있는지**가 이 점검이 보려는 것이다.
   그래서 화면 단계 **뒤에** 돌리고, 끝나면 `db:reset` + `seed:accounts` 로 되돌린다.
6. **CDP 가 한 화면에서 굳는 일이 있다.** `FIX-14` 재측정 때 `/vendor/pricing` 하나가
   `오류(내비 실패)` 로 적히고 그 뒤로 진행이 멈췄다. **같은 화면을 따로 열어 보니 두
   계정 모두 200 이었다** — 앱이 아니라 브라우저·프로토콜 쪽 사고이며 `FIX-58` 과 같은
   계열이다. 한 줄만 오류이고 그 뒤가 조용하면 **결함으로 적기 전에 그 화면을 따로 열어
   본다.** 다시 돌릴 때는 `node` 와 `chrome` 을 둘 다 죽이고 시작한다(주의 2).

## 3. 판정 낱말의 뜻

| 낱말 | 뜻 | 결함인가 |
|---|---|---|
| `정상` | 화면이 내용과 함께 그려졌다 | 아니다 |
| `빈` | `EmptyState` 가 그려졌다 — **데이터가 없어서**이며 화면은 제 일을 했다 | 아니다 |
| `로그인` | 미들웨어가 `/login?next=…` 으로 보냈다 | 아니다(의도) |
| `거부` | 화면 가드가 `/login?next=…&denied=1` 로 보냈다 — 권한 거부 | 아니다(의도) |
| `404` | 없는 것을 가리켰다. **지금은 전부 RLS 가 남의 행을 감춘 결과**다(`FIX-56` 뒤 가짜 id 는 없다). `※` 표시가 붙으면 시드에 그 행이 없다는 뜻이다 | 표시에 따라 다르다 |
| `→경로` | 다른 화면으로 넘겼다 | 경로별로 판단 |
| `전제 필요(코드)` | `ErrorState` 가 그려졌고 **코드가 선행 조건**을 말한다(`COUPLE_NOT_FOUND` 등) | 아니다 — `docs/06` 의 '전제 조건' 표를 본다 |
| **`오류(...)`** | 5xx · 렌더 실패 · 응답 없음 · 빈 화면 | **그렇다** |

---

## 4. 발견

### 4.1 화면 — 하드 실패 0

**970 건(화면 97 x 계정 10) 중 5xx·렌더 실패·응답 없음·빈 화면은 0 이었다.**
로그인 뒤 화면 79 개가 이 점검 전까지 **아무도 눈으로 본 적이 없었다**는 점을 생각하면
이 결과는 뜻밖에 좋다.

| 판정 | 건수 | 첫 회차 | 읽는 법 |
|---|---|---|---|
| 정상 | **377** | 307 | 내용과 함께 그려졌다(카탈로그 10 포함) |
| 빈 상태 | **273** | 310 | `EmptyState` — **데이터가 없어서**이며 화면은 제 일을 했다 |
| 권한 거부 | 126 | 126 | 화면 가드가 `?denied=1` 로 되돌렸다(의도) |
| 로그인 요구 | 79 | 79 | 미들웨어가 `/login?next=…` 으로 보냈다(의도) |
| 404 | **24** | 57 | **전부 RLS 가 남의 행을 감춘 결과**다(아래). 가짜 id 로 연 38 건은 사라졌다 |
| 전제 필요(코드) | 82 | 82 | 아래 |
| 리다이렉트 | 9 | 9 | `/admin/consultation-disputes` → `/admin/disputes?source=consultation`(설계) |
| **하드 실패** | **0** | 0 | — |

「첫 회차」는 `FIX-56` 을 고치기 전 값이다. **정상이 70 건 늘고 404 가 33 건 줄었다** —
없던 데이터가 생기니 화면이 그릴 것이 생겼다는 뜻이며, 그 70 건은 **첫 회차 표가
'확인했다' 고 적을 수 없던 자리**다.

**RLS 가 만든 404 를 결함으로 세지 않는다.** `/bookings/[id]`·`/chat/[roomId]`·
`/reports/[id]`·`/vendor/products/[id]` 를 **실제 id** 로 열면 주인에게는 `정상`,
남에게는 `404` 가 떴다 — 행이 안 보이니 화면이 `notFound()` 를 부른 것이고
**그것이 옳은 동작**이다. 예: 채팅방은 `couple-linked-a/b`(고객)와 `vendor`·`staff`(업체)
넷에게만 열리고 나머지 다섯에게는 없는 것과 같다.

다만 **'오류 상태' 82 건**은 따로 읽어야 한다.

`ErrorState` 가 그려진 82 건은 전부 **선행 조건 코드**를 달고 있었다 —
`COUPLE_NOT_FOUND`(온보딩을 안 한 계정) · `COUPLE_REQUIRED` ·
`PLANNER_NOT_REGISTERED` · `VENDOR_NOT_MEMBER` · `PAY_CONTRACT_NOT_FOUND` ·
`CANCEL_CONTRACT_NOT_FOUND`. **화면이 제 일을 한 것**이며 `docs/06` 의 '전제 조건' 표가
그 상황을 이미 설명한다. 하나도 결함으로 세지 않았다. 코드를 화면에 적어 두지
않았다면 이 82 건을 **오류로 셀 뻔했다** — `ErrorState` 의 `code` 가 그 자리에서 값을 했다.

### 4.2 판정을 두 번 고쳤다 (점검 자체의 결함)

점검 도구가 거짓말한 자리가 둘 있었고 둘 다 **표에 적기 전에** 잡았다. 적어 둔다 —
다음에 이 스크립트를 고치는 사람이 같은 함정을 다시 판다.

1. **`404` 라는 글자만 보고 404 로 판정했다.** 피처 플래그 콘솔이 설명 문장에
   "꺼면 그 경로가 404 가 됩니다" 를 담고 있어서 **정상으로 뜬 운영자 화면 둘이 404 로**
   기록됐다. Next 의 not-found 문구(`This page could not be found`)만 보도록 좁혔다.
2. **마지막 문서 응답을 상태로 썼다.** 화면이 뜬 뒤 Next 가 링크를 미리 당겨오고 그중
   보호 경로는 미들웨어가 307 로 되돌린다 — 그 307 이 마지막 응답이 되어 **200 으로 뜬
   화면이 307 로** 적혔다. 우리가 친 URL 의 응답을 고르도록 바꿨다.

세 번째는 도구가 아니라 **픽스처** 문제였다. `/explore/[vendorId]` 를 시드의 첫 업체로
열었더니 404 가 났는데, 그 업체는 **입점 심사 데모용 `pending`** 이라 탐색에서 보이지
않는 것이 정상이었다. 소비자 화면에는 `active` 업체를 쓰도록 고쳤다.
**세 번 다 "표가 거짓말을 하는" 방향의 오류**였고, 그래서 셋 다 고친 뒤 다시 돌렸다.

### 4.3 내비게이션 — 죽은 링크 0 (하나 지웠다)

내비 넷의 링크 **47** 개를 실제 라우트와 전수 대조했다. 죽은 링크는 **`/admin/settings`
하나**였고 **지웠다**. FIX-23 이 "무엇을 가리키려던 것인지 불명" 이라 적어 둔 자리이며,
화면도 없고 §6.4 에도 없다. 나머지 일곱은 S8-01·S8-03·S8-06~S8-10 이 화면을 세우며
차례로 살아나 있었다.

**내비 밖의 `href` 도 전수로 봤고 여기서 하나가 더 나왔다** — `/vendor/bookings` 가
계약이 발행된 예약 행에 `/contracts/<계약 id>` 링크를 그리는데 **그 화면이 없다**
(§6.2 에 있고 S5-05 미착수). 누르면 404 다. 지우지 않고 `FIX-57` 로 등록했다 —
화면이 곧 설 자리이고, 지우면 계약으로 가는 길이 사라진다.

### 4.4 도달 불가 화면 — 여섯 → 0

FIX-25 가 세던 다섯을 다시 세니 **여섯**이었다. 그중 **`/notifications`** 는
**명세 §6.2 에 있는 소비자 화면**(F-C-21)인데 어느 내비도 어느 화면도 가리키지 않았고,
미들웨어가 로그인까지 요구하므로 **URL 을 아는 사람만** 열 수 있었다.

| 화면 | 무엇을 했나 |
|---|---|
| `/vendor/cancellations` | `VENDOR_NAV` 예약 바로 아래에 이었다 |
| `/vendor/escrow` | `VENDOR_NAV` 정산 바로 **아래**에 이었다(위에 끼우면 "쿠폰은 정산 바로 위" 라는 S5-13 의 주석이 거짓말이 된다) |
| `/admin/settlements` | `ADMIN_NAV` 위약금 처리 바로 아래에 이었다 |
| `/admin/commission-rates` | `ADMIN_NAV` 정산 집행 바로 아래에 이었다 |
| `/notifications` | `/me` 에 진입점을 만들었다(하단 탭 다섯 칸이 찼다 · D-55) |
| `/admin/consultation-disputes` | **잇지 않았다.** 목록을 그리지 않는 **리다이렉트 별칭**이라 내비가 가리키면 같은 큐가 두 벌 선다(D-121). 실제 입구는 `/admin/disputes` 의 출처 필터 칩이며 그 화면은 내비에 있다. 이유를 `audit-routes.mjs` 의 `STANDALONE` 에 적었다 |

**예외를 이유와 함께 목록으로 든다**(D-177). 앱 밖에서 들어오는 화면
(`/share/[token]`·`/rsvp/[token]`·`/vendor/invite/[token]`)과 제품 내비에 올리지 않기로
한 화면(`/design-system`), 그리고 랜딩·로그인이 그 목록에 있다.

### 4.5 점검이 닿지 못했던 곳 — 시드 픽스처 공백 (**닫았다**)

첫 회차에서 `seed:accounts` 가 만들지 않는 표가 열이라 **화면 다섯을 실제 데이터로
열어 본 적이 없었다.** 없는 id 로만 열 수 있었으므로 확인된 것은 "못 찾음 경로가 깨끗이
끝난다" 뿐이었다. `FIX-56`(실서비스 전 필수)으로 등록하고 **곧바로 닫았다.**

| 화면 | 필요한 표 | 지금 |
|---|---|---|
| `/chat/[roomId]` | `chat_rooms` + `chat_messages` | **정상** — 방 1 · 메시지 3(시스템·업체·커플) |
| `/community/[postId]` | `community_posts` | **정상** — 글 2 · 댓글 2 · 업체 태그 1 |
| `/share/[token]` | `share_links` | **정상** — 살아 있는 링크 1 · 거둔 링크 1 |
| `/rsvp/[token]` | `guests.invite_token` | **정상** — 하객 3, 가장 오래된 행이 토큰을 든다 |
| `/vendor/invite/[token]` | `vendor_invites` | **정상** — 대기 중인 스태프 초대 1 |

`consultations`·`contract_cancellations`·`tasks`·`price_rules`·`product_options` 도 함께
채웠다. 그래서 `/checklist` 의 네 표현(역산 타임라인·게이지·다음 할 일·의존 관계)과
`/vendor/pricing` 의 시뮬레이터, `/vendor/cancellations`·`/admin/penalties` 의 큐가
**처음으로 내용을 가진 채** 열린다.

**일부러 안 만든 것 둘.** 커뮤니티 신고(`community_reports`)는 **빈 큐가 '신고가 없다'
라는 뜻으로 맞고**, 노쇼 상담은 **아무도 내지 않은 분쟁**을 운영자 큐에 넣게 된다.
둘 다 "비어 있는 것이 정상인 자리" 라 채우지 않았다.

**흉내 내지 않은 분기 하나.** `community_tag_vendor_guard()` 는 **승인된 업체만** 태그를
허용한다. 데모 업체는 심사 흐름을 위해 `pending` 으로 시작하므로 태그는 표본 업체로
가고, `/vendor/community` 와 '업체 답변' 배지(F-V-18)는 **데모 업체를 승인한 뒤에** 열린다.
업체를 강제로 `active` 로 만들어 배지를 띄우지 않았다 — **제품이 만들 수 없는 상태를
만들어 검사를 통과시키는 것**이기 때문이다.

### 4.6 픽스처가 드러낸 것 — 보안 검사 열다섯이 빈 표 덕에 통과하고 있었다

`FIX-56` 의 행을 넣자 **`db:rls` 검사 열다섯이 한꺼번에 실패했다.** 정책이 뚫린 것이
아니라 — 그 검사들이 `count(*)` 로 **표 전체**를 세면서 기대값을 `1` 로 적고 있었고,
그 `1` 은 "정책이 하나만 보여 준다" 가 아니라 **"세상에 하나뿐이다"** 였다.
해지 절차 · 커뮤니티 글 · 태스크 그래프 · 하객 명단 넷이 그랬다.

**이것이 함정 8 의 얼굴 하나다.** 이 리포는 "빈 목록으로 통과하는 검사" 를 여러 번
경계했는데(쿠폰 지갑 · AI 품질 · 후기 큐) **정작 보안 검사 자신이 같은 자리에 있었고**,
그 사실은 **시드를 늘린 다른 작업이 와서야** 드러났다.

고친 방법은 기대값을 3 으로 올리는 것이 **아니다** — 그러면 시드가 늘 때마다 다시
틀리고, 고치는 사람이 정책을 읽지 않은 채 숫자만 바꾼다. 각 검사의 setup 이
**자기가 세는 표를 먼저 비운다**(트랜잭션 안이라 rollback 으로 되돌아온다).
전체를 세는 것은 유지했다 — 그것이 "남의 행까지 보이는가" 를 묻는 방식이다(**D-178**).

**1,563 검사 전부 다시 통과한다.**


### 4.7 API — 5xx 0 · 비로그인 경계는 전부 지켜졌다

`route.ts` **129** 개를 계정 열 축으로 쳤다(**1,290 건**. `FIX-12` 가 무효화 라우트를
하나 더했다). `GET` 이 있으면 `GET` 을,
없으면 **첫 쓰기 메서드를 빈 본문으로** 보냈다 — 인가가 본문 검증보다 앞에 있어야
한다는 것이 이 점검이 보려던 것이다.

| 판정 | 건수 | FIX-56 뒤 | 첫 회차 |
|---|---|---|---|
| 검증 거절(400·422) | 340 | 338 | 338 |
| 403 권한 없음 | 310 | 303 | 321 |
| 200 통과 | **299** | 299 | 261 |
| 401 미인증 | 194 | 193 | 193 |
| 404 | **137** | 137 | 157 |
| 리다이렉트(307) | 10 | 10 | 10 |
| **5xx** | **0** | 0 | 0 |

`FIX-12` 가 더한 열 건은 전부 새 라우트의 것이다 — 비로그인 **401** 하나, 비운영자
**403** 일곱, 운영자 **422** 둘(빈 본문이라 사유 검증에 걸린다). **인가가 본문 검증보다
앞이라는 것**이 그 모양으로 드러난다.

`FIX-56` 이 채운 행 덕에 **200 이 38 건 늘고 404 가 20 건 줄었다** — 없던 자원을
가리키던 요청들이 이제 실제 자원을 가리킨다.

**비로그인이 200 을 받은 것은 다섯 뿐이고 전부 의도된 공개 경로다** —
`GET /api/vendors` · `GET /api/search` · `GET /api/planners` · `GET /api/community/posts` ·
`POST /api/observability/client-event`(204). §1.4 의 guest 범위 그대로다.
비로그인이 401 이 아닌 나머지도 **공개 엔드포인트가 필수 파라미터를 요구한 것**이었다
(`/api/prices`·`/api/qna`·`/api/reviews`·`/api/penalty/simulate`·
`/api/vendors/[id]/availability`·`/api/vendor/invites/accept`·`/api/rsvp/[token]`·
`/api/share/[token]`·`/api/community/posts/[id]` · `/auth/callback` 은 307).

**역할 경계도 모양이 일정했다.** `/api/admin/**` 는 비로그인 401 → 비운영자 403 →
`ops`·`admin` 200 이고, `/api/vendor/**` 는 비멤버 403 → `vendor`·`staff` 200 이다.
예외 하나는 **`GET /api/vendor/settlements` 가 모두에게 200** 인데, 이것은 그 라우트가
**403 대신 RLS 로 막는 쪽을 택했기 때문**이다(주석에 그렇게 적혀 있다 — "403 이 아니라
안 보이는 것이 경계다"). 남의 정산이 새는 것이 아니라 **빈 목록이 온다**.

### 4.8 이 점검이 답하지 못하는 것

정직하게 적는다. 표가 '전수' 라고 말하더라도 **다음은 확인되지 않았다.**

1. **쓰기 라우트 33 개의 역할 경계.** 빈 본문을 보냈으므로 **검증(400·422)이 먼저
   걸려** 인가까지 가지 않았다. **비로그인 401 은 그 33 개에서도 전부 확인됐고**
   (공개 엔드포인트 여섯 제외) 확인되지 않은 것은 **로그인 계정끼리의 403/200 경계**다.
   제대로 보려면 라우트마다 **유효한 본문**이 필요하고, 그것은 흐름 스크립트나 E2E 의 일이다.
2. ~~**화면 다섯의 정상 경로**~~ → **닫혔다**(`FIX-56` · §4.5). 시드가 열 표를 채워
   다섯 화면이 실제 데이터로 열린다.
3. **`/vendor/community` 와 '업체 답변' 배지**(F-V-18). 승인된 업체만 태그할 수 있는데
   데모 업체는 `pending` 으로 시작한다 — **승인 뒤 `seed:accounts` 를 다시 돌리면** 열린다.
   제품이 만들 수 없는 상태를 억지로 만들어 확인하지 않았다(§4.5).
4. **흐름 전체.** 이 점검은 **화면을 열고 상태를 적을 뿐** 로그인 → 담기 → 계약 → 결제
   같은 **여정을 끝까지 밟지 않는다.** 그것은 E2E 의 일이며 여전히 부채다(S8-05).

이 넷을 적어 두지 않으면 다음 사람이 이 문서를 "전부 확인됐다" 로 읽는다 —
**그것이 D-75 가 고치려던 바로 그 오독**이다.

---

## 5. 신설한 FIX — 등급별

**고치지 않고 기록한다**(S0-04 범위 정의). 예외는 **한 줄로 끝나는 것**이었고 그것만 고쳤다.
원장은 `docs/TASKS.md` 「알려진 결함(FIX)」이며 여기서는 요약만 든다.

**`FIX-56` 만 예외로 곧바로 고쳤다** — 한 줄이 아니라서가 아니라, 그것을 두면
**이 문서의 나머지가 거짓말을 하기 때문**이다. 화면 다섯을 "확인했다" 고 적을 수 없는
상태로는 전수 표가 성립하지 않는다. 별도 브랜치(`fix/FIX-56-seed-fixtures`)에서 처리했다.

| 등급 | 번호 | 한 줄 | 담당 | 상태 |
|---|---|---|---|---|
| **실서비스 전 필수** | **FIX-56** | 시드가 만들지 않는 픽스처 때문에 **화면 다섯이 실제 데이터로 열린 적이 없다** | **S0-02 확장** | **해소**(§4.5) |
| 기록 | **FIX-55** | 명세 §6 과 실제 라우트가 **열여섯 자리**에서 어긋나 있다(§6 에만 1 · 실제에만 15) | 문서 태스크 | 미해소 |
| 기록 | **FIX-57** | `/vendor/bookings` 가 **없는 화면**(`/contracts/[id]`)으로 가는 링크를 그린다 | **S5-05** | 미해소 |
| 기록 | **FIX-58** | `npm run dev` 가 Windows 에서 **전 라우트를 500 으로 만든다**(개발 서버 문제) | 없음(도구) | 미해소 |

### 이번에 고친 것 (한 줄로 끝나는 것만)

| 무엇 | 어디 | 왜 지금 고쳤나 |
|---|---|---|
| `/admin/settings` 링크 제거 | `ADMIN_NAV` | 화면도 §6.4 항목도 없는 링크였다. **없는 화면을 가리키는 링크는 깨진 것**이며(D-177) 한 줄 삭제로 끝난다 |
| 내비 항목 넷 추가 | `VENDOR_NAV`·`ADMIN_NAV` | 완성된 화면 넷이 **도달 불가**였다. S0-04 범위 3 의 산출이 「링크 대조 표 + **수정**」이고 완료 조건 (라)가 0 을 요구한다 |
| `/notifications` 진입점 | `/me` | 같은 이유. 하단 탭 다섯 칸이 찼으므로(D-55) 쿠폰·예약과 같은 자리에 뒀다 |
| `FIX-38` 행 복구 | `docs/TASKS.md` | 아래 §6 |

### 해소한 것

| 번호 | 무엇이었나 | 어떻게 닫혔나 |
|---|---|---|
| **FIX-23** | 운영자·업체 내비가 **없는 화면을 가리켰다**(한때 여덟) | 일곱은 S8-01·S8-03·S8-06~S8-10 이 화면을 세우며 살아났고, 남은 `/admin/settings` 를 **S0-04 가 지웠다.** 내비 넷의 죽은 링크 **0** |
| **FIX-25** | **만들어 놓고 아무도 갈 수 없는 화면**(다시 세니 여섯) | 다섯을 이었고 하나는 리다이렉트 별칭이라 **잇지 않는 것이 옳다**고 판정해 이유와 함께 예외 목록에 적었다. 도달 불가 **0** |

## 6. 원장 결함 — `FIX-38` 행 복구

**증상.** FIX 표의 `FIX-38` 행이 **칸 넷**으로 잘려 있었다(머리글은 다섯). 상태·발견 칸이
통째로 사라져 **고쳤는지 아닌지 표에서 읽을 수 없었다.**

**원인.** 내용 안의 파이프 하나다 — `` `started_at: string | null` `` 의 `|` 가
이스케이프되지 않아 마크다운이 그것을 **칸 구분자로 읽었다.** 코드 스팬 안이라고
안전하지 않다.

**고친 것 셋.**

1. 파이프를 `\|` 로 이스케이프했다. 그러자 칸이 **셋**으로 드러났다 — 파이프가
   구분자 노릇을 하며 칸 수를 **넷처럼 보이게 했을 뿐**, 상태·발견 칸은 **애초에 없었다.**
2. 없던 두 칸을 채웠다. 상태는 `해소`(migration `0057` + `lib/core/format/timestamp.ts` +
   `RawRun` 타입 정정), 발견/해소는 `fix/admin-client-error`(`2630d5b`) — 이 항목은
   태스크가 아니라 **FIX 전용 브랜치**에서 처리됐다.
3. 그 행의 마지막 문장(내비의 죽은 링크 넷이 404 라는 기록)에 **S0-04 시점의 재확인**을
   덧붙였다 — 셋은 이미 살아났고 `/admin/settings` 하나만 남아 있었다.

**같은 문제가 다른 행에도 있었다 — 셋 더.** 문서 전체의 표를 훑어 **머리글과 칸 수가
다른 행**을 찾았다.

| 파일 | 무엇이 깨졌나 | 고친 방법 |
|---|---|---|
| `docs/07_개발명세서.md` 개정 이력 v2.8 | 상태 값 집합 `(blocked\|draft\|confirmed\|paid\|void)` 의 파이프 **넷**이 칸을 넷 더 만들었다 | 파이프 이스케이프 |
| `docs/07_개발명세서.md` §6.2 `/explore/compare` | `?mode=carts\|items` 의 파이프 하나 | 파이프 이스케이프 |
| `docs/06_개발환경_컨텍스트.md` 권한 표 | 파이프 문제가 아니었다 — **칸이 셋뿐인 행**이 넉 칸짜리 표에 들어가 '최종 경계' 열이 통째로 비어 있었다 | 없던 칸을 채웠다(마이그레이션 `0068` 이 `profiles` 표 단위 쓰기를 걷고 네 칸만 컬럼 GRANT 로 되돌린 사실) |

**다시 생기지 않게 했다.** `scripts/check-doc-tables.mjs` 가 `docs/*.md`·`CLAUDE.md`·
`AGENTS.md`·`README.md` 의 모든 표를 훑어 **머리글과 칸 수가 다른 행**을 찾고 종료 코드로
끊는다. `npm run check:tables` 이며 **`npm run verify` 에 넣었다.** 이스케이프된 `\|` 는
구분자로 세지 않는다 — 그것이 이 검사의 요점이다.

## 7. 다음에 할 일

1. ~~**`FIX-56` 을 먼저 한다**~~ → **했다.** 시드가 열 표를 채워 다섯 화면이 실제
   데이터로 열린다(§4.5). 그 과정에서 `db:rls` 검사 열다섯이 **빈 표 덕에 통과하고
   있었다**는 것이 드러났고 함께 고쳤다(§4.6 · **D-178**).
2. **실서비스 전 필수 여덟** — `FIX-08`·`11`·`12`·`14`·`22`·`31`·`34`·`42`.
   이제 그것들을 고칠 때 **그 화면을 실제로 열어 볼 수 있다.**
3. **`npm run audit:routes` 를 게이트로 올릴지 정한다.** 지금은 조사 도구이며 종료 코드가
   항상 0 이다. **죽은 링크 0 · 도달 불가 0 인 지금이 기준선을 세울 때**다.
4. **명세 §6 에 실재 화면 15개를 반영한다**(`FIX-55`). 이 문서의 차집합 표가 그 입력이다.
5. **E2E(Playwright · S8-05 부채).** 들어오면 `audit:screens` 의 일부가 자동화된다
   (D-75 의 "갚는 조건"). 이 스크립트는 그때까지의 다리이며 **흐름을 끝까지 밟지 않는다** —
   화면을 열고 상태를 적을 뿐이다.

---

## 8. 표 (자동 생성)

> 아래 표는 `npm run audit:report` 가 만든다. **손으로 고치지 않는다** —
> 고쳐야 할 값이 있으면 점검을 다시 돌린다.

### 분모 (실측)

| 목록 | 수 | 무엇을 세는가 |
|---|---|---|
| 실제 `app/**/page.tsx` | **97** | **이 점검의 분모.** 사용자가 URL 로 열 수 있는 화면 |
| 실제 `app/**/route.ts` | **131** | **API 점검의 분모**(`FIX-14`·`FIX-08` 이 배치 라우트를 하나씩 더했다) |
| 명세 `docs/07` §6 경로 | 83 | 문서가 약속한 화면 |
| 커버리지 검증표 D(`docs/TASKS.md`) | 98 | 태스크 대응을 적은 세 번째 목록 |

### 차집합 셋 (명세 §6 ↔ 실제 화면)

**둘 다 있음 82 · 명세에만 1 · 실제에만 15**

| 구분 | 경로 | 비고 |
|---|---|---|
| 명세에만 | `/contracts/[id]` | 전자계약 (§6.2 소비자) — 화면 파일이 없다 |
| 실제에만 | `/admin/ops` | `app/(admin)/admin/ops/page.tsx` |
| 실제에만 | `/admin/penalties` | `app/(admin)/admin/penalties/page.tsx` |
| 실제에만 | `/bookings` | `app/(consumer)/bookings/page.tsx` |
| 실제에만 | `/bookings/[id]/cancel` | `app/(consumer)/bookings/[id]/cancel/page.tsx` |
| 실제에만 | `/bookings/[id]/escrow` | `app/(consumer)/bookings/[id]/escrow/page.tsx` |
| 실제에만 | `/design-system` | `app/(dev)/design-system/page.tsx` |
| 실제에만 | `/planners/[id]` | `app/(consumer)/planners/[id]/page.tsx` |
| 실제에만 | `/pro` | `app/(planner)/pro/page.tsx` |
| 실제에만 | `/support` | `app/(consumer)/support/page.tsx` |
| 실제에만 | `/vendor/cancellations` | `app/(vendor)/vendor/cancellations/page.tsx` |
| 실제에만 | `/vendor/escrow` | `app/(vendor)/vendor/escrow/page.tsx` |
| 실제에만 | `/vendor/invite/[token]` | `app/(vendor)/vendor/invite/[token]/page.tsx` |
| 실제에만 | `/vendor/products/[id]` | `app/(vendor)/vendor/products/[id]/page.tsx` |
| 실제에만 | `/vendor/products/new` | `app/(vendor)/vendor/products/new/page.tsx` |
| 실제에만 | `/vendor/settings` | `app/(vendor)/vendor/settings/page.tsx` |

### 화면 × 계정

| 경로 | 비로그인 | 커플A | 커플B | 연동A | 연동B | 플래너 | 업체 | 스태프 | ops | admin |
|---|---|---|---|---|---|---|---|---|---|---|
| `/` | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 |
| `/admin` | 로그인 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 정상 | 정상 |
| `/admin/ai-quality` | 로그인 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 정상 | 정상 |
| `/admin/audit` | 로그인 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 정상 | 정상 |
| `/admin/cms` | 로그인 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 정상 | 정상 |
| `/admin/commission-rates` | 로그인 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 정상 | 정상 |
| `/admin/community-reports` | 로그인 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 빈 | 빈 |
| `/admin/consultation-disputes` | 로그인 | →/admin/disputes | →/admin/disputes | →/admin/disputes | →/admin/disputes | →/admin/disputes | →/admin/disputes | →/admin/disputes | →/admin/disputes | →/admin/disputes |
| `/admin/coupons` | 로그인 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 정상 | 정상 |
| `/admin/disputes` | 로그인 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 정상 | 정상 |
| `/admin/flags` | 로그인 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 정상 | 정상 |
| `/admin/ops` | 로그인 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 정상 | 정상 |
| `/admin/penalties` | 로그인 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 빈 | 빈 |
| `/admin/prices` | 로그인 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 정상 | 정상 |
| `/admin/privacy` | 로그인 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 정상 | 정상 |
| `/admin/reviews` | 로그인 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 정상 | 정상 |
| `/admin/rules` | 로그인 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 정상 | 정상 |
| `/admin/settlements` | 로그인 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 빈 | 빈 |
| `/admin/tickets` | 로그인 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 정상 | 정상 |
| `/admin/vendors` | 로그인 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 거부 | 정상 | 정상 |
| `/bookings` | 로그인 | 빈 | 빈 | 정상 | 정상 | 빈 | 정상 | 정상 | 빈 | 빈 |
| `/bookings/[id]` | 로그인 | 404 | 404 | 정상 | 정상 | 404 | 정상 | 정상 | 404 | 404 |
| `/bookings/[id]/cancel` | 로그인 | 전제 필요(CANCEL_CONTRACT_NOT_FOUND) | 전제 필요(CANCEL_CONTRACT_NOT_FOUND) | 정상 | 정상 | 전제 필요(CANCEL_CONTRACT_NOT_FOUND) | 정상 | 정상 | 전제 필요(CANCEL_CONTRACT_NOT_FOUND) | 전제 필요(CANCEL_CONTRACT_NOT_FOUND) |
| `/bookings/[id]/escrow` | 로그인 | 빈 | 빈 | 정상 | 빈 | 빈 | 정상 | 정상 | 정상 | 정상 |
| `/budget` | 로그인 | 빈 | 빈 | 정상 | 정상 | 빈 | 빈 | 빈 | 빈 | 빈 |
| `/cart` | 로그인 | 전제 필요(COUPLE_NOT_FOUND) | 전제 필요(COUPLE_NOT_FOUND) | 정상 | 정상 | 전제 필요(COUPLE_NOT_FOUND) | 전제 필요(COUPLE_NOT_FOUND) | 전제 필요(COUPLE_NOT_FOUND) | 전제 필요(COUPLE_NOT_FOUND) | 전제 필요(COUPLE_NOT_FOUND) |
| `/chat` | 로그인 | 빈 | 빈 | 정상 | 정상 | 빈 | 정상 | 정상 | 빈 | 빈 |
| `/chat/[roomId]` | 로그인 | 404 | 404 | 정상 | 정상 | 404 | 정상 | 정상 | 404 | 404 |
| `/checklist` | 로그인 | 빈 | 빈 | 정상 | 정상 | 빈 | 빈 | 빈 | 빈 | 빈 |
| `/checkout/[bookingId]` | 로그인 | 전제 필요(PAY_CONTRACT_NOT_FOUND) | 전제 필요(PAY_CONTRACT_NOT_FOUND) | 정상 | 빈 | 전제 필요(PAY_CONTRACT_NOT_FOUND) | 정상 | 정상 | 전제 필요(PAY_CONTRACT_NOT_FOUND) | 전제 필요(PAY_CONTRACT_NOT_FOUND) |
| `/community` | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 |
| `/community/[postId]` | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 |
| `/community/write` | 로그인 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 |
| `/consultations` | 로그인 | 빈 | 빈 | 정상 | 정상 | 정상 | 정상 | 정상 | 빈 | 빈 |
| `/coupons` | 로그인 | 빈 | 빈 | 정상 | 정상 | 빈 | 정상 | 정상 | 정상 | 정상 |
| `/design-system` | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 |
| `/estimates` | 로그인 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 |
| `/explore` | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 |
| `/explore/[vendorId]` | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 |
| `/explore/compare` | 로그인 | 전제 필요(COUPLE_NOT_FOUND) | 전제 필요(COUPLE_NOT_FOUND) | 빈 | 빈 | 전제 필요(COUPLE_NOT_FOUND) | 전제 필요(COUPLE_NOT_FOUND) | 전제 필요(COUPLE_NOT_FOUND) | 전제 필요(COUPLE_NOT_FOUND) | 전제 필요(COUPLE_NOT_FOUND) |
| `/guests` | 로그인 | 빈 | 빈 | 정상 | 정상 | 빈 | 빈 | 빈 | 빈 | 빈 |
| `/guides` | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 |
| `/guides/[slug]` | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 |
| `/home` | 로그인 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 |
| `/inquiries` | 로그인 | 빈 | 빈 | 정상 | 정상 | 빈 | 빈 | 빈 | 빈 | 빈 |
| `/login` | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 |
| `/me` | 로그인 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 |
| `/membership` | 로그인 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 |
| `/notifications` | 로그인 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 |
| `/onboarding` | 로그인 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 |
| `/planner` | 로그인 | 빈 | 빈 | 정상 | 정상 | 빈 | 빈 | 빈 | 빈 | 빈 |
| `/planners` | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 |
| `/planners/[id]` | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 |
| `/planners/[id]/delegate` | 로그인 | 전제 필요(COUPLE_REQUIRED) | 전제 필요(COUPLE_REQUIRED) | 정상 | 정상 | 전제 필요(COUPLE_REQUIRED) | 전제 필요(COUPLE_REQUIRED) | 전제 필요(COUPLE_REQUIRED) | 전제 필요(COUPLE_REQUIRED) | 전제 필요(COUPLE_REQUIRED) |
| `/planners/delegations` | 로그인 | 전제 필요(COUPLE_REQUIRED) | 전제 필요(COUPLE_REQUIRED) | 정상 | 정상 | 전제 필요(COUPLE_REQUIRED) | 전제 필요(COUPLE_REQUIRED) | 전제 필요(COUPLE_REQUIRED) | 전제 필요(COUPLE_REQUIRED) | 전제 필요(COUPLE_REQUIRED) |
| `/planners/ranking` | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 |
| `/planners/scopes` | 로그인 | 전제 필요(COUPLE_REQUIRED) | 전제 필요(COUPLE_REQUIRED) | 정상 | 정상 | 전제 필요(COUPLE_REQUIRED) | 전제 필요(COUPLE_REQUIRED) | 전제 필요(COUPLE_REQUIRED) | 전제 필요(COUPLE_REQUIRED) | 전제 필요(COUPLE_REQUIRED) |
| `/prices/[region]/[category]` | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 |
| `/pro` | 로그인 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 |
| `/pro/engagements` | 로그인 | 전제 필요(PLANNER_NOT_REGISTERED) | 전제 필요(PLANNER_NOT_REGISTERED) | 전제 필요(PLANNER_NOT_REGISTERED) | 전제 필요(PLANNER_NOT_REGISTERED) | 정상 | 전제 필요(PLANNER_NOT_REGISTERED) | 전제 필요(PLANNER_NOT_REGISTERED) | 전제 필요(PLANNER_NOT_REGISTERED) | 전제 필요(PLANNER_NOT_REGISTERED) |
| `/pro/settlements` | 로그인 | 전제 필요(PLANNER_NOT_REGISTERED) | 전제 필요(PLANNER_NOT_REGISTERED) | 전제 필요(PLANNER_NOT_REGISTERED) | 전제 필요(PLANNER_NOT_REGISTERED) | 정상 | 전제 필요(PLANNER_NOT_REGISTERED) | 전제 필요(PLANNER_NOT_REGISTERED) | 전제 필요(PLANNER_NOT_REGISTERED) | 전제 필요(PLANNER_NOT_REGISTERED) |
| `/qna/[vendorId]` | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 |
| `/reports` | 로그인 | 빈 | 빈 | 정상 | 정상 | 빈 | 빈 | 빈 | 빈 | 빈 |
| `/reports/[id]` | 로그인 | 404 | 404 | 정상 | 정상 | 404 | 404 | 404 | 404 | 404 |
| `/reports/upload` | 로그인 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 |
| `/reviews/new/[bookingId]` | 로그인 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 |
| `/rsvp/[token]` | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 |
| `/search` | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 |
| `/share/[token]` | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 |
| `/support` | 로그인 | 빈 | 빈 | 정상 | 빈 | 빈 | 빈 | 빈 | 정상 | 정상 |
| `/tools/penalty` | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 |
| `/vendor` | 로그인 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 |
| `/vendor/apply` | 로그인 | 빈 | 빈 | 빈 | 빈 | 빈 | 정상 | 빈 | 빈 | 빈 |
| `/vendor/availability` | 로그인 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 |
| `/vendor/bookings` | 로그인 | 전제 필요(VENDOR_NOT_MEMBER) | 전제 필요(VENDOR_NOT_MEMBER) | 전제 필요(VENDOR_NOT_MEMBER) | 전제 필요(VENDOR_NOT_MEMBER) | 전제 필요(VENDOR_NOT_MEMBER) | 정상 | 정상 | 전제 필요(VENDOR_NOT_MEMBER) | 전제 필요(VENDOR_NOT_MEMBER) |
| `/vendor/cancellations` | 로그인 | 빈 | 빈 | 빈 | 빈 | 빈 | 정상 | 정상 | 빈 | 빈 |
| `/vendor/chat` | 로그인 | 빈 | 빈 | 빈 | 빈 | 빈 | 정상 | 정상 | 빈 | 빈 |
| `/vendor/community` | 로그인 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 |
| `/vendor/compliance` | 로그인 | 빈 | 빈 | 빈 | 빈 | 빈 | 정상 | 정상 | 빈 | 빈 |
| `/vendor/consultations` | 로그인 | 빈 | 빈 | 빈 | 빈 | 빈 | 정상 | 정상 | 빈 | 빈 |
| `/vendor/coupons` | 로그인 | 전제 필요(VENDOR_NOT_MEMBER) | 전제 필요(VENDOR_NOT_MEMBER) | 전제 필요(VENDOR_NOT_MEMBER) | 전제 필요(VENDOR_NOT_MEMBER) | 전제 필요(VENDOR_NOT_MEMBER) | 정상 | 정상 | 전제 필요(VENDOR_NOT_MEMBER) | 전제 필요(VENDOR_NOT_MEMBER) |
| `/vendor/escrow` | 로그인 | 빈 | 빈 | 빈 | 빈 | 빈 | 정상 | 정상 | 빈 | 빈 |
| `/vendor/inquiries` | 로그인 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 |
| `/vendor/inventory` | 로그인 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 |
| `/vendor/invite/[token]` | 로그인 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 |
| `/vendor/members` | 로그인 | 빈 | 빈 | 빈 | 빈 | 빈 | 정상 | 정상 | 빈 | 빈 |
| `/vendor/pricing` | 로그인 | 빈 | 빈 | 빈 | 빈 | 빈 | 정상 | 정상 | 빈 | 빈 |
| `/vendor/products` | 로그인 | 빈 | 빈 | 빈 | 빈 | 빈 | 정상 | 정상 | 빈 | 빈 |
| `/vendor/products/[id]` | 로그인 | 404 | 404 | 404 | 404 | 404 | 정상 | 정상 | 404 | 404 |
| `/vendor/products/new` | 로그인 | 빈 | 빈 | 빈 | 빈 | 빈 | 정상 | 정상 | 빈 | 빈 |
| `/vendor/profile` | 로그인 | 빈 | 빈 | 빈 | 빈 | 빈 | 정상 | 정상 | 빈 | 빈 |
| `/vendor/qna` | 로그인 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 |
| `/vendor/reviews` | 로그인 | 빈 | 빈 | 빈 | 빈 | 빈 | 정상 | 정상 | 빈 | 빈 |
| `/vendor/settings` | 로그인 | 빈 | 빈 | 빈 | 빈 | 빈 | 정상 | 정상 | 빈 | 빈 |
| `/vendor/settlements` | 로그인 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 | 빈 |
| `/vendor/stats` | 로그인 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 | 정상 |
| `/wishlist` | 로그인 | 전제 필요(COUPLE_NOT_FOUND) | 전제 필요(COUPLE_NOT_FOUND) | 빈 | 빈 | 전제 필요(COUPLE_NOT_FOUND) | 전제 필요(COUPLE_NOT_FOUND) | 전제 필요(COUPLE_NOT_FOUND) | 전제 필요(COUPLE_NOT_FOUND) | 전제 필요(COUPLE_NOT_FOUND) |

※ = 시드에 해당 행이 없어 **없는 id** 로 열었다. 그 칸의 `404` 는 결함이 아니라 '못 찾음 경로가 깨끗이 끝났다' 는 뜻이다.

### 화면 점검 요약

| 판정 | 건수 |
|---|---|
| 정상 | 377 |
| 빈 | 273 |
| 거부 | 126 |
| 로그인 | 79 |
| 404 | 24 |
| 전제 필요(COUPLE_NOT_FOUND) | 21 |
| 전제 필요(COUPLE_REQUIRED) | 21 |
| 전제 필요(PLANNER_NOT_REGISTERED) | 16 |
| 전제 필요(VENDOR_NOT_MEMBER) | 14 |
| →/admin/disputes | 9 |
| 전제 필요(CANCEL_CONTRACT_NOT_FOUND) | 5 |
| 전제 필요(PAY_CONTRACT_NOT_FOUND) | 5 |
| **합계** | **970** |

### API × 계정 (HTTP 상태)

| 메서드·경로 | 비로그인 | 커플A | 커플B | 연동A | 연동B | 플래너 | 업체 | 스태프 | ops | admin |
|---|---|---|---|---|---|---|---|---|---|---|
| `GET /api/admin/ai-quality` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 200 | 200 |
| `GET /api/admin/audit-logs` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 200 | 200 |
| `GET /api/admin/commission-rates` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 200 | 200 |
| `GET /api/admin/commission-rates/resolve` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 200 | 200 |
| `GET /api/admin/community-reports` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 200 | 200 |
| `GET /api/admin/consultation-disputes` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 200 | 200 |
| `GET /api/admin/content` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 200 | 200 |
| `GET /api/admin/coupons` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 200 | 200 |
| `GET /api/admin/entity-events` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 422 | 422 |
| `GET /api/admin/flags/[key]` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 200 | 200 |
| `GET /api/admin/metrics` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 200 | 200 |
| `GET /api/admin/ops` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 200 | 200 |
| `GET /api/admin/penalties` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 200 | 200 |
| `GET /api/admin/price-anomalies` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 200 | 200 |
| `GET /api/admin/privacy-audit` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 200 | 200 |
| `GET /api/admin/reviews` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 200 | 200 |
| `GET /api/admin/rules` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 200 | 200 |
| `GET /api/admin/tickets` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 200 | 200 |
| `GET /api/bookings/[id]/cancel` | 401 | 404 | 404 | 200 | 200 | 404 | 200 | 200 | 404 | 404 |
| `GET /api/budget` | 401 | 404 | 404 | 200 | 200 | 404 | 404 | 404 | 404 | 404 |
| `GET /api/cart` | 401 | 404 | 404 | 200 | 200 | 404 | 404 | 404 | 404 | 404 |
| `GET /api/chat/messages` | 401 | 400 | 400 | 400 | 400 | 400 | 400 | 400 | 400 | 400 |
| `GET /api/chat/rooms` | 401 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/community/posts` | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/community/posts/[id]` | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/community/posts/[id]/comments` | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/consultations` | 401 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/couples/invite` | 401 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `GET /api/coupons` | 401 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/estimates/compare` | 401 | 404 | 404 | 200 | 200 | 404 | 404 | 404 | 404 | 404 |
| `GET /api/guests` | 401 | 404 | 404 | 200 | 200 | 404 | 404 | 404 | 404 | 404 |
| `GET /api/inquiries` | 401 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/jobs/consultation-confirm-request` | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 |
| `GET /api/jobs/consultation-resolve` | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 |
| `GET /api/jobs/dday-notifications` | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 |
| `GET /api/jobs/planner-payout-due` | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 |
| `GET /api/jobs/price-anomaly-scan` | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 |
| `GET /api/jobs/price-index-refresh` | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 |
| `GET /api/jobs/purge-documents` | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 |
| `GET /api/jobs/sla-escalation` | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 |
| `GET /api/membership` | 401 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/notifications` | 401 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/onboarding` | 401 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/payments/schedules` | 401 | 400 | 400 | 400 | 400 | 400 | 400 | 400 | 400 | 400 |
| `GET /api/planner-engagements` | 401 | 403 | 403 | 200 | 200 | 403 | 403 | 403 | 403 | 403 |
| `GET /api/planner-scopes` | 401 | 403 | 403 | 200 | 200 | 403 | 403 | 403 | 403 | 403 |
| `GET /api/planner/profile` | 401 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/planner/settlements` | 401 | 403 | 403 | 403 | 403 | 200 | 403 | 403 | 403 | 403 |
| `GET /api/planners` | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/prices` | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `GET /api/qna` | 400 | 400 | 400 | 400 | 400 | 400 | 400 | 400 | 400 | 400 |
| `GET /api/reports/[id]` | 401 | 404 | 404 | 200 | 200 | 404 | 404 | 404 | 404 | 404 |
| `GET /api/reviews` | 400 | 400 | 400 | 400 | 400 | 400 | 400 | 400 | 400 | 400 |
| `GET /api/rsvp/[token]` | 404 | 404 | 404 | 404 | 404 | 404 | 404 | 404 | 404 | 404 |
| `GET /api/search` | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/share-links` | 401 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `GET /api/share/[token]` | 404 | 404 | 404 | 404 | 404 | 404 | 404 | 404 | 404 | 404 |
| `GET /api/tasks` | 401 | 404 | 404 | 200 | 200 | 404 | 404 | 404 | 404 | 404 |
| `GET /api/tasks/graph` | 401 | 404 | 404 | 200 | 200 | 404 | 404 | 404 | 404 | 404 |
| `GET /api/tickets` | 401 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/vendor/availability` | 401 | 403 | 403 | 403 | 403 | 403 | 200 | 200 | 403 | 403 |
| `GET /api/vendor/chat` | 401 | 403 | 403 | 403 | 403 | 403 | 200 | 200 | 403 | 403 |
| `GET /api/vendor/community-tags` | 401 | 403 | 403 | 403 | 403 | 403 | 200 | 200 | 403 | 403 |
| `GET /api/vendor/compliance` | 401 | 403 | 403 | 403 | 403 | 403 | 200 | 200 | 403 | 403 |
| `GET /api/vendor/consultations` | 401 | 403 | 403 | 403 | 403 | 403 | 200 | 200 | 403 | 403 |
| `GET /api/vendor/coupons` | 401 | 403 | 403 | 403 | 403 | 403 | 200 | 200 | 403 | 403 |
| `GET /api/vendor/invites` | 401 | 403 | 403 | 403 | 403 | 403 | 200 | 200 | 403 | 403 |
| `GET /api/vendor/invites/accept` | 400 | 400 | 400 | 400 | 400 | 400 | 400 | 400 | 400 | 400 |
| `GET /api/vendor/members` | 401 | 404 | 404 | 404 | 404 | 404 | 200 | 200 | 404 | 404 |
| `GET /api/vendor/price-rules` | 401 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/vendor/products` | 401 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/vendor/products/[id]/options` | 401 | 404 | 404 | 404 | 404 | 404 | 200 | 200 | 404 | 404 |
| `GET /api/vendor/profile` | 401 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/vendor/qna` | 401 | 403 | 403 | 403 | 403 | 403 | 200 | 200 | 403 | 403 |
| `GET /api/vendor/quotes` | 401 | 403 | 403 | 403 | 403 | 403 | 200 | 200 | 403 | 403 |
| `GET /api/vendor/reviews` | 401 | 403 | 403 | 403 | 403 | 403 | 200 | 200 | 403 | 403 |
| `GET /api/vendor/settings` | 401 | 403 | 403 | 403 | 403 | 403 | 200 | 200 | 403 | 403 |
| `GET /api/vendor/settlements` | 401 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/vendor/stats` | 401 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/vendors` | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| `GET /api/vendors/[id]/availability` | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `GET /api/wishlist` | 401 | 404 | 404 | 200 | 200 | 404 | 404 | 404 | 404 | 404 |
| `GET /auth/callback` | 307 | 307 | 307 | 307 | 307 | 307 | 307 | 307 | 307 | 307 |
| `PATCH /api/admin/coupons/[id]` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 422 | 422 |
| `PATCH /api/admin/disputes/[id]` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 422 | 422 |
| `PATCH /api/admin/finding-reports` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 422 | 422 |
| `PATCH /api/admin/review-reports` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 422 | 422 |
| `PATCH /api/admin/vendors/[id]/review` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 422 | 422 |
| `PATCH /api/planner-engagements/[id]` | 401 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `PATCH /api/reviews/[id]` | 401 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `PATCH /api/vendor/bookings/[id]` | 401 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `PATCH /api/vendor/coupons/[id]` | 401 | 403 | 403 | 403 | 403 | 403 | 422 | 403 | 403 | 403 |
| `PATCH /api/vendor/members/[userId]` | 401 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `PATCH /api/vendor/price-rules/[id]` | 401 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `PATCH /api/vendor/products/[id]` | 401 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `PATCH /api/vendor/products/[id]/options/[optionId]` | 401 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `POST /api/admin/ai-reviews` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 422 | 422 |
| `POST /api/admin/commission-rates/void` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 422 | 422 |
| `POST /api/admin/planner-payouts` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 422 | 422 |
| `POST /api/admin/prices/recalculate` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 422 | 422 |
| `POST /api/admin/settlements/run` | 401 | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 422 | 422 |
| `POST /api/ai/planner` | 401 | 404 | 404 | 422 | 422 | 404 | 404 | 404 | 404 | 404 |
| `POST /api/cancellations/[id]/confirm` | 401 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `POST /api/community/posts/[id]/like` | 401 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| `POST /api/community/posts/[id]/scrap` | 401 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| `POST /api/community/reports` | 401 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `POST /api/consultations/[id]/confirm` | 401 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `POST /api/contracts` | 401 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `POST /api/contracts/[id]/sign` | 401 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `POST /api/coupons/apply` | 401 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `POST /api/documents` | 401 | 404 | 404 | 422 | 422 | 404 | 404 | 404 | 404 | 404 |
| `POST /api/escrow/release` | 401 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `POST /api/estimates/normalize` | 401 | 404 | 404 | 422 | 422 | 404 | 404 | 404 | 404 | 404 |
| `POST /api/findings/[id]/report` | 401 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `POST /api/guests/invites` | 401 | 404 | 404 | 422 | 422 | 404 | 404 | 404 | 404 | 404 |
| `POST /api/me/delete-request` | 401 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `POST /api/observability/client-event` | 204 | 204 | 204 | 204 | 204 | 204 | 204 | 204 | 204 | 204 |
| `POST /api/payments/checkout` | 401 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `POST /api/payments/webhook` | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 |
| `POST /api/penalty/simulate` | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `POST /api/reports` | 401 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `POST /api/reviews/[id]/report` | 401 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `POST /api/tasks/[id]/dependencies` | 401 | 404 | 404 | 422 | 422 | 404 | 404 | 404 | 404 | 404 |
| `POST /api/vendor/apply` | 401 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `POST /api/vendor/compliance/scan` | 401 | 403 | 403 | 403 | 403 | 403 | 422 | 422 | 403 | 403 |
| `POST /api/vendor/inventory/bulk` | 401 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `POST /api/vendor/price-rules/simulate` | 401 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |
| `PUT /api/guests/seating` | 401 | 404 | 404 | 422 | 422 | 404 | 404 | 404 | 404 | 404 |
| `PUT /api/me` | 401 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 | 422 |

### API 점검 요약

| 판정 | 건수 |
|---|---|
| 검증 거절 | 340 |
| 403 권한 없음 | 310 |
| 200 통과 | 299 |
| 401 미인증 | 194 |
| 404 | 137 |
| 리다이렉트(307) | 10 |
| **합계** | **1290** |

### 내비게이션 링크 대조

| 내비 | 링크 | 실제 라우트 | 판정 |
|---|---|---|---|
| `VENDOR_NAV` | `/vendor` | 있음 | 정상 |
| `VENDOR_NAV` | `/vendor/profile` | 있음 | 정상 |
| `VENDOR_NAV` | `/vendor/products` | 있음 | 정상 |
| `VENDOR_NAV` | `/vendor/pricing` | 있음 | 정상 |
| `VENDOR_NAV` | `/vendor/inventory` | 있음 | 정상 |
| `VENDOR_NAV` | `/vendor/chat` | 있음 | 정상 |
| `VENDOR_NAV` | `/vendor/inquiries` | 있음 | 정상 |
| `VENDOR_NAV` | `/vendor/qna` | 있음 | 정상 |
| `VENDOR_NAV` | `/vendor/community` | 있음 | 정상 |
| `VENDOR_NAV` | `/vendor/consultations` | 있음 | 정상 |
| `VENDOR_NAV` | `/vendor/availability` | 있음 | 정상 |
| `VENDOR_NAV` | `/vendor/bookings` | 있음 | 정상 |
| `VENDOR_NAV` | `/vendor/cancellations` | 있음 | 정상 |
| `VENDOR_NAV` | `/vendor/reviews` | 있음 | 정상 |
| `VENDOR_NAV` | `/vendor/coupons` | 있음 | 정상 |
| `VENDOR_NAV` | `/vendor/settlements` | 있음 | 정상 |
| `VENDOR_NAV` | `/vendor/escrow` | 있음 | 정상 |
| `VENDOR_NAV` | `/vendor/stats` | 있음 | 정상 |
| `VENDOR_NAV` | `/vendor/members` | 있음 | 정상 |
| `VENDOR_NAV` | `/vendor/compliance` | 있음 | 정상 |
| `VENDOR_NAV` | `/vendor/settings` | 있음 | 정상 |
| `ADMIN_NAV` | `/admin` | 있음 | 정상 |
| `ADMIN_NAV` | `/admin/vendors` | 있음 | 정상 |
| `ADMIN_NAV` | `/admin/coupons` | 있음 | 정상 |
| `ADMIN_NAV` | `/admin/prices` | 있음 | 정상 |
| `ADMIN_NAV` | `/admin/rules` | 있음 | 정상 |
| `ADMIN_NAV` | `/admin/ai-quality` | 있음 | 정상 |
| `ADMIN_NAV` | `/admin/cms` | 있음 | 정상 |
| `ADMIN_NAV` | `/admin/tickets` | 있음 | 정상 |
| `ADMIN_NAV` | `/admin/reviews` | 있음 | 정상 |
| `ADMIN_NAV` | `/admin/community-reports` | 있음 | 정상 |
| `ADMIN_NAV` | `/admin/disputes` | 있음 | 정상 |
| `ADMIN_NAV` | `/admin/penalties` | 있음 | 정상 |
| `ADMIN_NAV` | `/admin/settlements` | 있음 | 정상 |
| `ADMIN_NAV` | `/admin/commission-rates` | 있음 | 정상 |
| `ADMIN_NAV` | `/admin/audit` | 있음 | 정상 |
| `ADMIN_NAV` | `/admin/privacy` | 있음 | 정상 |
| `ADMIN_NAV` | `/admin/flags` | 있음 | 정상 |
| `ADMIN_NAV` | `/admin/ops` | 있음 | 정상 |
| `PLANNER_NAV` | `/pro` | 있음 | 정상 |
| `PLANNER_NAV` | `/pro/engagements` | 있음 | 정상 |
| `PLANNER_NAV` | `/pro/settlements` | 있음 | 정상 |
| `BottomTabNav` | `/home` | 있음 | 정상 |
| `BottomTabNav` | `/explore` | 있음 | 정상 |
| `BottomTabNav` | `/cart` | 있음 | 정상 |
| `BottomTabNav` | `/wishlist` | 있음 | 정상 |
| `BottomTabNav` | `/me` | 있음 | 정상 |

### 화면 안의 죽은 링크 (내비 넷 밖의 `href`)

| 링크 | 어디서 | 왜 죽었나 |
|---|---|---|
| `/contracts/[*]` | `app/(vendor)/vendor/bookings/page.tsx` | 실재하는 화면 라우트가 없다 |

### 도달 불가 화면 (어느 내비도 어느 화면도 가리키지 않는다)

없다.

#### 가리키는 자리가 없어도 정상인 화면

| 경로 | 왜 |
|---|---|
| `/admin/consultation-disputes` | 명세 §6.4 경로를 살려 두는 리다이렉트다 — `/admin/disputes?source=consultation` 으로 보낸다. 내비가 따로 가리키면 **같은 큐가 목록에 두 벌** 서고(D-121) 그 둘이 갈리는 날 어느 쪽이 맞는지 답할 수 없다. 실제 입구는 `/admin/disputes` 의 출처 필터 칩이며 그 화면은 `ADMIN_NAV` 에 있다. |
| `/design-system` | 컴포넌트 카탈로그(dev) — 제품 내비에 연결하지 않기로 했다(S8-05 · 프로덕션에서는 404) |

### 시드에 없어 실제 id 로 열지 못한 것

`chatRoom` · `post` · `shareToken` · `rsvpToken` · `inviteToken` · `consultation` · `cancellation` · `task` · `priceRule` · `option`

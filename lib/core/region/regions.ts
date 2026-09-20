// 지역 코드 체계 (C-2f · 명세서 §2.1 F-C-10 확장 · F-C-09 · §3.3 · B-1)
//
// 프레임워크를 모르는 순수 모듈이다(CLAUDE.md §3.1).
//
// ── 무엇이 문제였나 ─────────────────────────────────────────────────────────
// `vendors.region_code` 가 **자유 입력 문자열**이고 탐색 필터가 `ilike %값%`
// **부분 일치**였다. 그래서
//   · "강남" 이 "강남구"·"강남동"·"서울 강남" 을 **함께** 물고
//   · 오탈자("서울 강남구 " · "강남区")는 **조용히 0건**이 된다 — 업체는 자기가
//     어떤 필터에도 안 걸린다는 사실을 모른다.
// 사용자가 말한 네 축(카테고리·가격·**지역**·컨셉) 중 **지역만 코드가 없었다.**
//
// ── 왜 ASCII 슬러그인가 ─────────────────────────────────────────────────────
// 지역 코드는 `/prices/[region]/[category]` 의 **URL 조각**이다. 이 리포는 이미
// 같은 판단을 했다 — `SLUG_PATTERN` 이 *"슬러그는 URL 그 자체이고, 퍼센트 인코딩된
// 한글 URL 은 공유될 때 깨져 보인다"* 며 한글을 받지 않는다. 그래서 **코드는 슬러그,
// 표시는 한글 라벨**이다(`hall`·`romantic` 과 같은 관례).
//
// ── 깊이 — 표본이 모이는 곳부터 깊어진다 ────────────────────────────────────
// 깊으면 **참가격 표본이 흩어져 지수가 안 서고**(하한 5 · S3-08), 얕으면 '서울' 이
// 한 칸이라 쓸모가 없다. 그래서 **균일한 깊이를 쓰지 않는다**:
//   · **시군구** — 서울 25구 · 경기 31시군(예식 수요가 몰리는 곳)
//   · **시도**   — 그 밖의 모든 시도(17개 전부 유효)
// **어느 지역도 표현 불가가 되지 않는다** — 깊이를 안 넣은 곳은 시도 코드로 적는다.
// 나중에 표본이 모이면 그 시도를 시군구로 **쪼갤 수 있고**, 그때는 기존 행의 이행이
// 함께 서야 한다(이 파일을 늘리는 것만으로는 부족하다).

/** 시도. 모든 코드가 이 중 하나에 속한다. */
export const SIDO_CODES = [
  "seoul", "busan", "daegu", "incheon", "gwangju", "daejeon", "ulsan", "sejong",
  "gyeonggi", "gangwon", "chungbuk", "chungnam", "jeonbuk", "jeonnam",
  "gyeongbuk", "gyeongnam", "jeju",
] as const;

export type SidoCode = (typeof SIDO_CODES)[number];

export const SIDO_LABEL: Record<SidoCode, string> = {
  seoul: "서울", busan: "부산", daegu: "대구", incheon: "인천",
  gwangju: "광주", daejeon: "대전", ulsan: "울산", sejong: "세종",
  gyeonggi: "경기", gangwon: "강원", chungbuk: "충북", chungnam: "충남",
  jeonbuk: "전북", jeonnam: "전남", gyeongbuk: "경북", gyeongnam: "경남",
  jeju: "제주",
};

/** 시군구까지 내려간 지역. `<시도>-<시군구>` 이며 라벨은 `<시도> <시군구>` 다. */
const SIGUNGU: { sido: SidoCode; slug: string; name: string }[] = [
  // 서울 25구
  ...[
    ["jongno", "종로"], ["jung", "중"], ["yongsan", "용산"], ["seongdong", "성동"],
    ["gwangjin", "광진"], ["dongdaemun", "동대문"], ["jungnang", "중랑"], ["seongbuk", "성북"],
    ["gangbuk", "강북"], ["dobong", "도봉"], ["nowon", "노원"], ["eunpyeong", "은평"],
    ["seodaemun", "서대문"], ["mapo", "마포"], ["yangcheon", "양천"], ["gangseo", "강서"],
    ["guro", "구로"], ["geumcheon", "금천"], ["yeongdeungpo", "영등포"], ["dongjak", "동작"],
    ["gwanak", "관악"], ["seocho", "서초"], ["gangnam", "강남"], ["songpa", "송파"],
    ["gangdong", "강동"],
  ].map(([slug, name]) => ({ sido: "seoul" as SidoCode, slug: slug!, name: name! })),
  // 경기 31시군
  ...[
    ["suwon", "수원"], ["seongnam", "성남"], ["uijeongbu", "의정부"], ["anyang", "안양"],
    ["bucheon", "부천"], ["gwangmyeong", "광명"], ["pyeongtaek", "평택"], ["dongducheon", "동두천"],
    ["ansan", "안산"], ["goyang", "고양"], ["gwacheon", "과천"], ["guri", "구리"],
    ["namyangju", "남양주"], ["osan", "오산"], ["siheung", "시흥"], ["gunpo", "군포"],
    ["uiwang", "의왕"], ["hanam", "하남"], ["yongin", "용인"], ["paju", "파주"],
    ["icheon", "이천"], ["anseong", "안성"], ["gimpo", "김포"], ["hwaseong", "화성"],
    ["gwangju", "광주"], ["yangju", "양주"], ["pocheon", "포천"], ["yeoju", "여주"],
    ["yeoncheon", "연천"], ["gapyeong", "가평"], ["yangpyeong", "양평"],
  ].map(([slug, name]) => ({ sido: "gyeonggi" as SidoCode, slug: slug!, name: name! })),
];

export type Region = { code: string; label: string; sido: SidoCode };

/**
 * 어휘 전체. **시도 17 + 시군구 56 = 73.**
 * 순서가 화면 표시 순서다(시도 순 → 그 안에서 시군구).
 */
export const REGIONS: Region[] = SIDO_CODES.flatMap((sido) => [
  { code: sido, label: SIDO_LABEL[sido], sido },
  ...SIGUNGU.filter((entry) => entry.sido === sido).map((entry) => ({
    code: `${sido}-${entry.slug}`,
    label: `${SIDO_LABEL[sido]} ${entry.name}`,
    sido,
  })),
]);

export const REGION_CODES: string[] = REGIONS.map((region) => region.code);

const BY_CODE = new Map(REGIONS.map((region) => [region.code, region]));

export function isRegionCode(value: string): boolean {
  return BY_CODE.has(value);
}

/** 화면에 적는 한글 이름. 모르는 코드는 **지어내지 않고** 코드를 그대로 돌려준다. */
export function regionLabel(code: string | null): string | null {
  if (code === null) return null;

  return BY_CODE.get(code)?.label ?? code;
}

/**
 * 시도 코드인가.
 *
 * 탐색에서 시도를 고르면 **그 안의 시군구도 함께** 나와야 한다 — "서울" 을 고른
 * 뜻은 "서울 어디든" 이다. 질의가 그때만 접두어로 본다.
 */
export function isSidoCode(value: string): boolean {
  return (SIDO_CODES as readonly string[]).includes(value);
}

/** 그 시도에 속하는 코드인가(자기 자신 포함). 질의와 **같은 규칙**을 화면·테스트가 쓴다. */
export function isWithinRegion(code: string, filter: string): boolean {
  if (code === filter) return true;

  return isSidoCode(filter) && code.startsWith(`${filter}-`);
}

export function regionSido(code: string): SidoCode | null {
  return BY_CODE.get(code)?.sido ?? null;
}

// =============================================================================
// 이행 — 자유 문자열을 코드로
// =============================================================================

/**
 * 옛 자유 입력을 코드로 옮긴다.
 *
 * **추측하지 않는다.** 라벨과 정확히 맞거나(공백 차이는 무시), 시도 이름만 적혀
 * 있거나, 이미 코드인 경우에만 답을 준다. 그 밖에는 `null` 이고 **사람이 본다** —
 * "서울 강남구 3층" 같은 값을 자동으로 `seoul-gangnam` 으로 옮기면 주소를 지역으로
 * 바꿔 버리는 셈이고, 그런 이행은 되돌릴 수 없다.
 *
 * 받아들이는 모양:
 *   · `seoul-gangnam`  (이미 코드)
 *   · `서울 강남` · `서울강남` · `서울 강남구`  (라벨 · 공백 무시 · 시군구 접미사)
 *   · `서울`            (시도만)
 */
export function toRegionCode(raw: string | null): string | null {
  if (raw === null) return null;

  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (BY_CODE.has(trimmed)) return trimmed;

  // 공백을 지우고, 시군구 접미사(구·시·군)를 떼고 맞춰 본다.
  const compact = trimmed.replace(/\s+/g, "");

  for (const region of REGIONS) {
    const label = region.label.replace(/\s+/g, "");
    if (compact === label) return region.code;

    // "서울 강남구" → "서울강남구" 가 "서울강남" + 접미사 한 글자인 경우만.
    if (compact.length === label.length + 1 && compact.startsWith(label)) {
      const suffix = compact.slice(label.length);
      if (suffix === "구" || suffix === "시" || suffix === "군") return region.code;
    }
  }

  return null;
}

// =============================================================================
// 별칭 — 사람이 쓰는 말
// =============================================================================

/**
 * 사람이 쓰는 지역 말 → 코드.
 *
 * **어휘와 별칭은 같은 파일에 있어야 한다.** 한때 검색 파서가 자기 사전을 따로 들고
 * 있었고, 그때는 조회가 부분 일치라 사전이 달라도 티가 안 났다. 코드로 정확히 거르는
 * 지금은 사전이 둘이면 **같은 문장이 경로에 따라 다른 지역으로 걸린다** — 화면에서
 * 설명할 수 없는 차이다(D-206 이 어휘를 하나로 두라고 한 이유와 같다).
 *
 * **생활권 이름은 담는 시군구로 보낸다.** "판교"·"여의도" 는 행정구역이 아니라 어휘에
 * 없지만 사람은 그렇게 말한다. 말은 받고 코드로는 담는 구·시를 쓰며, 그 사실은 화면이
 * 코드의 라벨을 적으면서 드러난다 — "여의도" 라고 쳤는데 "서울 영등포" 로 걸렸다는 것이
 * 보여야 사용자가 결과를 이해한다.
 */
export const REGION_ALIASES: Record<string, string> = {
  // 광역 (라벨과 같은 말이지만 사전에 함께 둔다 — 가장 긴 것부터 보는 스캐너가 쓴다)
  서울: "seoul", 경기: "gyeonggi", 인천: "incheon", 부산: "busan", 대구: "daegu",
  대전: "daejeon", 광주: "gwangju", 울산: "ulsan", 세종: "sejong", 강원: "gangwon",
  충북: "chungbuk", 충남: "chungnam", 전북: "jeonbuk", 전남: "jeonnam",
  경북: "gyeongbuk", 경남: "gyeongnam", 제주: "jeju",
  // 서울 자치구 — 시도 없이 구 이름만 말하는 경우
  강남: "seoul-gangnam", 서초: "seoul-seocho", 송파: "seoul-songpa",
  강동: "seoul-gangdong", 광진: "seoul-gwangjin", 성동: "seoul-seongdong",
  종로: "seoul-jongno", 용산: "seoul-yongsan", 마포: "seoul-mapo",
  서대문: "seoul-seodaemun", 은평: "seoul-eunpyeong", 노원: "seoul-nowon",
  도봉: "seoul-dobong", 강북: "seoul-gangbuk", 성북: "seoul-seongbuk",
  동대문: "seoul-dongdaemun", 중랑: "seoul-jungnang", 강서: "seoul-gangseo",
  양천: "seoul-yangcheon", 구로: "seoul-guro", 금천: "seoul-geumcheon",
  영등포: "seoul-yeongdeungpo", 동작: "seoul-dongjak", 관악: "seoul-gwanak",
  // 예식 수요가 몰리는 생활권 이름 — 담는 시군구로
  청담: "seoul-gangnam", 압구정: "seoul-gangnam", 삼성동: "seoul-gangnam",
  역삼: "seoul-gangnam", 논현: "seoul-gangnam", 잠실: "seoul-songpa",
  여의도: "seoul-yeongdeungpo", 명동: "seoul-jung", 을지로: "seoul-jung",
  판교: "gyeonggi-seongnam", 분당: "gyeonggi-seongnam", 일산: "gyeonggi-goyang",
  // 경기 시군 — 시도 없이 시 이름만 말하는 경우
  수원: "gyeonggi-suwon", 성남: "gyeonggi-seongnam", 용인: "gyeonggi-yongin",
  고양: "gyeonggi-goyang", 부천: "gyeonggi-bucheon", 안양: "gyeonggi-anyang",
  광명: "gyeonggi-gwangmyeong", 김포: "gyeonggi-gimpo",
};

/** 긴 것부터 본다. "서대문" 을 "서" 로 먼저 먹으면 뒤가 찌꺼기로 남는다. */
export const REGION_ALIAS_KEYS: string[] = Object.keys(REGION_ALIASES).sort(
  (a, b) => b.length - a.length,
);

/** 행정 접미사. "강남구" 와 "강남" 은 같은 말이다 — 읽을 때도 풀 때도 같이 쓴다. */
export const REGION_SUFFIX_PATTERN = "(?:특별시|광역시|시|군|구|동)";

/**
 * 사람이 쓴 지역 말 → 코드. 못 알아들으면 `null` 이고, **지어내지 않는다.**
 *
 * `toRegionCode`(이행용, 라벨만 받는다)보다 **너그럽다** — 별칭과 접미사를 받는다.
 * 이행은 틀리면 되돌릴 수 없어 엄격해야 하지만, 검색과 링크는 **못 알아들으면 조건을
 * 안 걸면 그만**이라 너그러워도 손해가 없다.
 */
export function resolveRegionInput(raw: string | null): string | null {
  if (raw === null) return null;

  const text = raw.trim();
  if (text === "") return null;
  if (isRegionCode(text)) return text;

  const compact = text.replace(/\s+/g, "");
  const suffix = new RegExp("^(.+?)" + REGION_SUFFIX_PATTERN + "$");

  for (const candidate of [compact, compact.replace(suffix, "$1")]) {
    const alias = REGION_ALIASES[candidate];
    if (alias !== undefined) return alias;
  }

  // 별칭에 없어도 어휘의 라벨이면 받는다("서울 강남" · "경기 수원시").
  return toRegionCode(text);
}

/**
 * 지역을 모르는 항목을 화면이 어떻게 말하는가.
 *
 * **목록에서 빼지 않는다.** 지역을 못 옮긴 것은 업체가 한 일이 아니라 우리 쪽
 * 이행 사정이고, 빼면 그 업체는 아무 이유 없이 사라진다(참가격 지수가 없는 지역을
 * 목록에서 빼지 않기로 한 것과 같은 판단 · S3-08).
 */
export const REGION_UNKNOWN_LABEL = "지역 미등록";
export const REGION_UNKNOWN_NOTE =
  "아직 지역을 등록하지 않은 업체예요. 지역으로 거르면 이 업체는 나오지 않습니다.";

/**
 * 지역 코드는 **자격이 아니라 분류**다.
 *
 * 다만 참가격 지수(F-C-09)의 **분모**이기도 하다 — 업체가 자기 지역을 마음대로
 * 바꾸면 **표본이 적어 유리한 칸으로 옮겨 다닐 수 있다**. 그래서 지역은
 * **입점 심사 대상 정보**로 다루고 프로필에서 바꾸지 않는다(업체명·카테고리와 같다).
 */
export const REGION_IS_REVIEWED_NOTE =
  "지역은 입점 심사에서 확인한 정보라 프로필에서 바꿀 수 없어요. 바꾸려면 운영자에게 알려 주세요.";

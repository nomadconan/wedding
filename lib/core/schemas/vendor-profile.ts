// 업체 프로필·미디어 입출력 스키마 (S2-02 · 명세서 §2.2 F-V-02, §4.3, §6.3)
//
// API 입출력은 zod 로 양방향 검증한다(CLAUDE.md §6). 검증 실패는 422 다.
// 프로필 값은 **업체가 직접 쓰는 사실 진술**이다. 플랫폼이 품질·이행을 보증하는 것처럼
// 읽히는 문구를 만들지 않는다(D-24, §7.7).

import { z } from "zod";

/**
 * 시설·포함 서비스 코드.
 *
 * 자유 입력이 아니라 코드 집합으로 두는 이유: 탐색 필터(S3-03)가 같은 값으로 걸러야 하고,
 * 자유 텍스트를 허용하면 업체마다 표기가 갈려 필터가 성립하지 않는다.
 * **광고성·등급성 값을 넣지 않는다**(예: '프리미엄', '추천') — CLAUDE.md §2.2.
 */
export const VENDOR_FACILITIES = [
  "parking",
  "valet",
  "shuttle",
  "barrier_free",
  "kids_room",
  "waiting_room",
  "photo_zone",
  "pyebaek_room",
  "dressing_room",
  "banquet_hall",
  "outdoor",
  "in_house_catering",
] as const;

export type VendorFacility = (typeof VENDOR_FACILITIES)[number];

export const VendorFacilitySchema = z.enum(VENDOR_FACILITIES);

export const VENDOR_FACILITY_LABEL: Record<VendorFacility, string> = {
  parking: "주차 가능",
  valet: "발렛 파킹",
  shuttle: "셔틀버스",
  barrier_free: "배리어프리",
  kids_room: "유아 휴게실",
  waiting_room: "신부 대기실",
  photo_zone: "포토존",
  pyebaek_room: "폐백실",
  dressing_room: "드레스룸",
  banquet_hall: "연회장",
  outdoor: "야외 공간",
  in_house_catering: "자체 케이터링",
};

/** 미디어 종류. `vendor_media.type` 에 그대로 들어간다. */
export const VENDOR_MEDIA_TYPES = ["photo", "video"] as const;
export type VendorMediaType = (typeof VENDOR_MEDIA_TYPES)[number];
export const VendorMediaTypeSchema = z.enum(VENDOR_MEDIA_TYPES);

export const VENDOR_MEDIA_TYPE_LABEL: Record<VendorMediaType, string> = {
  photo: "사진",
  video: "영상",
};

/** 업체당 미디어 상한. 무제한이면 탐색 화면 로딩이 업체 입력에 좌우된다. */
export const VENDOR_MEDIA_MAX = 30;

const CapacitySchema = z
  .number()
  .int("수용 인원은 정수로 입력해 주세요.")
  .min(0, "수용 인원은 0 이상이어야 합니다.")
  .max(100_000, "수용 인원을 다시 확인해 주세요.")
  .nullable();

/**
 * 프로필 수정 입력(PUT /api/vendor/profile).
 *
 * 업체명·카테고리는 **심사 대상 정보**라 여기서 바꾸지 않는다 — 입점 신청(S2-01)에서
 * 제출한 값이 심사 근거이고, 승인 후 임의로 바꾸면 심사 결과와 화면이 어긋난다.
 * 변경이 필요하면 재심사 절차를 타야 한다(F-A-01).
 */
export const VendorProfileInputSchema = z.object({
  regionCode: z.string().trim().min(2, "지역을 입력해 주세요.").max(40),
  address: z.string().trim().max(200).nullable().default(null),
  addressDetail: z.string().trim().max(100).nullable().default(null),
  capacityMin: CapacitySchema.default(null),
  capacityMax: CapacitySchema.default(null),
  facilities: z.array(VendorFacilitySchema).max(VENDOR_FACILITIES.length).default([]),
  intro: z.string().trim().max(2000, "소개문은 2000자까지 쓸 수 있습니다.").nullable().default(null),
})
  .refine(
    (input) =>
      input.capacityMin === null || input.capacityMax === null || input.capacityMin <= input.capacityMax,
    { message: "수용 인원 하한이 상한보다 큽니다.", path: ["capacityMax"] },
  );

export type VendorProfileInput = z.input<typeof VendorProfileInputSchema>;

/** 미디어 추가 요청. 파일이 아니라 **서명 업로드 URL 발급 요청**이다. */
export const VendorMediaAddSchema = z.object({
  type: VendorMediaTypeSchema,
  fileName: z.string().trim().min(1).max(200),
  /** 대체 텍스트. 접근성(§7.5)상 사진에는 설명이 필요하다. */
  altText: z.string().trim().max(200).nullable().default(null),
});

/** 미디어 변경 묶음. §4.3 의 API 표면을 늘리지 않으려고 프로필 PUT 에 함께 싣는다. */
export const VendorMediaMutationSchema = z.object({
  add: z.array(VendorMediaAddSchema).max(10, "한 번에 10개까지 올릴 수 있습니다.").default([]),
  remove: z.array(z.string().uuid()).max(VENDOR_MEDIA_MAX).default([]),
  /** 정렬 변경. id 순서가 곧 sort_order 다. */
  order: z.array(z.string().uuid()).max(VENDOR_MEDIA_MAX).default([]),
  /** 대체 텍스트 수정. */
  updateAlt: z
    .array(z.object({ id: z.string().uuid(), altText: z.string().trim().max(200).nullable() }))
    .max(VENDOR_MEDIA_MAX)
    .default([]),
});

export const VendorProfileUpdateSchema = z.object({
  profile: VendorProfileInputSchema,
  media: VendorMediaMutationSchema.default({ add: [], remove: [], order: [], updateAlt: [] }),
});

export type VendorProfileUpdate = z.input<typeof VendorProfileUpdateSchema>;

/**
 * 변경 이력 표시용 필드 라벨(F-V-02 "변경 이력 보관").
 * 이력은 `audit_logs.before_json/after_json` 에 쌓고 화면에서 이 라벨로 읽는다.
 */
export const VENDOR_PROFILE_FIELD_LABEL: Record<string, string> = {
  region_code: "지역",
  address: "주소",
  address_detail: "상세 주소",
  capacity_min: "수용 인원(최소)",
  capacity_max: "수용 인원(최대)",
  facilities: "시설·포함 서비스",
  intro: "소개문",
  media: "미디어",
};

/**
 * 변경된 필드만 골라낸다. 이력에 "바뀌지 않은 값"을 남기면 무엇이 달라졌는지 읽을 수 없다.
 * 배열은 순서까지 같아야 같은 값으로 본다 — 미디어 정렬 변경도 이력이기 때문이다.
 */
export function diffProfileFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

  return [...keys].filter((key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null));
}

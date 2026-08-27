// 후기 어뷰징 탐지 큐 (S8-11 · F-A-13)
//
// ══════════════════════════════════════════════════════════════════════════
// **탐지는 판정이 아니라 큐다**(D-24). 그리고 **기준이 없는 신호는 세지 않는다**(D-123).
// ══════════════════════════════════════════════════════════════════════════
//
// 여기서 나오는 것은 전부 "봐 달라" 는 표시다. 자동 비공개도 자동 제재도 없고,
// 후기를 내리는 유일한 경로는 운영자가 사유를 적는 것이다(0058 CHECK).
//
// 신호를 셋으로 나눈 기준은 **우리가 그 수를 셀 근거를 갖고 있는가**다.
//
//   `reported`         신고가 하나라도 열려 있다. **셀 근거가 있다** — 사람이 실제로
//                      신고했다는 사실이고, 임계값을 정할 것이 없다.
//   `no_body_extreme`  본문 없이 모든 축을 최저(또는 최고)로 줬다. **셀 근거가 있다** —
//                      1 과 5 는 척도의 끝이고 "본문이 비었다" 는 이분법이다.
//                      다만 이것은 **내용에 대한 판단이 아니다**: 짧게 별점만 주는
//                      사람은 얼마든지 있고, 그래서 큐에 올릴 뿐 아무 조치도 붙이지
//                      않는다.
//   `burst`            같은 커플이 짧은 기간에 여러 건을 썼다. **셀 근거가 없다** —
//                      "얼마나 짧은 기간에 몇 건" 을 명세가 정해 주지 않았고, 웨딩
//                      준비는 홀·스드메·사진을 몇 달 안에 한꺼번에 계약하는 일이라
//                      **정상 사용자가 하루에 다섯 건을 쓰는 것이 자연스럽다.**
//                      숫자를 지어내면 큐가 곧 정상 사용자 목록이 된다(O-20).
//
// `burst` 는 `app_settings` 의 값이 없으면 **세지 않고 그 사실을 말한다.** 빈 목록을
// 돌려주면 API 를 읽는 사람이 "몰아쓰기 없음" 으로 읽는다 — S8-10 이 `blocked` 를
// 본문에 실은 것과 같은 이유다(함정 2).

/** 임계값이 정해질 때까지 기다리는 자리. */
export const REVIEW_ABUSE_OPEN_ISSUE = "O-20";

export const ABUSE_SIGNALS = ["reported", "no_body_extreme", "burst"] as const;
export type AbuseSignal = (typeof ABUSE_SIGNALS)[number];

export const ABUSE_SIGNAL_LABEL: Record<AbuseSignal, string> = {
  reported: "신고 접수됨",
  no_body_extreme: "본문 없는 극단 점수",
  burst: "짧은 기간 몰아쓰기",
};

/**
 * `app_settings` 에서 읽은 몰아쓰기 임계. **미결이면 `null`** 이다.
 * `readIntSetting` 이 `null` 을 0 으로 읽지 않는다(S7-17 이 물린 자리) — 0시간·0건
 * 임계는 "모든 후기가 몰아쓰기" 라는 뜻이라 미결과 정반대다.
 */
export type BurstThreshold = {
  windowHours: number | null;
  minCount: number | null;
};

export function burstUsable(threshold: BurstThreshold): boolean {
  return (
    threshold.windowHours !== null &&
    threshold.minCount !== null &&
    threshold.windowHours > 0 &&
    threshold.minCount > 1
  );
}

/** 탐지에 쓰는 후기 한 건. **본문을 담지 않는다** — 비었는지만 본다(§7.3). */
export type AbuseSample = {
  reviewId: string;
  vendorId: string;
  coupleId: string;
  createdAt: string;
  hasBody: boolean;
  scores: (number | null)[];
  openReportCount: number;
};

/**
 * 큐 한 줄. `basis` 는 운영자가 **다시 세어 볼 수 있는 문장**이다 —
 * 근거 없는 플래그를 만들지 않는다(S8-10 이 정한 규칙과 같다).
 */
export type AbuseFlag = {
  signal: AbuseSignal;
  reviewId: string;
  vendorId: string;
  basis: string;
};

export type AbuseScan =
  | { status: "scanned"; flags: AbuseFlag[] }
  | { status: "blocked"; reason: "threshold_undecided"; openIssue: string };

const EXTREMES = [1, 5];

/** 남긴 점수가 전부 척도의 같은 끝에 있는가. 점수가 없으면 해당 없음이다. */
function allExtreme(scores: (number | null)[]): number | null {
  const given = scores.filter((score): score is number => score !== null);
  if (given.length === 0) return null;

  const first = given[0];
  if (!EXTREMES.includes(first)) return null;

  return given.every((score) => score === first) ? first : null;
}

/** 신고·극단 점수 — **임계값이 필요 없는 신호 둘.** */
export function detectDirectSignals(samples: readonly AbuseSample[]): AbuseFlag[] {
  const flags: AbuseFlag[] = [];

  for (const sample of samples) {
    if (sample.openReportCount > 0) {
      flags.push({
        signal: "reported",
        reviewId: sample.reviewId,
        vendorId: sample.vendorId,
        basis: `처리 대기 신고 ${sample.openReportCount}건`,
      });
    }

    const extreme = sample.hasBody ? null : allExtreme(sample.scores);
    if (extreme !== null) {
      flags.push({
        signal: "no_body_extreme",
        reviewId: sample.reviewId,
        vendorId: sample.vendorId,
        basis: `본문 없음 · 남긴 점수 모두 ${extreme}점`,
      });
    }
  }

  return flags;
}

/**
 * 몰아쓰기 — **임계값이 있어야만 센다.**
 *
 * 창(window) 안에 같은 커플의 후기가 `minCount` 건 이상이면 **그 창에 속한 후기
 * 전부**를 큐에 올린다. 마지막 한 건만 올리면 운영자가 나머지를 찾아 헤맨다.
 */
export function detectBurst(
  samples: readonly AbuseSample[],
  threshold: BurstThreshold,
): AbuseScan {
  if (!burstUsable(threshold)) {
    return {
      status: "blocked",
      reason: "threshold_undecided",
      openIssue: REVIEW_ABUSE_OPEN_ISSUE,
    };
  }

  const windowMs = (threshold.windowHours as number) * 60 * 60 * 1000;
  const minCount = threshold.minCount as number;

  const byCouple = new Map<string, AbuseSample[]>();
  for (const sample of samples) {
    const bucket = byCouple.get(sample.coupleId);
    if (bucket) bucket.push(sample);
    else byCouple.set(sample.coupleId, [sample]);
  }

  const flagged = new Map<string, AbuseFlag>();

  for (const [, bucket] of byCouple) {
    const sorted = [...bucket].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );

    // 미끄러지는 창. 시작점을 하나씩 옮기며 창 안의 건수를 센다.
    let start = 0;
    for (let end = 0; end < sorted.length; end += 1) {
      while (Date.parse(sorted[end].createdAt) - Date.parse(sorted[start].createdAt) > windowMs) {
        start += 1;
      }

      const count = end - start + 1;
      if (count < minCount) continue;

      for (let i = start; i <= end; i += 1) {
        const sample = sorted[i];
        flagged.set(sample.reviewId, {
          signal: "burst",
          reviewId: sample.reviewId,
          vendorId: sample.vendorId,
          basis: `${threshold.windowHours}시간 안에 같은 커플이 ${count}건 작성`,
        });
      }
    }
  }

  return { status: "scanned", flags: [...flagged.values()] };
}

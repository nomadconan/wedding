import { readSetting } from "@/lib/app-settings";

/**
 * 쿠폰 운영 파라미터 (S5-12 · §7.4)
 *
 * **한 곳에서만 읽는다.** 같은 키를 두 곳이 다른 모양으로 읽으면 언젠가 한쪽만
 * 고쳐지고, 그때 화면과 결제가 다른 규칙을 쓴다.
 */

/**
 * 중복 사용 규칙 (`app_settings.coupon.stacking`).
 *
 * **값이 없으면 `single` 이다.** 미결 파라미터를 코드가 대신 답하는 것이 아니라
 * **스키마가 정한 기본값**을 따르는 것이다(0032) — 중복을 여는 쪽이 위험한 방향이라
 * 모를 때는 닫는다. 여는 것은 설정에 값을 넣는 명시적 행위여야 한다.
 */
export async function readStackingMode(): Promise<"single" | "multiple"> {
  const setting = await readSetting("coupon.stacking");
  const mode = (setting as { mode?: unknown } | null)?.mode;

  return mode === "multiple" ? "multiple" : "single";
}

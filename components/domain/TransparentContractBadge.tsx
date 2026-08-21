import { Badge } from "@/components/ui/badge";
import {
  BADGE_CRITERIA_PUBLIC_NOTICE,
  BADGE_LABEL,
  BADGE_SCOPE_NOTICE,
} from "@/lib/core/compliance/compliance";

/**
 * 투명 계약 배지 — 고객 화면용 (S7-13 · F-V-10)
 *
 * ── 배지만 따로 그리지 않는다 ───────────────────────────────────────────────
 * 이 컴포넌트는 **배지·진단 날짜·범위 고지를 한 덩어리로** 낸다. 셋을 떼어 쓸 수 있게
 * 만들면 언젠가 목록 카드에 배지만 붙게 되고, 그 순간 배지는 사실이 아니라 **광고**가
 * 된다 — 우리가 실제로 아는 것은 "업체가 제출한 약관이 우리 룰에 걸리지 않았다" 뿐이다
 * (D-03 · D-24 · CLAUDE.md §2.3).
 *
 * ── 날짜가 없으면 배지도 없다 ───────────────────────────────────────────────
 * 약관은 바뀌므로 배지는 **언제 진단한 것인지**와 함께여야 뜻이 있다. 날짜를 못 읽었으면
 * (배지 플래그만 있고 근거 행이 없는 이상 상태) **아무것도 그리지 않는다** — 근거 없이
 * 붙은 배지가 화면에 나가는 것보다 안 보이는 편이 낫다.
 */
export function TransparentContractBadge({ scannedAt }: { scannedAt: string | null }) {
  if (scannedAt === null) return null;

  return (
    <div className="space-y-1 rounded-lg border border-border p-3" data-testid="vendor-badge-transparent">
      <div className="flex items-center gap-2">
        <Badge>{BADGE_LABEL}</Badge>
        <span className="text-caption text-muted-foreground">{scannedAt.slice(0, 10)} 진단</span>
      </div>
      <p className="text-caption text-muted-foreground">{BADGE_CRITERIA_PUBLIC_NOTICE}</p>
      {/* **무엇까지 참인지** 배지 옆에 늘 적는다. */}
      <p className="text-caption text-muted-foreground">{BADGE_SCOPE_NOTICE}</p>
    </div>
  );
}

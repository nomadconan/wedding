import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { LoadingState } from "@/components/ui/LoadingState";

/** /onboarding 로딩 상태 (§6 — 데이터 화면 3종 상태). */
export default function OnboardingLoading() {
  return (
    <ConsumerShell title="시작하기" hideTabBar>
      <LoadingState variant="block" rows={3} />
    </ConsumerShell>
  );
}

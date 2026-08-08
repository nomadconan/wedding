import { Info } from "lucide-react";

import { AI_DISCLAIMER } from "@/lib/core/legal";
import { cn } from "@/lib/utils";

/**
 * AI 산출물 법적 고지 (T-04b)
 *
 * 명세서 §5.1 / §6 공통 UI 규칙 / §7.7, CLAUDE.md §2.3:
 *   "AI 결과가 포함된 **모든 화면**에 '참고 정보이며 법률 자문이 아님' 고지를
 *    **상시(고정) 노출**한다. 숨김·접힘·툴팁 처리 금지."
 *
 * 그래서 이 컴포넌트에는 접기·닫기·툴팁 옵션이 **없다.** 넣지 말 것.
 * 문구는 `lib/core/legal.ts` 의 `AI_DISCLAIMER` 단일 진실을 그대로 렌더한다 —
 * 화면마다 문구를 다시 쓰면 ReportSchema 의 고지 검증과 어긋난다.
 *
 * 근거 조항(표준약관 / 소비자분쟁해결기준)은 `basisRef` 로 함께 제시한다.
 */
export type AiDisclaimerProps = {
  /**
   * 근거 조항 출처. finding 의 `basis_ref` 나 위약금 결과의 `basisRef` 를 넘긴다.
   * 여러 건이면 배열로 넘기면 중복을 제거해 나열한다.
   */
  basisRef?: string | string[];
  /** 'block' 은 카드 상단 고정용, 'inline' 은 좁은 영역용. */
  variant?: "block" | "inline";
  className?: string;
};

export function AiDisclaimer({ basisRef, variant = "block", className }: AiDisclaimerProps) {
  const refs =
    basisRef === undefined ? [] : [...new Set(Array.isArray(basisRef) ? basisRef : [basisRef])];

  return (
    <aside
      // 보조 정보이지 경보가 아니다. role="note" 로 스크린리더에 성격을 알린다.
      role="note"
      aria-label="AI 산출물 안내"
      data-testid="ai-disclaimer"
      className={cn(
        "flex gap-2 rounded-lg border border-border bg-muted text-muted-foreground",
        variant === "block" ? "p-3" : "px-2.5 py-2",
        className,
      )}
    >
      <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-neutral-400" />

      <div className="space-y-1">
        <p className={cn(variant === "block" ? "text-sm" : "text-caption", "leading-relaxed")}>
          {AI_DISCLAIMER}
        </p>

        {refs.length > 0 ? (
          <p className="text-caption text-neutral-500">근거 · {refs.join(" / ")}</p>
        ) : null}
      </div>
    </aside>
  );
}

export default AiDisclaimer;

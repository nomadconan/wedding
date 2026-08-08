import { Info } from "lucide-react";

import {
  BROKER_NOTICE,
  BROKER_NOTICE_TERMS_HINT,
  BROKER_NOTICE_TERMS_LABEL,
} from "@/lib/core/legal";
import { cn } from "@/lib/utils";

/**
 * 플랫폼 지위 고지 (S1-03 · D-24)
 *
 * 명세서 §6 공통 UI 규칙 / §7.7:
 *   "플랫폼은 통신판매중개자이며 계약 당사자가 아님을 **거래 관련 화면에 고지한다.**
 *    대상: 계약·결제·상담 예약·분쟁 관련 화면."
 *
 * `AiDisclaimer` 와 같은 방식이다.
 *  - 접기·닫기·툴팁 옵션이 **없다.** 추가하지 말 것.
 *  - 문구는 `lib/core/legal.ts` 의 `BROKER_NOTICE` 단일 진실을 **그대로** 렌더한다.
 *    화면마다 문구를 다시 쓰면 고지 내용이 화면별로 갈라진다.
 *
 * 문구는 사실 진술까지만이다. 법적 효력을 단정하거나 책임을 면제하는 표현을 쓰지 않으며,
 * 구체적 약관 문안은 **O-03 법무 검수 대기**라 여기서 확정하지 않는다.
 * 상세는 이용약관 링크 자리만 둔다 — `termsHref` 가 정해지면 링크가 붙는다.
 */
export type BrokerNoticeProps = {
  /**
   * 표시 변형.
   *  - `inline`  결제·계약 화면 **하단 고정** 영역용. 본문과 같은 폭의 블록이다.
   *              고정 배치 자체는 화면 레이아웃의 몫이고 이 컴포넌트는 블록만 제공한다.
   *  - `compact` 카드 안 **한 줄**용.
   */
  variant?: "inline" | "compact";
  /**
   * 이용약관 상세 링크. O-03 확정 전에는 넘기지 않아도 되며,
   * 그때는 참조 안내 문장만 나오고 링크는 붙지 않는다.
   */
  termsHref?: string;
  className?: string;
};

export function BrokerNotice({ variant = "inline", termsHref, className }: BrokerNoticeProps) {
  const compact = variant === "compact";

  const terms = (
    <>
      {BROKER_NOTICE_TERMS_HINT}
      {termsHref ? (
        <>
          {" "}
          <a
            href={termsHref}
            className="font-medium text-brand-600 underline underline-offset-2"
            data-testid="broker-notice-terms-link"
          >
            {BROKER_NOTICE_TERMS_LABEL}
          </a>
        </>
      ) : null}
    </>
  );

  if (compact) {
    return (
      <p
        // 보조 정보이지 경보가 아니다(AiDisclaimer 와 동일).
        role="note"
        aria-label="플랫폼 지위 안내"
        data-testid="broker-notice"
        data-variant="compact"
        className={cn("text-caption leading-relaxed text-muted-foreground", className)}
      >
        {BROKER_NOTICE} <span className="text-neutral-500">{terms}</span>
      </p>
    );
  }

  return (
    <aside
      role="note"
      aria-label="플랫폼 지위 안내"
      data-testid="broker-notice"
      data-variant="inline"
      className={cn(
        "flex gap-2 rounded-lg border border-border bg-muted p-3 text-muted-foreground",
        className,
      )}
    >
      <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-neutral-400" />

      <div className="space-y-1">
        <p className="text-sm leading-relaxed">{BROKER_NOTICE}</p>
        <p className="text-caption text-neutral-500">{terms}</p>
      </div>
    </aside>
  );
}

export default BrokerNotice;

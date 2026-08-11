import Link from "next/link";

import { CONTACT_PATHS } from "@/lib/core/inquiry/inquiry";
import { cn } from "@/lib/utils";

/**
 * 세 경로 안내 (S4-12 · F-C-13 · F-C-27 · F-C-28)
 *
 * 업체에 말을 거는 길이 셋인데, 화면이 설명하지 않으면 사용자는 아무 데나 쓰고
 * 그러면 셋 다 제 역할을 못 한다. 겹치는 것처럼 보이지만 **결과물이 다르다** —
 * 문의는 견적서를, 채팅은 합의를, 게시판은 공개 지식을 남긴다.
 *
 * 문구는 `lib/core` 가 갖는다. 문의함·업체 상세가 같은 문장을 쓰기 위해서다.
 */
export function ContactPathGuide({
  current,
  vendorId,
  className,
}: {
  /** 지금 보고 있는 경로. 그 줄만 강조하고 링크를 걸지 않는다. */
  current?: (typeof CONTACT_PATHS)[number]["key"];
  /** 업체 상세에서 쓸 때. 게시판 링크가 업체별이라 id 가 필요하다. */
  vendorId?: string;
  className?: string;
}) {
  return (
    <section
      className={cn("rounded-lg border border-border bg-secondary/40 p-4", className)}
      data-testid="contact-path-guide"
    >
      <h2 className="text-sm font-semibold text-foreground">어떤 방법으로 물어볼까요?</h2>

      <ul className="mt-2 space-y-2">
        {CONTACT_PATHS.map((path) => {
          const href = path.key === "qna" && vendorId ? `/qna/${vendorId}` : path.href;
          const active = current === path.key;

          const label = (
            <span className={cn("text-sm font-medium", active ? "text-foreground" : "text-brand-600")}>
              {path.label}
              {active ? " (지금 보는 화면)" : ""}
            </span>
          );

          return (
            <li key={path.key} data-path={path.key}>
              {active || href === null ? label : <Link href={href}>{label}</Link>}
              <p className="text-caption text-muted-foreground">{path.when}</p>
              <p className="text-caption text-muted-foreground">남는 것: {path.result}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default ContactPathGuide;

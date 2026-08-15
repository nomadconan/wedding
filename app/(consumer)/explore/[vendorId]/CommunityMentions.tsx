import Link from "next/link";

import { UNVERIFIED_LABEL, UNVERIFIED_NOTE } from "@/lib/core/community/community";
import { COMMUNITY_FLAG, isFeatureEnabled } from "@/lib/flags";
import { vendorMentions } from "@/lib/community/loader";
import { createClient } from "@/lib/supabase/server";

/**
 * 업체 상세의 '커뮤니티 언급' (F-C-33 · 명세서 §6.2)
 *
 * **검증 후기와 시각적으로 분리한다.** 명세가 "두 영역을 같은 카드 모양으로 그리지
 * 않는다" 고 적었고, 그래서 여기는 **점선 테두리 + 라벨 머리글**이다 — 후기(S8-11)가
 * 붙을 자리는 실선 카드다. 모양이 같으면 라벨은 읽히지 않는다.
 *
 * **'미검증 경험담' 라벨은 필수다.** `verified_purchase` 가 참인 글이 섞여 있어도
 * 라벨은 그대로다 — 거래 이력은 힌트일 뿐 검증 후기가 아니다(S7-14).
 *
 * 플래그가 꺼져 있으면 **아무것도 그리지 않는다.** 커뮤니티가 닫힌 동안 업체 상세에
 * 빈 섹션이 뜨면 "언급이 없다" 로 읽히는데, 사실은 아직 열지 않은 것이다.
 */
export async function CommunityMentions({ vendorId }: { vendorId: string }) {
  if (!(await isFeatureEnabled(COMMUNITY_FLAG))) return null;

  const supabase = await createClient();
  const mentions = await vendorMentions(supabase, vendorId).catch(() => []);

  if (mentions.length === 0) return null;

  return (
    <section
      className="space-y-2 rounded-lg border border-dashed border-border p-4"
      data-testid="vendor-community-mentions"
    >
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">커뮤니티 언급</h2>
        <p className="text-caption font-medium text-muted-foreground">{UNVERIFIED_LABEL}</p>
        <p className="text-caption text-neutral-500">{UNVERIFIED_NOTE}</p>
      </div>

      <ul className="space-y-1">
        {mentions.map((mention) => (
          <li key={mention.postId}>
            <Link
              href={`/community/${mention.postId}`}
              className="block truncate text-sm text-foreground underline-offset-2 hover:underline"
            >
              {mention.title}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default CommunityMentions;

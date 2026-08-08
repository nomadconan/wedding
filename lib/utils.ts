import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// tailwind-merge 는 클래스 이름을 보고 어떤 그룹인지 **추측**한다.
// 이 프로젝트의 금액·제목 스케일(`text-amount`, `text-unit` 등)은 Tailwind 기본 이름이 아니라
// 커스텀 fontSize 토큰이라, 기본 설정에서는 **글자색으로 오인**된다.
// 그러면 `cn("text-amount", "text-foreground")` 가 색 충돌로 판정돼 `text-amount` 가 사라진다.
// 금액이 본문 크기로 렌더되는 사고가 나므로 폰트 크기 그룹에 명시적으로 등록한다.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "display-lg",
            "display",
            "display-sm",
            "amount-lg",
            "amount",
            "amount-sm",
            "unit",
            "caption",
          ],
        },
      ],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

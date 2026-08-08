"use client";

import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * 에러 상태 (T-04b)
 *
 * 명세서 §6 공통 UI 규칙: 로딩·빈 상태·에러 상태 3종을 모든 데이터 화면에 정의한다.
 *
 * 규칙
 *  - 사용자가 **할 수 있는 일**을 먼저 보여준다(다시 시도 / 돌아가기).
 *  - 에러 코드는 문의 시 대조용으로 작게만 노출한다. 스택·내부 메시지는 절대 노출하지 않는다.
 *  - 계약서 원문·Storage 경로 같은 값은 어떤 경우에도 이 화면에 들어오면 안 된다
 *    (CLAUDE.md §5.3). description 에 서버 예외 메시지를 그대로 넘기지 말 것.
 */
export type ErrorStateProps = {
  title?: string;
  description?: string;
  /** `DOC_UPLOAD_FAILED` 같은 도메인 에러 코드(§6 응답 포맷). */
  code?: string;
  /** 다시 시도 핸들러. 없으면 버튼을 숨긴다. */
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
};

export function ErrorState({
  title = "불러오지 못했어요",
  description = "잠시 후 다시 시도해 주세요. 문제가 계속되면 고객센터로 알려주세요.",
  code,
  onRetry,
  retryLabel = "다시 시도",
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-4 px-gutter py-12 text-center",
        className,
      )}
      data-testid="error-state"
    >
      <span
        aria-hidden="true"
        className="flex h-12 w-12 items-center justify-center rounded-full bg-danger-surface text-danger"
      >
        <AlertTriangle className="h-6 w-6" />
      </span>

      <div className="space-y-1.5">
        <p className="text-base font-semibold text-foreground">{title}</p>
        <p className="mx-auto max-w-[22rem] text-sm text-muted-foreground">{description}</p>
      </div>

      {onRetry ? (
        <div className="w-full max-w-[18rem] pt-1">
          <Button size="touch" variant="secondary" onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      ) : null}

      {code ? <p className="text-caption text-neutral-400">오류 코드 {code}</p> : null}
    </div>
  );
}

export default ErrorState;

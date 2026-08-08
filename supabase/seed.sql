-- 시드: 검출 룰 / 위약금 룰 / 추가금 사전
-- TODO: detect_rules 20종, penalty_rules(시점 밴드), extra_fee_dict(30+ 항목: 원본구매비 등)

-- =============================================================================
-- app_settings — 가변 파라미터 자리 (S5-01, 명세서 §7.4, CLAUDE.md §7.6)
-- =============================================================================
-- **값을 여기서 확정하지 않는다.** O-02(수수료 요율)·운영 정책이 정해지기 전이므로
-- 키와 형식만 만들어 두고 `value` 는 null 로 남긴다.
--
--  * 코드가 요율·금액을 하드코딩하지 않고 **전역 기본값조차 이 테이블에서 읽는다.**
--  * `value` 가 null 이면 값 미확정이다. 읽는 쪽은 임의 기본값을 만들어내지 말고
--    명시적으로 실패해야 한다(lib/core/pricing/rates.ts 의 해석 실패와 같은 원칙).
--  * `unit` 은 값의 단위다. `bp` 는 basis point 정수(1% = 100bp)를 뜻한다.
--
-- 값이 확정되면 이 파일이 아니라 **운영 콘솔(F-A-15)이나 별도 마이그레이션으로 갱신**한다.
-- 시드는 로컬 초기화용이므로 운영 값의 출처가 되지 않는다.
-- =============================================================================

insert into public.app_settings (key, value_json, description) values
  (
    'commission.default_fee_rate_bp',
    '{"value": null, "unit": "bp", "status": "undecided"}'::jsonb,
    'TODO: O-02 확정 후 입력 — 업체 수수료 전역 기본 요율(bp). commission_rates 의 global 행이 없을 때의 최종 기본값.'
  ),
  (
    'planner.default_fee_rate_bp',
    '{"value": null, "unit": "bp", "status": "undecided"}'::jsonb,
    'TODO: O-02 확정 후 입력 — 플래너 수수료 전역 기본 요율(bp). 선택한 카테고리에만 부과된다(D-17).'
  ),
  (
    'planner.payout_grace_days',
    '{"value": null, "unit": "days", "status": "undecided"}'::jsonb,
    'TODO: 운영 정책 확정 후 입력 — 플래너 수수료 지급 유예 기간(일). earned_at + 유예 = payable_at (D-21).'
  ),
  (
    'payment.split_ratios_bp',
    '{"value": null, "unit": "bp[]", "status": "undecided"}'::jsonb,
    'TODO: 운영 정책 확정 후 입력 — 분할 결제 회차별 비율(bp 배열, 합 10000). 초기 운영은 2회 분할(D-21).'
  ),
  (
    'consultation.deposit_amount',
    '{"value": null, "unit": "krw", "status": "undecided"}'::jsonb,
    'TODO: 운영 정책 확정 후 입력 — 노쇼 방지 보증금액(원). 이행 시 전액 환불(D-22).'
  ),
  (
    'consultation.cancel_cutoff_hours',
    '{"value": null, "unit": "hours", "status": "undecided"}'::jsonb,
    'TODO: 운영 정책 확정 후 입력 — 위약 없이 취소 가능한 시한(시간).'
  ),
  (
    'consultation.confirm_deadline_hours',
    '{"value": null, "unit": "hours", "status": "undecided"}'::jsonb,
    'TODO: 운영 정책 확정 후 입력 — 이행 확인 응답 기한(시간). 무응답 기본값은 환불이다(§3.11).'
  )
on conflict (key) do nothing;

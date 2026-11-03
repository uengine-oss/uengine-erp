// Words for the leave screens. Only display: every rule is in the database.
export const STATUS_LABEL: Record<string, string> = { pending: '승인 대기', approved: '승인', rejected: '반려', cancelled: '취소' }
export const STATUS_COLOR: Record<string, string> = { pending: 'amber', approved: 'green', rejected: 'red', cancelled: 'gray' }
export const KIND_LABEL: Record<string, string> = { monthly: '1년 미만 월 부여', annual: '연 부여', prorated: '회계연도 비례', manual: '수동' }
export const ATTENDANCE_LABEL: Record<string, string> = {
  verified: '출근율 확인함',
  unverified: '출근율을 확인하지 못했습니다',
  not_applicable: '해당 없음',
}
export const HALF_LABEL: Record<string, string> = { am: '오전 반차', pm: '오후 반차' }

/** Days as people say them: 15일, 0.5일. */
export const fmtDays = (v: unknown): string => `${Math.round(Number(v ?? 0) * 100) / 100}일`
export const dateRange = (from: string, to: string): string => (from === to ? from : `${from} ~ ${to}`)

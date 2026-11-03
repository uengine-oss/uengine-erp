// Words for the attendance screens. Only display: every rule is in the database.
export const DAY_STATUS: Record<string, string> = {
  worked: '근무', open: '근무 중', missing_out: '퇴근 누락', leave: '휴가', absent: '결근', off: '쉬는 날', upcoming: '', before: '기록 전', after: '퇴사 후',
}
export const DAY_COLOR: Record<string, string> = { worked: 'green', open: 'amber', missing_out: 'red', leave: 'navy', absent: 'red', off: 'gray', upcoming: 'gray', before: 'gray', after: 'gray' }
export const WEEK_STATUS: Record<string, string> = { ok: '여유', risk: '넘길 위험', over: '주 52시간 초과', off: '확인 안 함' }
export const WEEK_COLOR: Record<string, string> = { ok: 'green', risk: 'amber', over: 'red', off: 'gray' }

/** 8시간 30분. Empty when there is nothing to say. */
export function fmtMinutes(v: unknown): string {
  if (v === null || v === undefined || v === '') return ''
  const m = Math.round(Number(v))
  const h = Math.floor(Math.abs(m) / 60)
  const rest = Math.abs(m) % 60
  const text = h && rest ? `${h}시간 ${rest}분` : h ? `${h}시간` : `${rest}분`
  return m < 0 ? `-${text}` : text
}

export const clockTime = (iso: unknown): string => (iso ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(String(iso))) : '')

// How the analytics screens write numbers. Only formatting: every figure comes from a model or the database.
import { currency, fmtMoney, fmtNumber } from '../../lib/format'
import type { Band } from '../../lib/forecast/types.ts'

export const STATE_LABEL: Record<string, string> = { locked: '잠김', insufficient: '근거 부족', ready: '사용 가능' }
export const STATE_COLOR: Record<string, string> = { locked: 'gray', insufficient: 'amber', ready: 'green' }

const money = (v: number): string => fmtMoney(Math.round(v))
const count = (v: number): string => fmtNumber(Math.round(v))
const signed = (text: string, v: number): string => (Math.round(v) > 0 ? `+${text}` : text)

export const moneyWithUnit = (v: number): string => `${money(v)} ${currency()}`.trim()
export const fmtQty = count
export const fmtMoneyPlain = money
export const fmtDelta = (v: number): string => signed(money(v), v)
export const fmtQtyDelta = (v: number): string => signed(count(v), v)
export const fmtPercent = (v: number | null | undefined, digits = 0): string => (v === null || v === undefined ? '-' : `${(v * 100).toFixed(digits)}%`)
/** How likely, without claiming certainty: 200 runs all agreeing is not a promise. */
export const fmtChance = (v: number): string => (v >= 0.995 ? '99% 이상' : `${Math.round(v * 100)}%`)
export const fmtDays = (v: number | null | undefined): string => (v === null || v === undefined ? '-' : `${fmtNumber(Math.round(v * 10) / 10)}일`)

export function bandText(b: Band, f: (v: number) => string = count): string {
  const low = f(b.p10)
  const high = f(b.p90)
  return low === high ? low : `${low} ~ ${high}`
}

/** A range carries its unit in words, so it can be written the way that unit reads. */
export function rangeValue(v: number, unit: string): string {
  if (/매출|입금|이익|금액/.test(unit)) return moneyWithUnit(v)
  if (unit === '일') return fmtDays(v)
  return count(v)
}

/** Short enough for a chart's axis, where the exact figure is one hover away. */
export function fmtAxis(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e8) return `${fmtNumber(Math.round((v / 1e8) * 10) / 10)}억`
  if (a >= 1e4) return `${fmtNumber(Math.round((v / 1e4) * 10) / 10)}만`
  return fmtNumber(v)
}

/** Have and need, read together. A long unit gets its own space. */
export const haveOfNeed = (have: number, need: number, unit: string): string => `${have.toLocaleString('ko-KR')} / ${need.toLocaleString('ko-KR')}${unit.length > 2 ? ' ' : ''}${unit}`

export const CASE_LABEL: Record<string, string> = {
  stockout_days: '기록된 품절일', silent_days_set_aside: '판매가 끊겨 뺀 날', paid: '입금 완료', open: '미입금', episodes: '품절 사례', changed_partners: '조건이 바뀐 거래처',
}

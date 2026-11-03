import { session } from './session'

export function decimals(): number {
  const d = Number(session.company?.state?.decimal_places)
  return Number.isFinite(d) ? d : 0
}
export function currency(): string {
  return session.company?.state?.currency ?? ''
}
function timezone(): string {
  return session.company?.state?.timezone || 'Asia/Seoul'
}

export function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

export function fmtMoney(v: unknown): string {
  const n = toNumber(v)
  if (n === null) return ''
  const d = decimals()
  return n.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d })
}
export function fmtNumber(v: unknown): string {
  const n = toNumber(v)
  if (n === null) return ''
  return n.toLocaleString('ko-KR', { maximumFractionDigits: 6 })
}
export function fmtInteger(v: unknown): string {
  const n = toNumber(v)
  return n === null ? '' : n.toLocaleString('ko-KR', { maximumFractionDigits: 0 })
}

function dateTimeParts(iso: string): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone(), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d)
}
export function fmtDateTime(iso: unknown): string {
  if (!iso) return ''
  return dateTimeParts(String(iso)) ?? String(iso)
}
export function fmtTime(iso: unknown): string {
  return fmtDateTime(iso).slice(11, 16)
}
export function fmtDay(iso: unknown): string {
  return fmtDateTime(iso).slice(0, 10)
}
export function fmtDate(v: unknown): string {
  return v ? String(v).slice(0, 10) : ''
}

export function fmtBytes(n: unknown): string {
  const v = toNumber(n) ?? 0
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB`
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const pa = String(a ?? '0').split('.').map(Number)
  const pb = String(b ?? '0').split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d < 0 ? -1 : 1
  }
  return 0
}

/** Picks the Korean particle that fits the word's last sound: josa('주문', '이', '가') -> '주문이'. */
export function josa(word: string, withFinal: string, withoutFinal: string): string {
  const code = word.charCodeAt(word.length - 1)
  const hangul = code >= 0xac00 && code <= 0xd7a3
  const hasFinal = hangul ? (code - 0xac00) % 28 !== 0 : /[0-9a-zA-Z]$/.test(word) ? /[013678lmnrLMNR]$/.test(word) : false
  return `${word}${hasFinal ? withFinal : withoutFinal}`
}

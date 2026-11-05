// The read side (sql/72_read_models.sql): figures kept up to date from the ledger as events arrive. Screens read them in
// one call and say how fresh they are. Every number still comes from the database; this only asks and formats.
import { rpc } from './api'

export interface ModelStatus {
  name: string
  label: string
  /** The person may read what this model is made of. */
  readable: boolean
  /** Part of it is hidden from this person record by record: the ledger gives the true share. */
  partial: boolean
  /** Events after its cursor. Zero means it has read everything written so far. */
  behind: number
  applied: number
  last_event_at: string | null
  refreshed_at: string | null
  refresh_ms: number | null
  refresh_events: number | null
  reset_at: string | null
  rebuilt_at: string | null
  rebuild_ms: number | null
  failures: number
  /** Admins only. */
  last_error?: string | null
  rows?: number | null
  bytes?: number | null
}

export interface ReadModelStatus { now: string; cron: boolean; models: ModelStatus[] }

export interface MonthRow { month: string; revenue: number; qty?: number }
export interface Period { from: string; to: string; revenue: number; qty: number; orders: number }

export interface Dashboard {
  on: string
  timezone: string
  read_ms: number
  freshness: ModelStatus[]
  sales?: { this_month: Period; last_month_same: Period; last_month: Period; trend: MonthRow[]; top: { product_id: string; name: string; revenue: number; qty: number }[] }
  stock?: { qty: number; items: number; empty: number; by_warehouse: { warehouse_id: string | null; name: string; qty: number | null; items: number }[] }
  books?: { debit: number; credit: number; balanced: boolean; this_month: { income: number; expense: number; result: number }; last_month: { income: number; expense: number; result: number } }
}

export interface Comparison {
  from: string
  to: string
  behind: number
  same: boolean
  events: number
  read_model: { ms: number; rows: MonthRow[] }
  ledger: { ms: number; rows: MonthRow[] }
}

export const readModelStatus = (detail = false): Promise<ReadModelStatus> => rpc<ReadModelStatus>('erp_read_models_status', { p_detail: detail })
/** Applies what has settled, within a time budget. Safe to call often: with nothing new it writes nothing. */
export const tickReadModels = (budgetMs = 1000): Promise<{ applied: number }> => rpc<{ applied: number }>('erp_read_models_refresh', { p_budget_ms: budgetMs })
export const rebuildReadModels = (name: string | null): Promise<{ applied: number; status: ModelStatus[] }> => rpc('erp_read_models_rebuild', { p_name: name, p_budget_ms: 4000 })
export const compareReadModels = (months = 12): Promise<Comparison> => rpc<Comparison>('erp_read_models_compare', { p_months: months })
export const fetchDashboard = (): Promise<Dashboard> => rpc<Dashboard>('erp_dashboard', {})

/** "12초 전", "3분 전": how long ago, in the largest unit that is at least one. */
export function agoText(iso: string | null, nowMs: number): string {
  if (!iso) return '-'
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000))
  if (s < 60) return `${s}초 전`
  if (s < 3600) return `${Math.floor(s / 60)}분 전`
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`
  return `${Math.floor(s / 86400)}일 전`
}

/** One line about a group of models: what is read and how long ago that was, or what is still waiting. */
export function freshnessText(models: ModelStatus[], nowMs: number): string {
  const mine = models.filter((m) => m.readable)
  if (!mine.length) return ''
  const behind = mine.reduce((a, m) => a + m.behind, 0)
  if (mine.some((m) => m.failures > 0)) return '반영이 멈췄습니다. 관리자에게 알려 주세요'
  const newest = mine.map((m) => m.last_event_at).filter((x): x is string => !!x).sort().at(-1) ?? null
  if (behind > 0) return `이벤트 ${behind.toLocaleString('ko-KR')}건 반영 대기 중${newest ? ` · ${agoText(newest, nowMs)} 이벤트까지 반영` : ''}`
  return newest ? `${agoText(newest, nowMs)} 이벤트까지 반영` : '반영할 이벤트가 아직 없습니다'
}

/** What changed since the last look, so a screen reloads only when the read side moved. */
export const signatureOf = (models: ModelStatus[]): string => models.map((m) => `${m.name}:${m.applied}:${m.behind}:${m.reset_at ?? ''}`).join('|')

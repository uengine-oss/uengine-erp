// Reads the ledger's series through the public SQL functions. Each call is one bounded stretch of time
// because the API stops a statement after 8 seconds.
import { toDay, toIso } from './calendar.ts'
import type { InvoiceRow, JournalRow, LedgerData, ModuleSpan, PurchaseLine, ReceiptRow, ReorderRule, SalesRow, StockRow, VariantInfo } from './types.ts'

export type RpcFn = <T>(fn: string, args: Record<string, unknown>) => Promise<T>

export interface AnalyticsContext {
  as_of: string
  timezone: string
  modules: Record<string, ModuleSpan>
  variants: VariantInfo[]
  warehouses: { id: string; name: string }[]
  extent: { first_day: string | null; last_day: string | null }
}

const STEP_DAYS = 92

async function inBatches<T>(rpc: RpcFn, fn: string, from: string, to: string, asOf: string | null, onBatch?: () => void): Promise<T[]> {
  const out: T[] = []
  let a = toDay(from)
  const end = toDay(to)
  while (a <= end) {
    const b = Math.min(a + STEP_DAYS, end + 1)
    const rows = await rpc<T[]>(fn, { p_from: toIso(a), p_to: toIso(b), p_as_of: asOf })
    for (const r of rows ?? []) out.push(r)
    onBatch?.()
    a = b
  }
  return out
}

export async function loadLedger(rpc: RpcFn, opt: { asOf?: string | null; onProgress?: (done: number, total: number) => void } = {}): Promise<LedgerData> {
  const asOf = opt.asOf ?? null
  const c = await rpc<AnalyticsContext>('erp_analytics_context', { p_as_of: asOf })
  const first = c.extent.first_day
  const last = c.extent.last_day
  const base: LedgerData = {
    asOf: c.as_of, timezone: c.timezone, modules: c.modules, variants: c.variants, warehouses: c.warehouses,
    sales: [], stock: [], receipts: [], purchases: [], invoices: [], journal: [], rules: [],
  }
  if (!first || !last) return base
  const span = Math.ceil((toDay(last) - toDay(first) + 1) / STEP_DAYS)
  const on = (m: string): boolean => (c.modules[m]?.periods?.length ?? 0) > 0
  const series: [string, (x: unknown[]) => void][] = [['erp_sales_daily', (x) => { base.sales = x as SalesRow[] }]]
  if (on('inventory')) {
    series.push(['erp_stock_daily', (x) => { base.stock = x as StockRow[] }])
    series.push(['erp_receipts_daily', (x) => { base.receipts = x as ReceiptRow[] }])
  }
  if (on('purchase')) series.push(['erp_lead_times', (x) => { base.purchases = x as PurchaseLine[] }])
  if (on('invoicing')) series.push(['erp_payment_delays', (x) => { base.invoices = x as InvoiceRow[] }])
  const total = series.length * span
  let done = 0
  for (const [fn, set] of series) {
    set(await inBatches<unknown>(rpc, fn, first, last, asOf, () => { done++; opt.onProgress?.(done, total) }))
  }
  if (on('inventory')) base.rules = await rpc<ReorderRule[]>('erp_reorder_rules', { p_as_of: asOf })
  // Windows here go by accounting date and every call reads every entry, so batching would only repeat the work.
  if (on('accounting')) base.journal = await rpc<JournalRow[]>('erp_journal_monthly', { p_from: '1900-01-01', p_to: toIso(toDay(last) + 1), p_as_of: asOf })
  return base
}

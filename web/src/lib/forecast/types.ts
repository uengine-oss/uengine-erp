// Shapes shared by the SQL functions in sql/70_analytics.sql and the models. See docs/modules/analytics.md.

export type ModelId =
  | 'stat_sales' | 'quote_conversion' | 'demand_sales' | 'demand_true' | 'stockout_risk'
  | 'whatif_policy' | 'whatif_realloc' | 'whatif_drop' | 'lead_time' | 'whatif_lead'
  | 'reorder_plan' | 'cash_in' | 'whatif_terms' | 'pnl_outlook'
export type ModelKind = 'stat' | 'forecast' | 'whatif'
export type ModelState = 'locked' | 'insufficient' | 'ready'

export interface Band { p10: number; p50: number; p90: number }

export interface Evidence {
  have: number
  need: number
  unit: string
  message: string
  from: string | null
  to: string | null
  cases?: Record<string, number>
}

export interface Verdict {
  /** Which way the number moved. */
  code: 'up' | 'down' | 'indistinguishable'
  text: string
  /** Whether that is welcome: fewer days out of stock is a good thing going down. Unknown when no effect can be told. */
  good?: boolean
}

export interface ModelResult<R> {
  id: ModelId
  kind: ModelKind
  state: ModelState
  input: object
  /** Only when state is ready. */
  result: R | null
  /** What can honestly be said when evidence is short: a range, never a point. */
  range: { low: number; high: number; unit: string; note: string } | null
  verdict: Verdict | null
  evidence: Evidence
  warnings: string[]
}

export interface VariantInfo {
  id: string
  product_id: string | null
  name: string
  category_id: string | null
  type: string | null
  list_price: number | null
  standard_price: number | null
  active: boolean
}

export interface ModuleSpan {
  enabled: boolean
  periods: { from: string; to: string | null }[]
}

/** [day, variant_id, region, warehouse_id, qty, revenue, cost] */
export type SalesRow = [string, string, string | null, string | null, number, number, number]
/** [day, variant_id, warehouse_id, delta] */
export type StockRow = [string, string, string | null, number]
/** [day, variant_id, warehouse_id, qty, origin_type, origin_id] */
export type ReceiptRow = [string, string, string | null, number, string | null, string | null]

export interface PurchaseLine {
  po: string
  line_id: string | null
  vendor_id: string | null
  variant_id: string
  warehouse_id: string | null
  ordered_on: string
  planned_on: string | null
  qty: number
  received: number
  first_received_on: string | null
  last_received_on: string | null
}

export interface InvoiceRow {
  id: string
  partner_id: string
  date: string
  due_date: string
  amount: number
  paid: number
  residual: number
  paid_on: string | null
  state: string | null
}

export interface ReorderRule {
  variant_id: string
  warehouse_id: string | null
  min_qty: number
  max_qty: number
  vendor_id: string | null
}

/** [month 'YYYY-MM', account_id, account_type, name, amount]: income as credit minus debit, expense as debit minus credit. */
export type JournalRow = [string, string, string, string, number]

export interface LedgerData {
  /** Last complete day in the company's time zone. */
  asOf: string
  timezone?: string
  modules: Record<string, ModuleSpan>
  variants: VariantInfo[]
  warehouses: { id: string; name: string }[]
  sales: SalesRow[]
  stock: StockRow[]
  receipts: ReceiptRow[]
  purchases: PurchaseLine[]
  invoices: InvoiceRow[]
  journal: JournalRow[]
  rules: ReorderRule[]
}

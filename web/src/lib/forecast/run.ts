// One entry point for running a model by its id, so the app can do it on a worker thread.
import { depreciationOutlook } from './assets.ts'
import { cashIn, whatIfTerms } from './cash.ts'
import { demandSales, demandTrue } from './forecast.ts'
import { leadTime } from './lead.ts'
import type { Panel } from './panel.ts'
import { pnlOutlook } from './pnl.ts'
import { whatIfPrice } from './price.ts'
import { quarterOutlook } from './quarters.ts'
import type { LedgerData, ModelId, ModelResult } from './types.ts'
import { reorderPlan, stockoutRisk, whatIfDrop, whatIfLead, whatIfPolicy, whatIfRealloc } from './whatif.ts'

// Inputs come from forms and are checked by each model. The app never sets ignoreEvidence, so it is dropped here too.
export function runModel(panel: Panel, id: ModelId, rawInput: Record<string, unknown>): ModelResult<unknown> {
  const { ignoreEvidence: _dropped, ...input } = rawInput as Record<string, any>
  switch (id) {
    case 'demand_sales': return demandSales(panel, input)
    case 'demand_true': return demandTrue(panel, input)
    case 'quarter_outlook': return quarterOutlook(panel, input)
    case 'whatif_price': return whatIfPrice(panel, input as Parameters<typeof whatIfPrice>[1])
    case 'stockout_risk': return stockoutRisk(panel, input)
    case 'lead_time': return leadTime(panel, input)
    case 'reorder_plan': return reorderPlan(panel, input)
    case 'cash_in': return cashIn(panel, input)
    case 'pnl_outlook': return pnlOutlook(panel, input)
    case 'depreciation_outlook': return depreciationOutlook(panel, input)
    case 'whatif_policy': return whatIfPolicy(panel, input as Parameters<typeof whatIfPolicy>[1])
    case 'whatif_realloc': return whatIfRealloc(panel, input as Parameters<typeof whatIfRealloc>[1])
    case 'whatif_drop': return whatIfDrop(panel, input as Parameters<typeof whatIfDrop>[1])
    case 'whatif_lead': return whatIfLead(panel, input)
    case 'whatif_terms': return whatIfTerms(panel, input as Parameters<typeof whatIfTerms>[1])
    default: throw new Error(`이 화면에서 계산하지 않는 모델입니다: ${id}`)
  }
}

export interface LedgerMeta {
  asOf: string
  variants: { id: string; name: string }[]
  warehouses: { id: string; name: string }[]
  vendors: string[]
  partners: string[]
  terms: number[]
  modules: LedgerData['modules']
}

/** What a form needs to offer choices. The rows themselves stay on the worker. */
export function metaOf(data: LedgerData): LedgerMeta {
  const day = (s: string): number => Date.parse(`${s}T00:00:00Z`) / 86400000
  const byName = <T extends { name: string }>(a: T, b: T): number => a.name.localeCompare(b.name, 'ko')
  return {
    asOf: data.asOf,
    variants: data.variants.filter((v) => v.type !== 'service' && v.active !== false).map((v) => ({ id: v.id, name: v.name })).sort(byName),
    warehouses: [...data.warehouses].sort(byName),
    vendors: [...new Set(data.purchases.map((l) => l.vendor_id).filter((x): x is string => !!x))],
    partners: [...new Set(data.invoices.map((x) => x.partner_id).filter(Boolean))],
    terms: [...new Set(data.invoices.map((x) => day(x.due_date) - day(x.date)).filter((t) => Number.isFinite(t) && t >= 0))].sort((a, b) => a - b),
    modules: data.modules,
  }
}

/** Stock by product and warehouse as of the ledger's last day, from the stock changes alone. */
export function stockAt(data: LedgerData): { variant_id: string; warehouse_id: string | null; qty: number }[] {
  const totals = new Map<string, { variant_id: string; warehouse_id: string | null; qty: number }>()
  for (const [, variant, warehouse, delta] of data.stock) {
    const key = `${variant}|${warehouse ?? ''}`
    const row = totals.get(key) ?? { variant_id: variant, warehouse_id: warehouse, qty: 0 }
    row.qty += delta
    totals.set(key, row)
  }
  return [...totals.values()].filter((x) => x.qty !== 0)
}

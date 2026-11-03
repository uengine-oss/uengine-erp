// What a printed document needs besides itself, and the same document as a page that stands alone in a file.
import { createApp, nextTick } from 'vue'
import { db } from '../../lib/conn'
import { rows } from '../../lib/load'
import { refNames, ensureNames } from '../../lib/refs'
import { session } from '../../lib/session'
import type { ErpRecord, State } from '../../lib/types'
import css from '../../styles/doc.css?raw'
import DocSheet, { type DocExtras } from './DocSheet.vue'

const statesOf = async (ids: Iterable<unknown>): Promise<Record<string, State>> => {
  const list = [...new Set(ids)].filter((x): x is string => typeof x === 'string' && !!x)
  if (!list.length) return {}
  const found = await rows<{ id: string; state: State }>(db().from('erp_records').select('id,state').in('id', list))
  return Object.fromEntries(found.map((r) => [r.id, r.state]))
}

export async function docExtras(record: ErpRecord): Promise<DocExtras> {
  const s = record.state
  const lines: State[] = record.type === 'picking' ? s.moves ?? [] : s.lines ?? []
  // Reading the order behind an invoice is not everyone's right. Without it the page just has no delivery address.
  const order = record.type === 'account_move' && s.origin_type === 'sales_order' && s.origin_id ? (await statesOf([s.origin_id]))[s.origin_id] ?? null : null
  const partnerIds = [s.partner_id, s.invoice_partner_id, s.delivery_partner_id, order?.invoice_partner_id, order?.delivery_partner_id]
  const taxIds = lines.flatMap((l) => [...(l.tax_ids ?? []), ...(Array.isArray(l.taxes) ? l.taxes.map((t: State) => t.tax_id) : [])])
  const [partners, taxes, products] = await Promise.all([statesOf(partnerIds), statesOf(taxIds), statesOf(lines.map((l) => l.product_id))])
  const named = [...partnerIds, s.payment_term_id, s.warehouse_id, ...lines.flatMap((l) => [l.uom_id, l.variant_id, l.lot_id])]
  await ensureNames(named)
  const names = Object.fromEntries(named.filter(Boolean).map((id) => [String(id), refNames.get(String(id)) ?? '']))
  return { company: session.company?.state ?? {}, names, partners, taxes, products, order }
}

const escapeText = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string)

/** Vue writes the page into a detached element, so every value is escaped the same way as on screen. */
export async function documentHtml(record: ErpRecord): Promise<string> {
  const extras = await docExtras(record)
  const host = document.createElement('div')
  const app = createApp(DocSheet, { record, extras, showInstallments: true, showSignature: true })
  app.mount(host)
  await nextTick()
  const body = host.outerHTML
  app.unmount()
  return `<!doctype html>\n<html lang="ko"><head><meta charset="utf-8"><title>${escapeText(String(record.state.number ?? record.name ?? '문서'))}</title><style>body{margin:24px;background:#fff}${css}</style></head><body>${body}</body></html>\n`
}

// The made-up company starts assembling a small fan of its own. This story has its own random stream and its own products, and is
// merged in by day, so turning it on or changing it cannot move a sale or the stock of anything already on sale: the what-if figures
// quoted in the tutorials stay what they were. Parts are really bought and paid for, so the books see assets moving and no profit.
import { isoOf, rng, uuid } from './world.ts'
import type { DemoStep } from './generate.ts'

const FINISHED = { key: 'mini-fan', name: '가온 미니 서큘레이터', price: 42000 }
const PARTS = [
  { key: 'mini-motor', name: '미니 모터', cost: 11000, each: 1, buy: 240 },
  { key: 'mini-blade', name: '미니 날개', cost: 900, each: 3, buy: 720 },
  { key: 'mini-shell', name: '미니 하우징', cost: 4200, each: 1, buy: 240 },
]
const MAKER = '오제조'

const id = (name: string) => uuid(`making:${name}`)
const product = (key: string) => id(`product:${key}`)
const line = (order: string, part: string) => id(`line:${order}:${part}`)

/** Steps by business day. `end` is the first day that does not happen. Every one of them says which story it belongs to. */
export function makingSteps(seed: number, onDay: number, end: number, warehouse: string): Map<number, DemoStep[]> {
  const r = rng(seed * 32452843 + 211)
  const out = new Map<number, DemoStep[]>()
  const add = (d: number, ...steps: DemoStep[]) => { if (d < end) out.set(d, [...(out.get(d) ?? []), ...steps.map((s) => ({ ...s, story: 'mrp' }))]) }
  const at = (d: number, t = '17:30') => `${isoOf(d)}T${t}:00+09:00`
  const cmd = (d: number, type: string, recordId: string | null, command: string, payload: unknown, as?: string, t?: string): DemoStep =>
    ({ kind: 'cmd', at: at(d, t), type, id: recordId ?? '', command, payload, ...(as ? { as } : {}) })
  const vendor = id('vendor')

  // Parts come in through a real order, with no tax in the way of the figures the tutorials quote.
  const buy = (d: number, n: number) => {
    const po = id(`po:${n}`)
    const bill = id(`bill:${n}`)
    add(d,
      cmd(d, 'purchase_order', po, 'create', { partner_id: vendor, warehouse_id: warehouse, lines: PARTS.map((p) => ({ product_id: product(p.key), qty: p.buy, price_unit: p.cost, tax_ids: [] })) }, '최구매'),
      cmd(d, 'purchase_order', po, 'confirm', {}, '최구매'),
      { kind: 'settle', at: at(d) },
      { kind: 'validate', at: at(d), origin: po, as: '이재고' },
      { kind: 'settle', at: at(d) },
      cmd(d, 'account_move', bill, 'create', { from_purchase_order: po, invoice_date: isoOf(d) }, '정회계'),
      cmd(d, 'account_move', bill, 'post', {}, '정회계'))
    const payDay = d + 30
    add(payDay, cmd(payDay, 'payment', null, 'create', { from_moves: [bill], date: isoOf(payDay), post: true }, '정회계'))
  }

  add(onDay,
    cmd(onDay, 'module', null, 'enable', { id: 'mrp' }),
    cmd(onDay, 'member', null, 'create', { name: MAKER, email: `maker-${seed}@demo.example`, password: `demo-maker-${seed}-pass`, roles: ['mrp'] }),
    cmd(onDay, 'product_category', id('category:made'), 'create', { name: '자체 조립', cost_method: 'average' }),
    cmd(onDay, 'product_category', id('category:parts'), 'create', { name: '조립 부품', cost_method: 'average' }),
    cmd(onDay, 'partner', vendor, 'create', { name: '한빛부품', company_type: 'company' }),
    ...PARTS.map((p) => cmd(onDay, 'product', product(p.key), 'create', { name: p.name, type: 'goods', standard_price: p.cost, category_id: id('category:parts'), sale_ok: false })),
    cmd(onDay, 'product', product(FINISHED.key), 'create', { name: FINISHED.name, type: 'goods', list_price: FINISHED.price, standard_price: 0, category_id: id('category:made'), sale_ok: false }),
    cmd(onDay, 'bom', id('bom'), 'create', { product_id: product(FINISHED.key), lines: PARTS.map((p) => ({ product_id: product(p.key), qty: p.each })) }, MAKER),
    cmd(onDay, 'reorder_rule', id('rule'), 'create', { product_id: product(FINISHED.key), warehouse_id: warehouse, min_qty: 20, max_qty: 60, trigger: 'manual', replenish_by: 'make' }, '이재고'),
    { kind: 'settle', at: at(onDay) })
  buy(onDay, 0)
  // Thirty days of making uses up about what one purchase brings.
  for (let d = onDay + 30, n = 1; d < end; d += 30, n++) buy(d, n)

  // Twice a week. Work takes a day or a few, and now and then uses a part or two more than the bill says.
  let number = 0
  for (let d = onDay + 1; d < end; d += d % 7 === 0 ? 4 : 3) {
    number++
    const order = id(`mo:${number}`)
    const qty = 15 + Math.floor(r() * 16)
    const rows = PARTS.map((p) => ({ id: line(order, p.key), product_id: product(p.key), qty: qty * p.each }))
    add(d,
      cmd(d, 'manufacturing_order', order, 'create', { product_id: product(FINISHED.key), qty, warehouse_id: warehouse, components: rows }, MAKER),
      cmd(d, 'manufacturing_order', order, 'confirm', {}, MAKER),
      cmd(d, 'manufacturing_order', order, 'start', {}, MAKER),
      { kind: 'settle', at: at(d) })
    const finishes = d + 1 + Math.floor(r() * 3)
    const spoiled = r() < 0.2
    add(finishes, cmd(finishes, 'manufacturing_order', order, 'done', spoiled
      ? { components: [{ id: line(order, 'mini-blade'), qty_done: qty * 3 + 2 }], accept_difference: true }
      : {}, MAKER),
    { kind: 'settle', at: at(finishes) })
  }
  return out
}

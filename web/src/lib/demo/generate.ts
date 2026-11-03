// Turns the made-up company into commands, day by day, with modules turned on as the growth scenario says.
import { crmSteps, expenseSteps } from './backoffice.ts'
import { peopleSteps } from './people.ts'
import { PRODUCTS, REGIONS, dayOf, hex, isoOf, rng, runWorld, uuid } from './world.ts'

export interface DemoStep { kind: 'cmd' | 'validate' | 'settle'; at: string; as?: string; type?: string; id?: string; command?: string; payload?: unknown; origin?: string; reason?: string }
/** `hr` and what follows it are optional: without them the story has no such module and is step for step what it was before there was one. `expense` needs `hr`. */
export interface DemoStages { inventory: string; purchase: string; invoicing: string; accounting: string; hr?: string; expense?: string; crm?: string; end: string }
export const DEFAULT_STAGES: DemoStages = { inventory: '2025-01-01', purchase: '2025-07-01', invoicing: '2026-01-01', accounting: '2026-07-01', hr: '2026-08-01', expense: '2026-08-03', crm: '2025-11-03', end: '2026-11-01' }
export const STARTED_AT = '2023-10-31T09:00:00+09:00'
type Stage = Exclude<keyof DemoStages, 'hr' | 'expense' | 'crm'>

const PEOPLE = [
  { name: '박영업', role: 'sales', from: 0 },
  { name: '이재고', role: 'inventory', stage: 'inventory' },
  { name: '최구매', role: 'purchase', stage: 'purchase' },
  { name: '정회계', role: 'accounting', stage: 'invoicing' },
]
const CUSTOMERS = [
  ['가온마트 본점', 0], ['한가람유통', 0], ['서울가전상사', 0], ['한강홈', 0],
  ['낙동마트', 1], ['부산가전', 1], ['대구생활', 1], ['울산홈', 1],
  ['광주가전', 2], ['전남유통', 2], ['목포생활', 2], ['전주홈', 2],
] as const

export function* generate(seed = 1, stages: DemoStages = DEFAULT_STAGES, start = '2023-11-01'): Generator<DemoStep[]> {
  const first = dayOf(start)
  const end = dayOf(stages.end)
  const world = runWorld(seed, end)
  const r = rng(seed * 104729 + 7)
  const stamp = (d: number, t: string) => `${isoOf(d)}T${t}:00+09:00`
  const dayIn = (name: Stage) => dayOf(stages[name])
  const on = (name: Stage, d: number) => d >= dayIn(name)
  // Worked out apart from everything below, with its own random stream.
  const staff = stages.hr ? peopleSteps(seed, dayOf(stages.hr), end) : new Map<number, DemoStep[]>()
  const office = stages.hr && stages.expense ? expenseSteps(seed, dayOf(stages.expense), end) : new Map<number, DemoStep[]>()
  const deals = stages.crm ? crmSteps(seed, dayOf(stages.crm), end, CUSTOMERS.length) : new Map<number, DemoStep[]>()

  const pid = (p: number) => uuid(`product:${PRODUCTS[p].id}`)
  const wh = (g: number) => uuid(`warehouse:${g}`)
  const customer = (i: number) => uuid(`customer:${i}`)
  const vendor = (p: number) => uuid(`vendor:${p % 2}`)
  const termOf = (days: number) => uuid(`term:${days}`)
  const loc = (g: number) => uuid(`location:${g}`)

  // Each customer pays late in their own way; four move to shorter terms part way through invoicing.
  const payers = CUSTOMERS.map(() => {
    const u = r()
    const term = u < 0.2 ? 15 : u < 0.75 ? 30 : 60
    return { term, habit: Math.max(5, 18 + 0.35 * term + 8 * (r() + r() + r() - 1.5)) }
  })
  const changeDay = dayIn('invoicing') + Math.round((end - dayIn('invoicing')) / 2)
  // Only customers not already on the shortest terms can actually show what a change does.
  const changers = payers.map((x, i) => (x.term > 15 ? i : -1)).filter((i) => i >= 0).slice(0, 5)

  // Company setup comes first, under the clock of the day before opening.
  const setup: DemoStep[] = []
  const at0 = stamp(first - 1, '09')
  const cmd = (at: string, type: string, id: string | null, command: string, payload: unknown, as?: string): DemoStep => ({ kind: 'cmd', at, type, id: id ?? '', command, payload, ...(as ? { as } : {}) })
  for (const m of PEOPLE) if (m.from === 0) setup.push(cmd(at0, 'member', null, 'create', { name: m.name, email: `${hex(m.name)}@demo.example`, password: `demo-${hex(m.name + seed)}-pass`, roles: [m.role] }))
  for (const n of [15, 30, 60]) setup.push(cmd(at0, 'payment_term', termOf(n), 'create', { name: `납품 후 ${n}일`, lines: [{ value: 'percent', amount: 100, days: n }] }))
  for (const c of new Set(PRODUCTS.map((x) => x.category))) setup.push(cmd(at0, 'product_category', uuid(`category:${c}`), 'create', { name: c }))
  CUSTOMERS.forEach(([name, g], i) => setup.push(cmd(at0, 'partner', customer(i), 'create', { name, company_type: 'company', region: REGIONS[g], city: REGIONS[g], payment_term_id: termOf(payers[i].term) })))
  for (const [i, name] of ['바람부품', '에이치에어'].entries()) setup.push(cmd(at0, 'partner', uuid(`vendor:${i}`), 'create', { name, company_type: 'company' }))
  PRODUCTS.forEach((P, p) => setup.push(cmd(at0, 'product', pid(p), 'create', { name: P.name, type: 'goods', list_price: P.price, standard_price: P.cost, category_id: uuid(`category:${P.category}`), sale_ok: true })))
  yield setup

  const opex = (at: string, day: number) => cmd(at, 'journal_entry', null, 'create', { date: isoOf(day), ref: `${isoOf(day).slice(0, 7)} 인건비와 임차료`, lines: [
    { account_id: uuid('account:opex'), debit: 110000000, credit: 0, name: '인건비와 임차료' },
    { account_id: '$seed:보통예금', debit: 0, credit: 110000000, name: '인건비와 임차료' },
  ], post: true }, '정회계')
  const toPay = new Map<number, DemoStep[]>()
  const invoiceOrder = (d: number, orderId: string, c: number) => {
    const id = uuid(`invoice:${orderId}`)
    const steps: DemoStep[] = [
      cmd(stamp(d, '15'), 'account_move', id, 'create', { from_sales_order: orderId }, '정회계'),
      cmd(stamp(d, '15'), 'account_move', id, 'post', {}, '정회계'),
    ]
    const p = payers[c]
    const late = Math.round(p.habit * (0.8 + 0.4 * r()))
    const term = changers.includes(c) && d >= changeDay ? 15 : p.term
    const payDay = d + Math.max(1, Math.round(term * 0.7 + late))
    if (payDay < end) {
      if (!toPay.has(payDay)) toPay.set(payDay, [])
      toPay.get(payDay)!.push(cmd(stamp(payDay, '14'), 'payment', null, 'create', { from_moves: [id], date: isoOf(payDay), post: true }, '정회계'))
    }
    return steps
  }

  for (let d = first; d < end; d++) {
    const steps: DemoStep[] = []
    const w = world.days[d]

    if (d === dayIn('inventory')) {
      const t = stamp(d, '08')
      steps.push(cmd(t, 'module', null, 'enable', { id: 'inventory' }))
      steps.push(cmd(t, 'member', null, 'create', { name: '이재고', email: `${hex('이재고')}@demo.example`, password: `demo-${hex('이재고' + seed)}-pass`, roles: ['inventory'] }))
      REGIONS.forEach((name, g) => {
        steps.push(cmd(t, 'location', loc(g), 'create', { name: `${name} 재고`, usage: 'internal' }))
        steps.push(cmd(t, 'warehouse', wh(g), 'create', { name: `${name} 창고`, code: `W${g + 1}`, stock_location_id: loc(g) }))
      })
      steps.push({ kind: 'settle', at: t })
      const yesterday = world.stock[d - 1]
      PRODUCTS.forEach((_, p) => REGIONS.forEach((__, g) => {
        steps.push(cmd(t, 'stock_adjustment', null, 'create', { product_id: pid(p), location_id: loc(g), counted_qty: yesterday[p][g], apply: true, reason: '기초 재고' }, '이재고'))
        steps.push(cmd(t, 'reorder_rule', null, 'create', { product_id: pid(p), location_id: loc(g), min_qty: world.policy[p][g].rop, max_qty: world.policy[p][g].rop + world.policy[p][g].q, trigger: 'manual' }, '이재고'))
      }))
    }
    if (d === dayIn('purchase')) {
      const t = stamp(d, '08')
      steps.push(cmd(t, 'module', null, 'enable', { id: 'purchase' }))
      steps.push(cmd(t, 'member', null, 'create', { name: '최구매', email: `${hex('최구매')}@demo.example`, password: `demo-${hex('최구매' + seed)}-pass`, roles: ['purchase'] }))
      PRODUCTS.forEach((P, p) => steps.push(cmd(t, 'product', pid(p), 'update', { vendors: [{ partner_id: vendor(p), price: P.cost, delay_days: 10, min_qty: 0 }] })))
    }
    if (d === dayIn('invoicing')) {
      const t = stamp(d, '08')
      steps.push(cmd(t, 'module', null, 'enable', { id: 'invoicing', options: { orders_since: isoOf(d) } }))
      steps.push(cmd(t, 'member', null, 'create', { name: '정회계', email: `${hex('정회계')}@demo.example`, password: `demo-${hex('정회계' + seed)}-pass`, roles: ['accounting', 'sales'] }))
    }
    if (d === dayIn('accounting')) {
      const t = stamp(d, '08')
      const since = dayIn('invoicing')
      steps.push(cmd(t, 'module', null, 'enable', { id: 'accounting', options: { books_since: isoOf(since) } }))
      // The books start with invoicing. What was already on the shelves that day comes in as an opening balance.
      const opening = PRODUCTS.reduce((sum, P, p) => sum + REGIONS.reduce((x, _, g) => x + world.stock[since - 1][p][g] * P.cost, 0), 0)
      steps.push(cmd(t, 'journal_entry', null, 'create', { date: isoOf(since), ref: '기초 잔액', lines: [
        { account_id: '$seed:상품', debit: opening, credit: 0, name: '기초 재고' },
        { account_id: '$seed:자본금', debit: 0, credit: opening, name: '기초 재고' },
      ], post: true }, '정회계'))
      steps.push(cmd(t, 'account', uuid('account:opex'), 'create', { code: '820', name: '판매관리비', account_type: 'expense' }, '정회계'))
      for (let m = since; m < d; m++) if (isoOf(m + 1).endsWith('-01')) steps.push(opex(t, m))
    }
    steps.push(...(staff.get(d) ?? []))
    steps.push(...(office.get(d) ?? []))
    steps.push(...(deals.get(d) ?? []))
    if (d > dayIn('accounting') && isoOf(d + 1).endsWith('-01')) steps.push(opex(stamp(d, '18'), d))
    if (d === changeDay) for (const c of changers) steps.push(cmd(stamp(d, '08'), 'partner', customer(c), 'update', { payment_term_id: termOf(15) }))

    // Goods arrive first thing in the morning.
    for (const a of w.receipts) {
      if (!on('inventory', d)) continue
      const po = uuid(`po:${a.ordered}:${a.p}:${a.g}`)
      if (on('purchase', a.ordered) && a.ordered >= dayIn('inventory')) {
        steps.push({ kind: 'validate', at: stamp(d, '09'), origin: po, as: '이재고' })
      } else {
        const id = uuid(`manual-in:${d}:${a.p}:${a.g}`)
        steps.push(cmd(stamp(d, '09'), 'picking', id, 'create', { picking_type: 'incoming', warehouse_id: wh(a.g), partner_id: vendor(a.p), moves: [{ product_id: pid(a.p), demand: a.qty }] }, '이재고'))
        steps.push(cmd(stamp(d, '09'), 'picking', id, 'validate', {}, '이재고'))
      }
    }
    if (w.receipts.length) steps.push({ kind: 'settle', at: stamp(d, '09') })
    if (on('invoicing', d)) {
      for (const a of w.receipts) {
        if (!on('purchase', a.ordered)) continue
        const po = uuid(`po:${a.ordered}:${a.p}:${a.g}`)
        const bill = uuid(`bill:${po}`)
        steps.push(cmd(stamp(d, '10'), 'account_move', bill, 'create', { from_purchase_order: po, invoice_date: isoOf(d) }, '정회계'))
        steps.push(cmd(stamp(d, '10'), 'account_move', bill, 'post', {}, '정회계'))
        const payDay = d + 30
        if (payDay < end) {
          if (!toPay.has(payDay)) toPay.set(payDay, [])
          toPay.get(payDay)!.push(cmd(stamp(payDay, '14'), 'payment', null, 'create', { from_moves: [bill], date: isoOf(payDay), post: true }, '정회계'))
        }
      }
    }

    // One order per region per day, from a customer in that region.
    for (let g = 0; g < REGIONS.length; g++) {
      const lines = PRODUCTS.map((_, p) => ({ p, qty: w.sold[p][g] })).filter((x) => x.qty > 0)
      if (!lines.length) continue
      const pool = CUSTOMERS.map((c, i) => [c, i] as const).filter(([c]) => c[1] === g)
      const c = pool[Math.floor(r() * pool.length)][1]
      const id = uuid(`order:${d}:${g}`)
      steps.push(cmd(stamp(d, '11'), 'sales_order', id, 'create', {
        partner_id: customer(c),
        ...(on('inventory', d) ? { warehouse_id: wh(g) } : {}),
        lines: lines.map((x) => ({ product_id: pid(x.p), qty: x.qty })),
      }, '박영업'))
      steps.push(cmd(stamp(d, '11'), 'sales_order', id, 'confirm', {}, '박영업'))
      if (on('inventory', d)) {
        steps.push({ kind: 'settle', at: stamp(d, '12') })
        steps.push({ kind: 'validate', at: stamp(d, '13'), origin: id, as: '이재고' })
        steps.push({ kind: 'settle', at: stamp(d, '13') })
      }
      if (on('invoicing', d)) { steps.push(...invoiceOrder(d, id, c)); steps.push({ kind: 'settle', at: stamp(d, '15') }) }
    }
    steps.push(...(toPay.get(d) ?? []))

    // Orders to suppliers go out at the end of the day.
    if (on('purchase', d)) {
      for (const a of w.orders) {
        const po = uuid(`po:${d}:${a.p}:${a.g}`)
        steps.push(cmd(stamp(d, '17'), 'purchase_order', po, 'create', { partner_id: vendor(a.p), warehouse_id: wh(a.g), lines: [{ product_id: pid(a.p), qty: a.qty, price_unit: PRODUCTS[a.p].cost }] }, '최구매'))
        steps.push(cmd(stamp(d, '17'), 'purchase_order', po, 'confirm', {}, '최구매'))
      }
    }
    steps.push({ kind: 'settle', at: stamp(d, '18') })
    yield steps
  }
}

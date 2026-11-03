// Customers who pay late in their own ways. Each invoice's payment day is fixed in advance, so a change of terms can be
// replayed exactly. Slower payers tend to have longer terms, as they do in practice, so comparing customers with
// each other overstates how much terms matter; only a customer whose own term changed can show that.
import { PRODUCTS as P, REGIONS as R, dayOf, isoOf, rng } from './world.mjs'

const normal = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())
const partnerId = (i) => `00000000-0000-4000-8007-${String(i).padStart(12, '0')}`
export { partnerId }

export function makeCashWorld(seed, obs, { start, end, partners = 40, changedPartners = 8, changeBefore = null, varyTerms = true }) {
  const r = rng(seed * 104729 + 7)
  const people = []
  for (let i = 0; i < partners; i++) {
    const u = r()
    const term = !varyTerms ? 30 : u < 0.15 ? 15 : u < 0.75 ? 30 : 60
    const habit = Math.max(5, 18 + 0.35 * term + 8 * normal(r))
    const alpha = Math.min(1, Math.max(0, 0.7 + 0.25 * normal(r)))
    people.push({ i, id: partnerId(i), weight: Math.pow(r(), -1 / 1.5), term, habit, alpha, changeDay: null, newTerm: null })
  }
  const totalWeight = people.reduce((a, x) => a + x.weight, 0)
  const lastChange = changeBefore ?? end
  const order = people.map((x) => x.i).sort((a, b) => people[b].weight - people[a].weight)
  // Mid-sized customers renegotiate; a change needs both sides of it to be visible.
  for (let k = 0; k < Math.min(changedPartners, partners); k++) {
    const x = people[order[(k * 2 + 1) % partners]]
    x.changeDay = start + Math.floor((0.25 + 0.3 * r()) * Math.max(1, lastChange - start))
    x.newTerm = x.term === 30 ? (r() < 0.5 ? 15 : 60) : 30
  }
  const invoices = []
  let inv = 0
  for (let w = start; w + 7 <= end; w += 7) {
    let revenue = 0
    for (let p = 0; p < P.length; p++) for (let g = 0; g < R.length; g++) for (let d = w; d < w + 7; d++) revenue += obs.sold[p][g][d] * P[p].price
    for (const x of people) {
      const amount = Math.round(((revenue * x.weight) / totalWeight) * Math.exp(0.25 * normal(r)))
      const extra = -2 * Math.log(1 - r()) - 2 * Math.log(1 - r())
      const noise = 3 * normal(r)
      const never = r() < 0.015
      if (amount <= 0) continue
      const day = w + 6
      const term = x.changeDay !== null && day >= x.changeDay ? x.newTerm : x.term
      invoices.push({ id: `inv-${inv++}`, partner: x, day, term, amount, extra, noise, never })
    }
  }
  return { people, invoices, start, end }
}

export const paidDay = (inv, term = inv.term) => (inv.never ? null : inv.day + Math.max(0, Math.round(inv.partner.alpha * term + (1 - inv.partner.alpha) * inv.partner.habit + inv.extra + inv.noise)))

export function invoiceRows(cw, cut, { from = cw.start } = {}) {
  const rows = []
  for (const x of cw.invoices) {
    if (x.day >= cut || x.day < from) continue
    const pd = paidDay(x)
    const closed = pd !== null && pd < cut
    rows.push({
      id: x.id, partner_id: x.partner.id, date: isoOf(x.day), due_date: isoOf(x.day + x.term), amount: x.amount,
      paid: closed ? x.amount : 0, residual: closed ? 0 : x.amount, paid_on: closed ? isoOf(pd) : null, state: closed ? 'paid' : 'not_paid',
    })
  }
  return rows
}

// Cash that actually arrives in [from, to), with new terms for invoices issued from `from` on, when asked.
export function trueCash(cw, from, to, change = null) {
  let total = 0
  for (const x of cw.invoices) {
    const scoped = change && x.day >= from && change.scope(x)
    const pd = paidDay(x, scoped ? change.to : x.term)
    if (pd !== null && pd >= from && pd < to) total += x.amount
  }
  return total
}

export const CASH_CUT = dayOf('2026-08-01')
export const CASH_H = 92

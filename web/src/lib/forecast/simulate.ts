// Replays a stretch of days under an order policy. Original and changed policy see the same demand and the same
// lead times, so a difference between them comes from the change, not from a lucky draw.

export interface SubLink { to: number; rate: number }

export interface SimSpace {
  nv: number
  nw: number
  h: number
  price: Float64Array
  cost: Float64Array
  holdPerDay: number
}

export interface SimState {
  stock0: Float64Array
  /** Arrivals known at the start, as cell and day offset from the start. */
  open: { cell: number; qty: number; day: number }[]
}

export interface Policy { rop: Float64Array; q: Float64Array }

export interface SimOutcome {
  revenue: number
  margin: number
  sold: number
  lost: number
  stockoutDays: number
  holding: number
  stockValue: number
  soldByCell: Float64Array
  lostByCell: Float64Array
  firstOutDay: Int32Array
}

export interface SimRun {
  demand: Int32Array
  u: Float64Array
  lead: Int32Array
}

export function simulate(sp: SimSpace, st: SimState, pol: Policy, run: SimRun, subs: SubLink[][], removed: Uint8Array | null = null, leadScale: Float64Array | null = null): SimOutcome {
  const { nv, nw, h, price, cost, holdPerDay } = sp
  const cells = nv * nw
  const stock = new Float64Array(st.stock0)
  const onOrder = new Float64Array(cells)
  const span = h + 400
  const arrive = new Float64Array(cells * span)
  for (const o of st.open) {
    arrive[o.cell * span + Math.min(span - 1, Math.max(0, o.day))] += o.qty
    onOrder[o.cell] += o.qty
  }
  const sold = new Float64Array(cells), lost = new Float64Array(cells)
  const soldByCell = new Float64Array(cells), lostByCell = new Float64Array(cells)
  const firstOutDay = new Int32Array(cells).fill(-1)
  let revenue = 0, grossMargin = 0, unitsSold = 0, unitsLost = 0, stockoutDays = 0, holding = 0, valueDays = 0
  for (let i = 0; i < h; i++) {
    for (let c = 0; c < cells; c++) {
      const a = arrive[c * span + i]
      if (a) { stock[c] += a; onOrder[c] -= a }
      const D = run.demand[c * h + i]
      const v = Math.floor(c / nw)
      const s = removed && removed[v] ? 0 : Math.min(stock[c], D)
      stock[c] -= s; sold[c] = s; lost[c] = D - s
    }
    for (let v = 0; v < nv; v++) {
      const links = subs[v]
      if (!links || !links.length) continue
      for (let w = 0; w < nw; w++) {
        const c = v * nw + w
        for (const l of links) {
          if (lost[c] <= 0) break
          if (removed && removed[l.to]) continue
          const t = l.to * nw + w
          const moved = Math.min(Math.floor(lost[c] * l.rate + run.u[c * h + i]), stock[t], lost[c])
          if (moved <= 0) continue
          stock[t] -= moved; sold[t] += moved; lost[c] -= moved
        }
      }
    }
    for (let c = 0; c < cells; c++) {
      const v = Math.floor(c / nw)
      unitsSold += sold[c]; unitsLost += lost[c]
      revenue += sold[c] * price[v]
      grossMargin += sold[c] * (price[v] - cost[v])
      soldByCell[c] += sold[c]; lostByCell[c] += lost[c]
      if (removed && removed[v]) continue
      if (stock[c] <= 0) {
        stockoutDays++
        if (firstOutDay[c] < 0) firstOutDay[c] = i
      }
      const value = stock[c] * cost[v]
      holding += value * holdPerDay
      valueDays += value
      if (pol.q[c] > 0 && stock[c] + onOrder[c] <= pol.rop[c]) {
        let l = run.lead[c * h + i]
        if (leadScale) l = Math.max(1, Math.round(l * leadScale[c]))
        arrive[c * span + Math.min(span - 1, i + l)] += pol.q[c]
        onOrder[c] += pol.q[c]
      }
    }
  }
  return {
    revenue, margin: grossMargin - holding, sold: unitsSold, lost: unitsLost, stockoutDays, holding,
    stockValue: valueDays / Math.max(1, h), soldByCell, lostByCell, firstOutDay,
  }
}

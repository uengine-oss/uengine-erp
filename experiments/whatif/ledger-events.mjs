// Writes a synthetic company into the real ledger as events in the shape docs/modules/events.md promises, through
// erp.emit. The analytics SQL reads these and nothing else. Module SQL is not needed, so this also runs on a subset build.
import crypto from 'node:crypto'
import { CATEGORY_IDS, LOCATION_IDS, PRODUCTS as P, PRODUCT_IDS, REGIONS as R, VARIANT_IDS, VENDOR_IDS, WAREHOUSE_IDS, dayOf, isoOf, NOMINAL_LEAD } from './world.mjs'
import { paidDay } from './cash-world.mjs'

export const FIXTURE_SQL = `
  -- Real modules may be installed. This checks the contract, so their reactions are taken out of the way in this throwaway database.
  delete from erp.hooks where stream_type in ('sales_order', 'picking', 'purchase_order', 'account_move', 'journal_entry', 'payment');
  delete from erp.subscriptions;
  create table erp.x_rows (kind text, row_ jsonb);
  create function erp.x_apply(ev erp.events, r jsonb) returns void language sql as $f$ insert into erp.x_rows values ('effect', r) $f$;
  select erp.register_effect('quant', 'erp.x_apply');
  select erp.register_effect('gl', 'erp.x_apply');
  select erp.catalog_put(d::jsonb) from unnest(array[
    '{"type":"sales_order","module":"sales","label":"주문","fields":[{"name":"number","label":"번호","type":"text"}],"commands":{}}',
    '{"type":"picking","module":"inventory","label":"전표","fields":[{"name":"number","label":"번호","type":"text"}],"commands":{}}',
    '{"type":"stock_adjustment","module":"inventory","label":"조정","fields":[{"name":"number","label":"번호","type":"text"}],"commands":{}}',
    '{"type":"reorder_rule","module":"inventory","label":"규칙","fields":[{"name":"number","label":"번호","type":"text"}],"commands":{}}',
    '{"type":"purchase_order","module":"purchase","label":"구매","read_roles":["purchase","accounting"],"fields":[{"name":"number","label":"번호","type":"text"}],"commands":{}}',
    '{"type":"account_move","module":"invoicing","label":"청구서","read_roles":["accounting"],"fields":[{"name":"number","label":"번호","type":"text"}],"commands":{}}',
    '{"type":"journal_entry","module":"accounting","label":"전표","read_roles":["accounting"],"fields":[{"name":"number","label":"번호","type":"text"}],"commands":{}}'
  ]) d;
  select erp.module_put(jsonb_build_object('id', id, 'label', label)) from (values ('sales', '판매'), ('inventory', '재고'), ('purchase', '구매'), ('invoicing', '청구'), ('accounting', '회계')) t(id, label);
  create function erp.x_seed(p jsonb) returns int language plpgsql as $f$
  declare e jsonb; n int := 0;
  begin
    perform set_config('erp.source', 'seed', true);
    for e in select * from jsonb_array_elements(p) loop
      perform set_config('erp.clock', e ->> 'at', true);
      perform set_config('erp.correlation_id', coalesce(e ->> 'corr', gen_random_uuid()::text), true);
      if e ? 'enable' then perform erp.h_module(null, 'enable', jsonb_build_object('id', e ->> 'enable'));
      elsif e ? 'disable' then perform erp.h_module(null, 'disable', jsonb_build_object('id', e ->> 'disable'));
      else perform erp.emit(e ->> 't', (e ->> 'id')::uuid, e ->> 'ev', e -> 'data');
      end if;
      n := n + 1;
    end loop;
    perform set_config('erp.clock', '', true);
    return n;
  end $f$;
`

export async function seed(db, events, chunk = 2000) {
  events.sort((a, b) => a.at.localeCompare(b.at))
  for (let i = 0; i < events.length; i += chunk) await db.query('select erp.x_seed($1)', [JSON.stringify(events.slice(i, i + chunk))])
}

export const CUSTOMER_LOCATION = '00000000-0000-4000-8004-999999999991'
export const SUPPLIER_LOCATION = '00000000-0000-4000-8004-999999999992'
export const ACCOUNT_IDS = { rev: '00000000-0000-4000-8008-000000000001', cogs: '00000000-0000-4000-8008-000000000002', opex: '00000000-0000-4000-8008-000000000003', cash: '00000000-0000-4000-8008-000000000004' }

// Master data the analytics reads as it stands now.
export function masterEvents() {
  const at = '2023-10-31T09:00:00+09:00'
  const out = []
  P.forEach((x, i) => out.push({ t: 'product', id: PRODUCT_IDS[i], ev: 'ProductCreated', at, data: { set: { name: x.name, type: 'goods', category_id: i < 2 ? CATEGORY_IDS.summer : i < 4 ? CATEGORY_IDS.winter : CATEGORY_IDS.purifier, list_price: x.price, standard_price: x.cost, active: true, variants: [{ id: VARIANT_IDS[i], name: x.name, active: true }] } } }))
  R.forEach((x, g) => {
    out.push({ t: 'location', id: LOCATION_IDS[g], ev: 'LocationCreated', at, data: { set: { name: `${x.name} 재고`, usage: 'internal' } } })
    out.push({ t: 'warehouse', id: WAREHOUSE_IDS[g], ev: 'WarehouseCreated', at, data: { set: { name: `${x.name} 창고`, code: x.id, stock_location_id: LOCATION_IDS[g] } } })
  })
  out.push({ t: 'location', id: CUSTOMER_LOCATION, ev: 'LocationCreated', at, data: { set: { name: '고객', usage: 'customer' } } })
  out.push({ t: 'location', id: SUPPLIER_LOCATION, ev: 'LocationCreated', at, data: { set: { name: '공급사', usage: 'supplier' } } })
  out.push({ t: 'account', id: ACCOUNT_IDS.rev, ev: 'AccountCreated', at, data: { set: { name: '상품매출', code: '401', account_type: 'income' } } })
  out.push({ t: 'account', id: ACCOUNT_IDS.cogs, ev: 'AccountCreated', at, data: { set: { name: '상품매출원가', code: '451', account_type: 'expense' } } })
  out.push({ t: 'account', id: ACCOUNT_IDS.opex, ev: 'AccountCreated', at, data: { set: { name: '임차료', code: '819', account_type: 'expense' } } })
  out.push({ t: 'account', id: ACCOUNT_IDS.cash, ev: 'AccountCreated', at, data: { set: { name: '보통예금', code: '103', account_type: 'asset_cash' } } })
  return out
}

const salesLine = (p, qty) => ({ line_id: crypto.randomUUID(), product_id: PRODUCT_IDS[p], variant_id: VARIANT_IDS[p], name: P[p].name, qty, unit_price: P[p].price, discount: 0, subtotal: qty * P[p].price, cost: P[p].cost, type: 'goods' })

// Everything one company did, as the modules on at the time would have recorded it.
export function companyEvents(obs, { end, inventory = null, purchase = null, invoicing = null, accounting = null, cash = null, journal = null, promisedLead = NOMINAL_LEAD }) {
  const out = masterEvents()
  const at = (d, hm) => `${isoOf(d)}T${hm}:00+09:00`
  const enable = (m, d) => { if (d !== null && d < end) out.push({ enable: m, at: at(d, '00:01') }) }
  out.push({ enable: 'sales', at: at(0, '00:00') })
  enable('inventory', inventory); enable('purchase', purchase); enable('invoicing', invoicing); enable('accounting', accounting)
  for (let p = 0; p < P.length; p++) for (let g = 0; g < R.length; g++) {
    if (inventory !== null) {
      const qty = inventory === 0 ? obs.stockEnd[p][g][0] + obs.sold[p][g][0] - receivedOn(obs, p, g, 0) : obs.stockEnd[p][g][inventory - 1]
      out.push({ t: 'stock_adjustment', id: crypto.randomUUID(), ev: 'StockAdjusted', at: at(inventory, '00:02'), data: { set: { number: '기초 재고' }, variant_id: VARIANT_IDS[p], product_id: PRODUCT_IDS[p], location_id: LOCATION_IDS[g], warehouse_id: WAREHOUSE_IDS[g], delta: qty, effects: { quant: [{ variant_id: VARIANT_IDS[p], location_id: LOCATION_IDS[g], lot_id: null, qty, reserved: 0 }] } } })
    }
    for (let d = 0; d < end; d++) {
      const q = obs.sold[p][g][d]
      if (!q) continue
      const order = crypto.randomUUID()
      const stockOn = inventory !== null && d >= inventory
      out.push({ t: 'sales_order', id: order, ev: 'SalesOrderConfirmed', at: at(d, '18:00'), data: { set: { number: `S-${d}-${p}-${g}`, state: 'sale' }, number: `S-${d}-${p}-${g}`, partner_id: null, region: R[g].id, warehouse_id: stockOn ? WAREHOUSE_IDS[g] : null, date_order: isoOf(d), currency: 'KRW', amount_total: q * P[p].price, lines: [salesLine(p, q)] } })
      if (stockOn) out.push({ t: 'picking', id: crypto.randomUUID(), ev: 'PickingValidated', at: at(d, '18:30'), data: { set: { number: `OUT-${d}-${p}-${g}`, state: 'done' }, number: `OUT-${d}-${p}-${g}`, picking_type: 'outgoing', origin_type: 'sales_order', origin_id: order, is_return: false, warehouse_id: WAREHOUSE_IDS[g], date_done: at(d, '18:30'), moves: [{ variant_id: VARIANT_IDS[p], product_id: PRODUCT_IDS[p], qty_done: q }], effects: { quant: [{ variant_id: VARIANT_IDS[p], location_id: LOCATION_IDS[g], lot_id: null, qty: -q, reserved: 0 }, { variant_id: VARIANT_IDS[p], location_id: CUSTOMER_LOCATION, lot_id: null, qty: q, reserved: 0 }] } } })
    }
  }
  for (const o of obs.orders) {
    const lineId = crypto.randomUUID()
    const viaPo = purchase !== null && o.d >= purchase && o.d < end
    const po = crypto.randomUUID()
    if (viaPo) out.push({ t: 'purchase_order', id: po, ev: 'PurchaseOrderConfirmed', at: at(o.d, '19:00'), data: { set: { number: `P-${o.d}`, state: 'purchase' }, number: `P-${o.d}`, partner_id: VENDOR_IDS[o.p % 2], warehouse_id: WAREHOUSE_IDS[o.g], date_order: isoOf(o.d), date_planned: isoOf(o.d + promisedLead), lines: [{ line_id: lineId, product_id: PRODUCT_IDS[o.p], variant_id: VARIANT_IDS[o.p], name: P[o.p].name, qty: o.qty, type: 'goods', date_planned: isoOf(o.d + promisedLead) }] } })
    if (inventory !== null && o.received !== null && o.received >= inventory && o.received < end) {
      out.push({ t: 'picking', id: crypto.randomUUID(), ev: 'PickingValidated', at: at(o.received, '09:00'), data: { set: { number: `IN-${o.received}`, state: 'done' }, number: `IN-${o.received}`, picking_type: 'incoming', origin_type: viaPo ? 'purchase_order' : null, origin_id: viaPo ? po : null, is_return: false, warehouse_id: WAREHOUSE_IDS[o.g], date_done: at(o.received, '09:00'), moves: [{ origin_line_id: viaPo ? lineId : null, variant_id: VARIANT_IDS[o.p], product_id: PRODUCT_IDS[o.p], qty_done: o.qty }], effects: { quant: [{ variant_id: VARIANT_IDS[o.p], location_id: LOCATION_IDS[o.g], lot_id: null, qty: o.qty, reserved: 0 }, { variant_id: VARIANT_IDS[o.p], location_id: SUPPLIER_LOCATION, lot_id: null, qty: -o.qty, reserved: 0 }] } } })
    }
  }
  if (cash) for (const x of cash.invoices) {
    if (x.day >= end) continue
    const move = crypto.randomUUID()
    out.push({ t: 'account_move', id: move, ev: 'InvoicePosted', at: at(x.day, '12:00'), data: { set: { number: x.id, state: 'posted' }, move_type: 'out_invoice', number: x.id, partner_id: x.partner.id, date: isoOf(x.day), due_date: isoOf(x.day + x.term), amount_total: x.amount, lines: [] } })
    const pd = paidDay(x)
    if (pd !== null && pd < end) out.push({ t: 'account_move', id: move, ev: 'InvoicePaymentApplied', at: at(pd, '15:00'), data: { payment_id: null, amount: x.amount, residual: 0, payment_state: 'paid', partner_id: x.partner.id, due_date: isoOf(x.day + x.term), date: isoOf(pd) } })
  }
  if (journal) for (const j of journal) {
    out.push({ t: 'journal_entry', id: crypto.randomUUID(), ev: 'JournalEntryPosted', at: `${j.month}-28T20:00:00+09:00`, data: { set: { number: `J-${j.month}`, state: 'auto' }, number: `J-${j.month}`, date: `${j.month}-28`, lines: [], effects: { gl: [
      { account_id: ACCOUNT_IDS.rev, debit: 0, credit: j.rev, date: `${j.month}-28`, name: '매출' },
      { account_id: ACCOUNT_IDS.cogs, debit: j.cogs, credit: 0, date: `${j.month}-28`, name: '원가' },
      { account_id: ACCOUNT_IDS.opex, debit: j.opex, credit: 0, date: `${j.month}-28`, name: '비용' },
      { account_id: ACCOUNT_IDS.cash, debit: j.rev - j.cogs - j.opex, credit: 0, date: `${j.month}-28`, name: '현금' },
    ] } } })
  }
  return out
}

function receivedOn(obs, p, g, d) {
  return obs.orders.filter((o) => o.p === p && o.g === g && o.received === d).reduce((a, o) => a + o.qty, 0)
}

// A few vouchers for showing the tax screens, on a company that already exists. The demo company's story and figures do
// not change unless someone runs this: it stays out of the generator on purpose, and it moves no stock.
// Usage: source scripts/local-env.sh && EMAIL=owner@example.com PASSWORD=... node scripts/seed-krtax.mjs [year] [term]
import { pathToFileURL } from 'node:url'

// What these make, worked out by hand for a preliminary return:
// (1) 3,000,000/300,000  (10) 1,050,000/105,000  (44) 70,000/7,000  (53) 50,000/5,000  (18) tax 107,000  ㉰ 193,000
export const SEED_VOUCHERS = [
  { key: 'K-S-1', move_type: 'out_invoice', evidence_type: 'tax_invoice', party: 'buyer', amount: 3000000, month: 1, day: 10 },
  { key: 'K-P-1', move_type: 'in_invoice', evidence_type: 'tax_invoice', party: 'vendor', amount: 1000000, month: 1, day: 15 },
  { key: 'K-P-2', move_type: 'in_invoice', evidence_type: 'tax_invoice', party: 'vendor', amount: 50000, month: 2, day: 3, deductible: false, non_deduct_reason: 'entertainment' },
  { key: 'K-P-3', move_type: 'in_invoice', evidence_type: 'credit_card', party: 'station', amount: 70000, month: 2, day: 20, payment_way: 'card', card_kind: 'business' },
]

// `run(type, id, command, payload)` is whatever sends a command. Running it twice adds nothing: the approval numbers are taken.
export async function seedKrtax(run, { year, term = 1, expenseAccountId } = {}) {
  const parties = {}
  for (const [k, name, tax_id] of [['buyer', '시연 거래처', '555-11-22222'], ['vendor', '시연 공급사', '555-33-44444'], ['station', '시연 주유소', '555-55-66666']]) {
    parties[k] = (await run('partner', null, 'create', { name: `${name} ${year}-${term}`, tax_id })).id
  }
  const first = term === 1 ? 0 : 6
  const made = []
  for (const v of SEED_VOUCHERS) {
    const date = `${year}-${String(first + v.month).padStart(2, '0')}-${String(v.day).padStart(2, '0')}`
    const buying = v.move_type === 'in_invoice'
    const payload = {
      voucher: true, move_type: v.move_type, partner_id: parties[v.party], invoice_date: date, evidence_type: v.evidence_type, payment_way: v.payment_way ?? 'credit',
      ...(v.evidence_type === 'tax_invoice' ? { approval_no: `${v.key}-${year}-${term}` } : { allow_duplicate: true }),
      ...(v.deductible === false ? { deductible: false, non_deduct_reason: v.non_deduct_reason } : {}), ...(v.card_kind ? { card_kind: v.card_kind } : {}),
      lines: [{ name: '시연 품목', qty: 1, price_unit: v.amount, ...(buying && expenseAccountId ? { account_id: expenseAccountId } : {}) }],
    }
    try {
      made.push((await run('account_move', null, 'create', payload)).id)
    } catch (e) {
      if (!String(e.message).includes('ERP_DUPLICATE_VOUCHER')) throw e
    }
  }
  return made
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { API_URL, ANON_KEY, EMAIL, PASSWORD } = process.env
  if (!API_URL || !ANON_KEY || !EMAIL || !PASSWORD) throw new Error('source scripts/local-env.sh and set EMAIL and PASSWORD')
  const now = new Date()
  const year = Number(process.argv[2] ?? now.getFullYear())
  const term = Number(process.argv[3] ?? (now.getMonth() < 6 ? 1 : 2))
  const login = await fetch(`${API_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) })
  const { access_token: token } = await login.json()
  const run = async (type, id, command, payload) => {
    const r = await fetch(`${API_URL}/rest/v1/rpc/erp_command`, { method: 'POST', headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_type: type, p_id: id, p_command: command, p_payload: payload, p_source: 'seed' }) })
    const body = await r.json()
    if (r.status !== 200) throw new Error(body.message)
    return body
  }
  await run('module', null, 'enable', { id: 'invoicing' })
  await run('module', null, 'enable', { id: 'krtax' })
  console.log(`vouchers made: ${(await seedKrtax(run, { year, term })).length}`)
}

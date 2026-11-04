// Who reads a claim. Everyone who has a reason, and an agent key of each, is put against every way out of the database, and the raw answer is
// searched for what they must not see. The words must be nowhere in the ledger at all, and the amount only under the claim's own scope.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { company, rejects } from './lib/harness.mjs'

const TODAY = '2026-06-15'
const LATER = '2026-06-16T00:00:00+09:00'
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const SECRET = {
  title: '치과치료비-비밀적요XQ1', titleOld: '병원비-이전적요XQ2', note: '잇몸수술-비밀메모XQ3', refused: '금액불일치-비밀반려XQ4', noReceipt: '영수증분실-비밀사유XQ5',
  draftTitle: '개인선물-비밀적요XQ6', sagaTitle: '에이전트-비밀적요XQ7', file: '개인카드-비밀파일XQ8.png', sagaReason: '에이전트-비밀사유XQ9',
}
const AMOUNT = { paid: 7351900, draft: 6241800, saga: 5130700 }

let co
// One PostgREST request: its own transaction, role, claims and headers.
async function req(uid, sql, params = [], headers = {}, role = 'authenticated') {
  const c = co.k.db.client
  await c.query('begin')
  try {
    await c.query(`set local role ${role}`)
    await c.query(`select set_config('request.jwt.claims', $1, true), set_config('request.headers', $2, true), set_config('response.status', '', true)`,
      [uid ? JSON.stringify({ sub: uid, role }) : '', JSON.stringify(headers)])
    const res = await c.query(sql, params)
    await c.query('commit')
    return res.rows
  } catch (e) { await c.query('rollback'); throw e }
}
const raw = async (fn) => { try { return JSON.stringify(await fn()) } catch (e) { return `ERR ${e.message}` } }
const rpc = (uid, fn, ...args) => req(uid, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args)
const asRow = async (p) => (await p)[0].r

let nextId = 1
const mcp = async (key, method, params) => (await req(null, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params })], { 'x-erp-key': key }, 'anon'))[0].r
const tool = async (key, name, args) => (await mcp(key, 'tools/call', { name, arguments: args })).result
const json = (r) => { assert.ok(!r.isError, r.content?.[0]?.text); return JSON.parse(r.content[0].text) }

before(async () => {
  const k = await company({ modules: ['hr', 'expense', 'accounting'], clock: `${TODAY}T09:00:00+09:00` })
  co = { k }
  await k.db.query(`select set_config('erp.clock', $1, false)`, [`${TODAY}T10:00:00+09:00`])
  const member = async (name, roles) => {
    const m = await k.addMember(name, roles)
    const key = (await k.db.asUser(k.adminId, 'select public.erp_api_key_create($1, $2) r', [m.record, name])).rows[0].r.key
    return { ...m, name, key }
  }
  const staff = await member('박영업', ['sales'])
  const boss = await member('김팀장', ['viewer'])
  const filer = await member('대행인사', ['hr'])
  const books = await member('정회계', ['accounting'])
  const idleHr = await member('한가인사', ['hr'])
  const peer = await member('오동료', ['sales'])
  const dept = (await filer.cmd('department', null, 'create', { name: '영업' })).id
  const hire = (name, more) => filer.cmd('employee', null, 'create', { name, hire_date: '2025-01-01', department_id: dept, ...more })
  const bossE = await hire('김팀장', { member_id: boss.record })
  const staffE = await hire('박영업', { member_id: staff.record, manager_id: bossE.id })
  await hire('오동료', { member_id: peer.record, manager_id: bossE.id })

  // Filed on someone's behalf, with a receipt, refused once, filed again, approved and paid.
  const cat = (await k.db.query(`select erp.seed_id('expense_category:교통비') id`)).rows[0].id
  const paid = await filer.cmd('expense', null, 'create', { employee_id: staffE.id, title: SECRET.titleOld, note: SECRET.note, amount: AMOUNT.paid, date: '2026-06-01', category_id: cat })
  await filer.cmd('expense', paid.id, 'update', { title: SECRET.title })
  const rid = crypto.randomUUID()
  await filer.cmd('expense', paid.id, 'attach_receipt', { id: rid, sha256: sha('개인카드'), mime: 'image/png', size: 2048, file_name: SECRET.file })
  await filer.cmd('expense', paid.id, 'submit', {})
  await boss.cmd('expense', paid.id, 'refuse', {}, { reason: SECRET.refused })
  await filer.cmd('expense', paid.id, 'submit', {})
  await boss.cmd('expense', paid.id, 'approve', {})
  await books.cmd('expense', paid.id, 'pay', {})
  await k.settle()

  // The claimant's own, not filed yet, so nobody has asked the manager anything.
  const draft = await staff.cmd('expense', null, 'create', { title: SECRET.draftTitle, amount: AMOUNT.draft, no_receipt_reason: SECRET.noReceipt })

  // The claimant's agent, as one piece of work.
  const saga = crypto.randomUUID()
  const viaAgent = json(await tool(staff.key, 'erp_create', { type: 'expense', saga_id: saga, values: { title: SECRET.sagaTitle, amount: AMOUNT.saga, no_receipt_reason: SECRET.noReceipt } }))
  json(await tool(staff.key, 'erp_update', { type: 'expense', id: viaAgent.id, saga_id: saga, values: { state: 'submitted' } }))

  const number = async (id) => (await k.rec(id)).state.number
  Object.assign(co, {
    staff, boss, filer, books, idleHr, peer, staffE, cat, saga, rid,
    claims: {
      paid: { id: paid.id, number: await number(paid.id), amount: AMOUNT.paid, corr: paid.correlation_id },
      draft: { id: draft.id, number: await number(draft.id), amount: AMOUNT.draft, corr: draft.correlation_id },
      saga: { id: viaAgent.id, number: await number(viaAgent.id), amount: AMOUNT.saga, corr: saga },
    },
    // Who has a reason to read which claim, by the rule and nothing else.
    may: new Map([[staff, ['paid', 'draft', 'saga']], [boss, ['paid', 'saga']], [filer, ['paid']], [books, ['paid', 'draft', 'saga']], [idleHr, []], [peer, []]]),
  })
})
after(async () => { await co.k.close() })

const CLAIMS = ['paid', 'draft', 'saga']
const wordsIn = (s) => Object.values(SECRET).filter((w) => s.includes(w))
function allowedOnly(who, path, text, { amounts = false, numbers = true } = {}) {
  assert.deepEqual(wordsIn(text), [], `${who.name} / ${path}: words came out`)
  for (const c of CLAIMS) {
    const claim = co.claims[c]
    const yes = co.may.get(who).includes(c)
    if (!yes) {
      assert.ok(!text.includes(String(claim.amount)), `${who.name} / ${path}: the amount of ${c} came out`)
      assert.ok(!text.includes(claim.number), `${who.name} / ${path}: the number of ${c} came out`)
      assert.ok(!text.includes(claim.id), `${who.name} / ${path}: the id of ${c} came out`)
    } else {
      if (amounts) assert.ok(text.includes(String(claim.amount)), `${who.name} / ${path}: should show the amount of ${c}: ${text.slice(0, 200)}`)
      if (numbers) assert.ok(text.includes(claim.number) || text.includes(claim.id), `${who.name} / ${path}: should show ${c}: ${text.slice(0, 200)}`)
    }
  }
}
const people = () => [...co.may.keys()]

test('the words are in no event, no record and no reply, and the amount is in the ledger on purpose', async () => {
  const { k } = co
  const scan = async (sql) => JSON.stringify((await k.db.query(sql)).rows)
  for (const [what, sql] of [['events', 'select * from erp.events'], ['records', 'select * from erp.records'], ['journal lines', 'select * from erp.gl_lines'], ['undone sagas', 'select * from erp.saga_undone'],
    ['retried replies', 'select * from erp.idempotency'], ['subscriptions', 'select * from erp.subscriptions']]) {
    assert.deepEqual(wordsIn(await scan(sql)), [], `${what} hold words`)
  }
  const ledger = await scan('select * from erp.events')
  assert.ok(ledger.includes(String(AMOUNT.paid)), 'accounting replays from this, so it has to be there (M1, M8)')
  assert.ok(ledger.includes(sha('개인카드')), 'and the fingerprint that proves the file')
  assert.deepEqual((await k.db.query(`select reason from erp.events where stream_type = 'expense' and reason is not null`)).rows, [], 'a command\'s reason is typed text too')
  for (const c of CLAIMS) {
    const s = (await k.rec(co.claims[c].id)).state
    for (const f of ['title', 'note', 'no_receipt_reason', 'refused_reason']) assert.equal(s[f], undefined, f)
  }
  assert.equal((await k.rec(co.claims.paid.id)).name, co.claims.paid.number, 'its name is its number')
  const changed = (await k.events(co.claims.paid.id)).find((e) => e.event_type === 'ExpenseChanged')
  assert.deepEqual(changed.data.words_changed, ['title'], 'that something was changed, by field name')
})

test('the matrix, by login: every generic read path shows each person what they may see and nothing else', async () => {
  const { paid, draft, saga } = co.claims
  const ids = [paid.id, draft.id, saga.id]
  for (const who of people()) {
    const u = who.id
    const paths = [
      ['erp_records list', () => req(u, `select * from public.erp_records where type = 'expense'`), { amounts: true }],
      ['erp_records by id', () => req(u, 'select * from public.erp_records where id = any ($1)', [ids]), { amounts: true }],
      ['erp_records search by name', () => req(u, `select * from public.erp_records where name like 'EX%'`), {}],
      ['erp_records search by content', () => req(u, `select * from public.erp_records where state::text like $1`, [`%${AMOUNT.paid}%`]), { numbers: false }],
      ['erp_events all', () => req(u, 'select * from public.erp_events'), { amounts: true }],
      ['erp_events by stream', () => req(u, 'select * from public.erp_events where stream_id = any ($1)', [ids]), { amounts: true }],
      ['erp_api_expense', () => req(u, 'select * from public.erp_api_expense'), { amounts: true }],
      ['erp.records directly', () => req(u, `select * from erp.records where type = 'expense'`), { amounts: true }],
      // What the realtime server asks about each change before sending it to a subscriber.
      ['erp.events as realtime asks', () => req(u, 'select * from erp.events where stream_id = any ($1)', [ids]), { amounts: true }],
      ['erp_event_feed', async () => (await rpc(u, 'erp_event_feed', '0', 0, null, 1000)), { numbers: false }],
      ['erp_records_at', async () => asRow(rpc(u, 'erp_records_at', 'expense', LATER, 100, 0, null)), { amounts: true }],
      ['erp_references of the employee', async () => asRow(rpc(u, 'erp_references', co.staffE.id, 50)), { numbers: false }],
    ]
    for (const [path, fn, want] of paths) allowedOnly(who, path, await raw(fn), want)

    for (const c of CLAIMS) {
      const claim = co.claims[c]
      const yes = co.may.get(who).includes(c)
      for (const [path, fn] of [
        ['erp_stream', () => asRow(rpc(u, 'erp_stream', claim.id))],
        ['erp_as_of', () => asRow(rpc(u, 'erp_as_of', claim.id, LATER))],
        ['erp_at_version', () => asRow(rpc(u, 'erp_at_version', claim.id, 1))],
      ]) {
        const text = await raw(fn)
        assert.deepEqual(wordsIn(text), [], `${who.name} / ${path}`)
        if (yes) assert.ok(text.includes(String(claim.amount)), `${who.name} / ${path} / ${c}: ${text.slice(0, 160)}`)
        else assert.match(text, /ERP_FORBIDDEN/, `${who.name} / ${path} / ${c}`)
      }
      const correlation = await raw(() => asRow(rpc(u, 'erp_correlation', claim.corr)))
      assert.deepEqual(wordsIn(correlation), [])
      if (yes) assert.ok(correlation.includes(claim.id), `${who.name} / erp_correlation / ${c}`)
      else assert.equal(correlation, '[]', `${who.name} / erp_correlation / ${c}`)

      const status = await raw(() => asRow(rpc(u, 'erp_saga_status', claim.corr)))
      assert.deepEqual(wordsIn(status), [])
      if (yes) assert.ok(status.includes(claim.number), `${who.name} / erp_saga_status / ${c}`)
      else assert.ok(!status.includes(claim.number) && !status.includes(claim.id), `${who.name} / erp_saga_status / ${c}: ${status}`)

      for (const [path, fn] of [
        ['erp_saga_plan', () => asRow(rpc(u, 'erp_saga_plan', claim.corr))],
        ['erp_rollback_preview', () => asRow(rpc(u, 'erp_rollback_preview', 'correlation', JSON.stringify({ correlation_id: claim.corr })))],
      ]) {
        const text = await raw(fn)
        assert.deepEqual(wordsIn(text), [], `${who.name} / ${path}`)
        // Nobody here is an admin, so only someone's own agent work can be planned: the claimant's, whose agent did it.
        if (who === co.staff && c === 'saga') assert.ok(text.includes(claim.number), `${who.name} / ${path}: ${text.slice(0, 160)}`)
        else assert.match(text, /ERP_FORBIDDEN/, `${who.name} / ${path} / ${c}`)
      }
    }
  }
})

test('the matrix, by agent key: the same people, every way an agent can ask', async () => {
  for (const who of people()) {
    const key = who.key
    const asked = [
      ['list', { type: 'expense' }, {}],
      ['list by filter', { type: 'expense', filter: { employee_id: co.staffE.id } }, {}],
      ['list by search', { type: 'expense', search: 'EX' }, {}],
      ['list as of', { type: 'expense', as_of: LATER }, { amounts: true }],
    ]
    for (const [path, args, want] of asked) {
      const r = await tool(key, 'erp_read', args)
      allowedOnly(who, `erp_read ${path}`, r.content[0].text, want)
    }
    const res = await mcp(key, 'resources/read', { uri: 'erp://expense' })
    allowedOnly(who, 'erp://expense', JSON.stringify(res.result ?? res.error), {})
    allowedOnly(who, 'resources/list', JSON.stringify((await mcp(key, 'resources/list')).result), { numbers: false })
    allowedOnly(who, 'erp_read types', (await tool(key, 'erp_read', {})).content[0].text, { numbers: false })

    for (const c of CLAIMS) {
      const claim = co.claims[c]
      const yes = co.may.get(who).includes(c)
      for (const [path, args, wantAmount] of [
        ['one', { type: 'expense', id: claim.id }, true],
        ['history', { id: claim.id, history: true }, false],
        ['one as of', { type: 'expense', id: claim.id, as_of: LATER }, true],
      ]) {
        const r = await tool(key, 'erp_read', args)
        const text = r.content[0].text
        assert.deepEqual(wordsIn(text), [], `${who.name} / agent ${path}`)
        if (yes) { assert.ok(!r.isError, text); if (wantAmount) assert.ok(text.includes(String(claim.amount)), `${who.name} / agent ${path} / ${c}`) }
        else { assert.ok(r.isError, `${who.name} / agent ${path} / ${c}: ${text.slice(0, 120)}`); assert.match(text, /ERP_FORBIDDEN/); assert.ok(!text.includes(String(claim.amount))) }
      }
      for (const uri of [`erp://expense/${claim.id}`, `erp://expense/${claim.id}/history`]) {
        const r = await mcp(key, 'resources/read', { uri })
        const text = JSON.stringify(r.result ?? r.error)
        assert.deepEqual(wordsIn(text), [], `${who.name} / ${uri}`)
        if (yes) assert.ok(r.result, `${who.name} / ${uri}: ${text.slice(0, 120)}`)
        else { assert.ok(r.error, `${who.name} / ${uri}: ${text.slice(0, 120)}`); assert.ok(!text.includes(String(claim.amount))) }
      }
      const status = (await tool(key, 'erp_read', { saga: claim.corr })).content[0].text
      assert.deepEqual(wordsIn(status), [])
      if (yes) assert.ok(status.includes(claim.number), `${who.name} / agent saga / ${c}`)
      else assert.ok(!status.includes(claim.number) && !status.includes(String(claim.amount)), `${who.name} / agent saga / ${c}: ${status}`)

      const plan = await tool(key, 'erp_read', { rollback: { correlation_id: claim.corr } })
      const planText = plan.content[0].text
      assert.deepEqual(wordsIn(planText), [])
      if (who === co.staff && c === 'saga') assert.equal(JSON.parse(planText).mode, 'compensate', 'its own work: it may plan the undo')
      else { assert.ok(plan.isError, `${who.name} / agent plan / ${c}: ${planText.slice(0, 120)}`); assert.ok(!planText.includes(claim.number)) }
    }
  }
})

test('out of scope and no such claim get the same answer, whichever door, so nothing can be learned by asking', async () => {
  const { paid } = co.claims
  const ghost = crypto.randomUUID()
  const strip = (m) => m.replace(ghost, 'X').replace(paid.id, 'X')
  for (const who of [co.peer, co.idleHr]) {
    const u = who.id
    const same = async (label, ask) => {
      const [a, b] = [strip(await raw(() => ask(paid.id))), strip(await raw(() => ask(ghost)))]
      assert.equal(a, b, `${who.name} / ${label}`)
      assert.deepEqual(wordsIn(a), [])
      return a
    }
    await same('erp_stream', (id) => asRow(rpc(u, 'erp_stream', id)))
    await same('erp_as_of', (id) => asRow(rpc(u, 'erp_as_of', id, LATER)))
    await same('erp_expense_words', (id) => asRow(rpc(u, 'erp_expense_words', id)))
    assert.match(await same('update', (id) => who.cmd('expense', id, 'update', { amount: 1 })), /ERP_NOT_FOUND/)
    assert.match(await same('update on a version', (id) => who.cmd('expense', id, 'update', { amount: 1 }, { expected: 3 })), /ERP_NOT_FOUND/, 'a version would have told')
    await same('approve', (id) => who.cmd('expense', id, 'approve', {}))
    await same('refuse', (id) => who.cmd('expense', id, 'refuse', {}, { reason: 'x' }))
    await same('cancel', (id) => who.cmd('expense', id, 'cancel', {}, { reason: 'x' }))
    await same('erase', (id) => who.cmd('expense', id, 'erase_private', {}))
    await same('erp_update names its state', (id) => asRow(rpc(u, 'erp_update', 'expense', id, JSON.stringify({ state: 'paid' }))))
    const viaTool = async (id) => { const t = (await tool(who.key, 'erp_update', { type: 'expense', id, values: { state: 'paid' } })).content[0].text; return t }
    await same('agent update', viaTool)
    await same('agent read', async (id) => (await tool(who.key, 'erp_read', { type: 'expense', id })).content[0].text)
  }
})

test('import: naming a key does not turn a claim someone may not read into an answer', async () => {
  const { peer, books } = co
  const { paid } = co.claims
  const probe = async (who, row, options) => {
    const r = await asRow(rpc(who.id, 'erp_import', 'expense', JSON.stringify([row]), 'dry_run', JSON.stringify(options)))
    return r.rows[0]
  }
  const row = (number) => ({ number, title: '가져오기 시험', amount: 123, no_receipt_reason: '시험' })
  for (const options of [{ key: ['number'] }, { key: ['number'], existing: 'skip' }]) {
    const [hit, miss] = [await probe(peer, row(paid.number), options), await probe(peer, row('EX99999'), options)]
    const same = (r) => ({ status: r.status, code: r.code, message: r.message })
    assert.deepEqual(same(hit), same(miss), 'a right guess looks like a wrong one')
    assert.notEqual(hit.id, paid.id)
  }
  const asked = await probe(peer, { employee_name: '박영업', title: '가져오기 시험', amount: 123 }, { key: ['employee_name'], existing: 'skip' })
  assert.notEqual(asked.status, 'skipped', 'nor by the person\'s name')
  assert.equal((await probe(books, row(paid.number), { key: ['number'], existing: 'skip' })).id, paid.id, 'accounting may read it, so it matches')
})

test('the words themselves: read one claim at a time by the people concerned, never directly, and never by an agent', async () => {
  const { paid, draft } = co.claims
  for (const who of people()) {
    const [p, d] = [await raw(() => asRow(rpc(who.id, 'erp_expense_words', paid.id))), await raw(() => asRow(rpc(who.id, 'erp_expense_words', draft.id)))]
    const seesPaid = co.may.get(who).includes('paid')
    assert.equal(p.includes(SECRET.title), seesPaid, `${who.name} / paid`)
    assert.equal(p.includes(SECRET.note), seesPaid)
    assert.equal(p.includes(SECRET.refused), seesPaid)
    assert.ok(!p.includes(SECRET.titleOld), 'the old words are gone, not kept somewhere')
    assert.equal(d.includes(SECRET.draftTitle), co.may.get(who).includes('draft'), `${who.name} / draft`)
    if (!seesPaid) assert.match(p, /ERP_FORBIDDEN/)
    await rejects(req(who.id, 'select * from erp.expense_private'), 'permission denied')
    await rejects(req(who.id, `update erp.expense_private set title = 'x'`), 'permission denied')
  }
  await rejects(req(co.books.id, 'select * from public.erp_expense_private'), 'does not exist')
  await rejects(req(null, 'select public.erp_expense_words($1)', [paid.id], {}, 'anon'), 'permission denied')
})

test('receipts: the table and storage follow the same decision', async () => {
  const { paid, draft } = co.claims
  const path = `expense/${paid.id}/${co.rid}`
  for (const who of people()) {
    const rows = await req(who.id, 'select * from public.erp_expense_receipts where expense_id = $1', [paid.id])
    const yes = co.may.get(who).includes('paid')
    assert.equal(rows.length, yes ? 1 : 0, who.name)
    assert.equal(JSON.stringify(await req(who.id, 'select file_name from public.erp_expense_receipts')).includes(SECRET.file), yes, who.name)
    assert.equal((await rpc(who.id, 'erp_receipt_may', path, 'read'))[0].r, yes, `${who.name} read`)
    assert.equal((await rpc(who.id, 'erp_receipt_may', path, 'write'))[0].r, who === co.books, `${who.name} write on a paid claim`)
    const onDraft = (await rpc(who.id, 'erp_receipt_may', `expense/${draft.id}/${crypto.randomUUID()}`, 'write'))[0].r
    assert.equal(onDraft, who === co.staff || who === co.books, `${who.name} write on a draft`)
  }
  const ghost = `expense/${crypto.randomUUID()}/${crypto.randomUUID()}`
  assert.strictEqual((await rpc(co.peer.id, 'erp_receipt_may', ghost, 'read'))[0].r, false)
  assert.strictEqual((await rpc(co.books.id, 'erp_receipt_may', ghost, 'write'))[0].r, false)
})

test('journal entries say the number and the kind, and only accounting reads them', async () => {
  const { k } = co
  const { paid } = co.claims
  const lines = (await k.db.query(`select distinct name from erp.gl_lines`)).rows.map((r) => r.name)
  assert.deepEqual(lines, [`${paid.number} 교통비`])
  const entries = JSON.stringify((await k.db.query(`select state from erp.records where type = 'journal_entry'`)).rows)
  assert.ok(entries.includes(paid.number))
  for (const name of ['박영업', '김팀장', '대행인사']) assert.ok(!entries.includes(name), `the entry names ${name}`)
  for (const who of people()) {
    const yes = who === co.books
    assert.equal((await req(who.id, `select * from public.erp_records where type = 'journal_entry'`)).length > 0, yes, who.name)
    assert.equal((await req(who.id, `select * from public.erp_events where stream_type = 'journal_entry'`)).length > 0, yes, who.name)
    assert.equal((await req(who.id, 'select * from public.erp_gl_lines')).length > 0, yes, who.name)
  }
})

test('the trend and its model: accounting sees the company, anyone else their own share, and is told which', async () => {
  const trend = (u) => asRow(rpc(u, 'erp_expense_trend', '2026-01-01', '2026-12-31', null))
  const stat = async (u) => (await asRow(rpc(u, 'erp_models', null))).find((m) => m.id === 'stat_expense')
  for (const who of people()) {
    const t = await trend(who.id)
    const yes = co.may.get(who).includes('paid')
    assert.equal(t.scope, who === co.books ? 'all' : 'mine', who.name)
    assert.equal(Number(t.total), yes ? AMOUNT.paid : 0, who.name)
    assert.equal(t.rows.length, yes ? 1 : 0, who.name)
    const m = await stat(who.id)
    assert.equal(m.evidence.scope, who === co.books ? 'all' : 'mine', who.name)
    assert.equal(/내가 볼 수 있는/.test(m.evidence.message), who !== co.books, `${who.name}: ${m.evidence.message}`)
    assert.equal(m.evidence.have, yes ? 1 : 0, who.name)
  }
  assert.equal((await trend(co.k.adminId)).scope, 'all')
})

test('an admin is accounting for this purpose: they can give themselves the role, and they sign for people with no manager', async () => {
  const { k } = co
  const rows = await req(k.adminId, `select * from public.erp_records where type = 'expense'`)
  assert.equal(rows.length, 3)
  assert.equal((await asRow(rpc(k.adminId, 'erp_expense_words', co.claims.paid.id))).title, SECRET.title)
  assert.ok(!JSON.stringify((await rpc(k.adminId, 'erp_stream', co.claims.paid.id))).includes(SECRET.title), 'and the ledger has nothing more for them')
})

test('a reason is words too: the commands that take one keep it outside, the rest refuse it', async () => {
  const { staff, boss, books, k } = co
  const e = await staff.cmd('expense', null, 'create', { title: '사유 시험', amount: 11, no_receipt_reason: '없음' })
  await rejects(staff.cmd('expense', e.id, 'update', { amount: 12 }, { reason: '원장에 남을 말' }), 'ERP_INVALID')
  await rejects(staff.cmd('expense', e.id, 'submit', {}, { reason: '원장에 남을 말' }), 'ERP_INVALID')
  await staff.cmd('expense', e.id, 'submit', {})
  await rejects(boss.cmd('expense', e.id, 'approve', {}, { reason: '원장에 남을 말' }), 'ERP_INVALID')
  await boss.cmd('expense', e.id, 'approve', {})
  await rejects(books.cmd('expense', e.id, 'pay', {}, { reason: '원장에 남을 말' }), 'ERP_INVALID')
  await books.cmd('expense', e.id, 'cancel', {}, { reason: '원장에 남지 않을 말' })
  assert.equal((await asRow(rpc(staff.id, 'erp_expense_words', e.id))).cancel_reason, '원장에 남지 않을 말')
  assert.equal(JSON.stringify((await k.events(e.id))).includes('남을 말'), false)
  assert.equal(JSON.stringify((await k.events(e.id))).includes('남지 않을 말'), false)
})

test('erasing: the words go for good, for those who may, the ledger says only that it happened, and the claim still stands', async () => {
  const { staff, boss, books, filer, k, peer } = co
  const e = await filer.cmd('expense', null, 'create', { employee_id: co.staffE.id, title: '지울 적요', note: '지울 메모', amount: 77, no_receipt_reason: '지울 사유' })
  await rejects(peer.cmd('expense', e.id, 'erase_private', {}), 'ERP_NOT_FOUND')
  await filer.cmd('expense', e.id, 'submit', {})
  await rejects(boss.cmd('expense', e.id, 'erase_private', {}), 'ERP_FORBIDDEN')
  await rejects(staff.cmd('expense', e.id, 'erase_private', { title: 'x' }), 'ERP_UNKNOWN_FIELD')
  await rejects(staff.cmd('expense', e.id, 'erase_private', {}, { reason: '원장에 남을 까닭' }), 'ERP_INVALID')
  await staff.cmd('expense', e.id, 'erase_private', {})
  const w = await asRow(rpc(books.id, 'erp_expense_words', e.id))
  for (const f of ['title', 'note', 'no_receipt_reason']) assert.equal(w[f], null, f)
  assert.deepEqual((await k.db.query('select * from erp.expense_private where expense_id = $1', [e.id])).rows, [])
  await rejects(staff.cmd('expense', e.id, 'erase_private', {}), 'ERP_NOT_FOUND')

  const trail = (await k.db.query(`select * from erp.events where event_type = 'ExpenseWordsErased' and data ->> 'expense_id' = $1`, [e.id])).rows
  assert.equal(trail.length, 1)
  assert.equal(trail[0].reason, null)
  assert.equal(trail[0].data.number, e.state.number)
  assert.equal(trail[0].actor_id, staff.id)
  assert.ok(!JSON.stringify(trail).includes('지울'))
  assert.equal((await req(staff.id, `select * from public.erp_events where event_type = 'ExpenseWordsErased'`)).length, 0, 'the audit trail is accounting\'s')
  assert.ok((await req(books.id, `select * from public.erp_events where event_type = 'ExpenseWordsErased'`)).length > 0)

  // The claim goes on without them, and has to say what it is before it can be filed again.
  await boss.cmd('expense', e.id, 'refuse', {}, { reason: '적요가 없습니다' })
  await rejects(staff.cmd('expense', e.id, 'submit', {}), 'ERP_REQUIRED')
  await staff.cmd('expense', e.id, 'update', { title: '다시 적음', no_receipt_reason: '다시 적음' })
  assert.equal((await staff.cmd('expense', e.id, 'submit', {})).status, 'submitted')
  await boss.cmd('expense', e.id, 'approve', {})
  await k.settle()
  assert.deepEqual(await k.verifyProjection(), [])

  // Deleting a draft takes its words along.
  const d = await staff.cmd('expense', null, 'create', { title: '지워질 초안', amount: 5 })
  await staff.cmd('expense', d.id, 'delete', {})
  assert.deepEqual((await k.db.query('select * from erp.expense_private where expense_id = $1', [d.id])).rows, [])
})

test('going back: words do not come with the ledger, so undoing a claim asks for them to go first, and a saga cancels instead', async () => {
  const { k, staff } = co
  const e = await staff.cmd('expense', null, 'create', { title: '되돌릴 적요', amount: 9, no_receipt_reason: '시험' })
  const target = JSON.stringify({ correlation_id: e.correlation_id })
  const plan = await asRow(rpc(k.adminId, 'erp_rollback_preview', 'correlation', target))
  assert.equal(plan.blocked.length, 1)
  assert.match(plan.blocked[0].reason, /적요와 메모는 원장 밖에/)
  await staff.cmd('expense', e.id, 'erase_private', {})
  const clear = await asRow(rpc(k.adminId, 'erp_rollback_preview', 'correlation', target))
  assert.deepEqual(clear.blocked, [])
  await k.db.asUser(k.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5)', ['correlation', target, clear.hash, true, '없던 일로 하는 사유'])
  assert.equal((await k.rec(e.id)).deleted, true)
  assert.deepEqual((await k.db.query('select * from erp.expense_private where expense_id = $1', [e.id])).rows, [], 'nothing left to hold a reason for a claim that is gone')
  assert.equal((await k.db.query(`select count(*)::int n from erp.events where reason = '없던 일로 하는 사유'`)).rows[0].n, 0)
  const again = await raw(() => asRow(rpc(staff.id, 'erp_stream', e.id)))
  assert.ok(again.includes('Reverted'), 'the person it was about can still read what happened to it')
})

test('a whole company going back to a date: the claim keeps the reason off its own stream, the other streams carry it', async () => {
  const k = await company({ modules: ['hr', 'expense'], clock: `${TODAY}T09:00:00+09:00` })
  try {
    await k.db.query(`select set_config('erp.clock', $1, false)`, [`${TODAY}T10:00:00+09:00`])
    const boss = await k.addMember('상사', ['viewer'])
    const staff = await k.addMember('직원', ['sales'])
    const d = (await k.admin('department', null, 'create', { name: '영업' })).id
    const bossE = await k.admin('employee', null, 'create', { name: '상사', hire_date: '2025-01-01', department_id: d, member_id: boss.record })
    await k.admin('employee', null, 'create', { name: '직원', hire_date: '2025-01-01', department_id: d, member_id: staff.record, manager_id: bossE.id })
    const e = await staff.cmd('expense', null, 'create', { title: '시점 되돌리기', amount: 10, no_receipt_reason: '시험' })
    await staff.cmd('expense', e.id, 'submit', {})
    await k.db.query(`select set_config('erp.clock', $1, false)`, [`${TODAY}T11:00:00+09:00`])
    await boss.cmd('expense', e.id, 'approve', {})
    const other = await k.admin('department', null, 'create', { name: '늦게 만든 부서' })
    await k.db.query(`select set_config('erp.clock', $1, false)`, [`${TODAY}T12:00:00+09:00`])
    const target = JSON.stringify({ at: `${TODAY}T10:30:00+09:00` })
    const plan = (await k.db.asUser(k.adminId, `select public.erp_rollback_preview('time', $1) r`, [target])).rows[0].r
    assert.deepEqual(plan.blocked, [])
    await k.db.asUser(k.adminId, 'select public.erp_rollback_apply($1, $2, $3, $4, $5)', ['time', target, plan.hash, true, '회사를 그날로 되돌림'])
    assert.equal((await k.rec(e.id)).status, 'submitted')
    assert.equal((await k.rec(other.id)).deleted, true)
    const reasons = (await k.db.query(`select stream_type, reason from erp.events where event_type = 'Reverted'`)).rows
    assert.deepEqual(reasons.filter((r) => r.stream_type === 'expense').map((r) => r.reason), [null])
    assert.deepEqual(reasons.filter((r) => r.stream_type === 'department').map((r) => r.reason), ['회사를 그날로 되돌림'])
    assert.equal((await k.db.asUser(staff.id, 'select public.erp_expense_words($1) r', [e.id])).rows[0].r.undo_reason, '회사를 그날로 되돌림')
  } finally { await k.close() }
})

test('the claimant\'s agent undoes its own work by key: cancelled, the reason kept outside, its name kept off the plan for what it may not read', async () => {
  const { k, staff, peer, books } = co
  const { saga } = co.claims
  // Someone else's key cannot plan it or carry it out.
  assert.ok((await tool(peer.key, 'erp_read', { rollback: { correlation_id: saga.corr } })).isError)
  const forged = await tool(peer.key, 'erp_create', { type: 'rollback', values: { correlation_id: saga.corr, plan_hash: 'x' }, reason: '남의 일' })
  assert.ok(forged.isError)
  assert.match(forged.content[0].text, /ERP_FORBIDDEN/)

  const plan = json(await tool(staff.key, 'erp_read', { rollback: { correlation_id: saga.corr } }))
  assert.equal(plan.mode, 'compensate')
  assert.equal(plan.compensations[0].command, 'cancel')
  const done = json(await tool(staff.key, 'erp_create', { type: 'rollback', values: { correlation_id: saga.corr, plan_hash: plan.hash }, reason: SECRET.sagaReason }))
  assert.equal(done.mode, 'compensate')
  await k.settle()
  assert.equal((await k.rec(saga.id)).status, 'cancelled')
  assert.equal((await asRow(rpc(staff.id, 'erp_expense_words', saga.id))).cancel_reason, SECRET.sagaReason)
  assert.deepEqual(wordsIn(JSON.stringify((await k.db.query('select * from erp.events')).rows)), [], 'not on any stream')
  assert.equal((await k.db.query('select reason from erp.saga_undone where saga_id = $1', [saga.corr])).rows[0].reason, '')
  const status = json(await tool(staff.key, 'erp_read', { saga: saga.corr }))
  assert.equal(status.undone.mode, 'compensate')
  assert.equal(status.undone.reason, '')
  assert.ok(status.documents.some((d) => d.id === saga.id))
  assert.equal((await tool(books.key, 'erp_read', { saga: saga.corr })).isError, undefined)
  const outsider = json(await tool(peer.key, 'erp_read', { saga: saga.corr }))
  assert.deepEqual(outsider, { saga_id: saga.corr, undone: null, events: 0, documents: [], net: [], pending: false, stuck: [] })
})

test('an approver\'s agent plans the undo of its own approval: the entry it may not read is counted, not named, and the plan still runs', async () => {
  const { k, boss, staff } = co
  const e = await staff.cmd('expense', null, 'create', { title: '승인 되돌리기', amount: 3322110, no_receipt_reason: '시험' })
  await staff.cmd('expense', e.id, 'submit', {})
  const saga = crypto.randomUUID()
  json(await tool(boss.key, 'erp_update', { type: 'expense', id: e.id, saga_id: saga, values: { state: 'approved' } }))
  await k.settle()
  const plan = json(await tool(boss.key, 'erp_read', { rollback: { correlation_id: saga } }))
  assert.equal(plan.mode, 'rollback')
  const entry = plan.streams.find((s) => s.type === 'journal_entry')
  assert.ok(entry, 'the undo covers the entry, so it is in the plan')
  assert.equal(entry.name, undefined)
  assert.equal(entry.effects, undefined)
  assert.ok(!JSON.stringify(plan.streams.filter((s) => s.type === 'journal_entry')).includes('3322110'))
  assert.ok(plan.streams.find((s) => s.type === 'expense').name, 'its own claim it may name')
  const status = json(await tool(boss.key, 'erp_read', { saga }))
  assert.ok(!status.documents.some((d) => d.type === 'journal_entry'))
  assert.deepEqual(status.net, [])
  json(await tool(boss.key, 'erp_create', { type: 'rollback', values: { correlation_id: saga, plan_hash: plan.hash }, reason: '잘못 승인' }))
  assert.equal((await k.rec(e.id)).status, 'submitted')
  await k.settle()
  assert.equal((await k.db.query(`select count(*)::int n from erp.events where reason = '잘못 승인'`)).rows[0].n, 0)
  assert.equal((await asRow(rpc(staff.id, 'erp_expense_words', e.id))).undo_reason, '잘못 승인')
})

test('one piece of work over two people\'s claims: each sees their own document in it and not the other\'s', async () => {
  const { books, staff, peer, filer, staffE, k } = co
  const peerE = (await k.db.query(`select id from erp.records where type = 'employee' and state ->> 'name' = '오동료'`)).rows[0].id
  const saga = crypto.randomUUID()
  const mine = json(await tool(books.key, 'erp_create', { type: 'expense', saga_id: saga, values: { employee_id: staffE.id, title: '둘 중 하나', amount: 4411001, no_receipt_reason: '시험' } }))
  const theirs = json(await tool(books.key, 'erp_create', { type: 'expense', saga_id: saga, values: { employee_id: peerE, title: '둘 중 하나', amount: 4411002, no_receipt_reason: '시험' } }))
  for (const via of ['login', 'key']) {
    const read = async (who) => (via === 'login' ? JSON.stringify(await asRow(rpc(who.id, 'erp_saga_status', saga))) : (await tool(who.key, 'erp_read', { saga })).content[0].text)
    const [a, b, c] = [await read(staff), await read(peer), await read(filer)]
    assert.ok(a.includes(mine.id) && !a.includes(theirs.id), `${via}: the claimant`)
    assert.ok(b.includes(theirs.id) && !b.includes(mine.id), `${via}: the other claimant`)
    assert.ok(!c.includes(mine.id) && !c.includes(theirs.id), `${via}: someone with nothing to do with either`)
    assert.ok((await read(books)).includes(mine.id) && (await read(books)).includes(theirs.id), `${via}: accounting`)
    const corr = via === 'login' ? JSON.stringify(await asRow(rpc(staff.id, 'erp_correlation', saga))) : ''
    assert.ok(!corr.includes('4411002'), 'nor the other one\'s amount in the events of the same work')
  }
})

test('accounting turned on late books the same from events that carry no words, and a rebuild changes nothing', async () => {
  const k = await company({ modules: ['hr', 'expense'], clock: `${TODAY}T09:00:00+09:00` })
  try {
    await k.db.query(`select set_config('erp.clock', $1, false)`, [`${TODAY}T10:00:00+09:00`])
    const boss = await k.addMember('상사', ['viewer'])
    const staff = await k.addMember('직원', ['sales'])
    const books = await k.addMember('회계', ['accounting'])
    const d = (await k.admin('department', null, 'create', { name: '영업' })).id
    const bossE = await k.admin('employee', null, 'create', { name: '상사', hire_date: '2025-01-01', department_id: d, member_id: boss.record })
    await k.admin('employee', null, 'create', { name: '직원', hire_date: '2025-01-01', department_id: d, member_id: staff.record, manager_id: bossE.id })
    const e = await staff.cmd('expense', null, 'create', { title: '늦게 켜는 장부', amount: 4000, no_receipt_reason: '시험', date: '2026-06-01' })
    await staff.cmd('expense', e.id, 'submit', {})
    await boss.cmd('expense', e.id, 'approve', {})
    await books.cmd('expense', e.id, 'pay', {})
    await k.settle()
    await k.admin('module', null, 'enable', { id: 'accounting' })
    await k.settle()
    const tb = (await k.db.asUser(k.adminId, 'select public.erp_trial_balance() r')).rows[0].r.rows
    assert.equal(tb.reduce((n, r) => n + Number(r.debit), 0), 8000)
    assert.equal(tb.reduce((n, r) => n + Number(r.credit), 0), 8000)
    assert.deepEqual((await k.db.query('select distinct name from erp.gl_lines')).rows, [{ name: `${e.state.number} 기타 경비` }])
    assert.equal((await k.settle()).failing, 0)

    let after_ = 0
    for (;;) {
      const r = (await k.db.asUser(k.adminId, 'select public.erp_rebuild($1, 500) r', [after_])).rows[0].r
      if (r.done) break
      after_ = r.last_seq
    }
    assert.deepEqual(await k.verifyProjection(), [])
    assert.equal((await k.db.query('select title from erp.expense_private where expense_id = $1', [e.id])).rows[0].title, '늦게 켜는 장부', 'a rebuild does not touch what is not derived')
  } finally { await k.close() }
})

test('the kernel: read_scope works from the catalog for any type, and a type without one reads as before', async () => {
  const k = await company({ modules: ['hr'] })
  try {
    await k.db.query(`select erp.catalog_put('{"type":"t_note","module":"t","label":"쪽지","read_scope":{"roles":["hr"],"fn":"erp.t_note_ids"},
        "fields":[{"name":"name","label":"이름","type":"text","required":true},{"name":"owner","label":"주인","type":"text"}],
        "commands":{"create":{"roles":["member"]},"update":{"roles":["member"]}}}'::jsonb);
      select erp.catalog_put('{"type":"t_open","module":"t","label":"공개","fields":[{"name":"name","label":"이름","type":"text","required":true}],"commands":{"create":{"roles":["member"]}}}'::jsonb);
      select erp.module_put('{"id":"t","label":"시험"}'::jsonb);
      create function erp.t_note_ids() returns uuid[] language sql stable as $f$
        select coalesce(array_agg(id), '{}') from erp.records where type = 't_note' and state ->> 'owner' = erp.current_actor()::text $f$;`)
    await k.admin('module', null, 'enable', { id: 't' })
    const a = await k.addMember('갑', ['sales'])
    const b = await k.addMember('을', ['sales'])
    const staff = await k.addMember('인사', ['hr'])
    const note = await a.cmd('t_note', null, 'create', { name: '갑의 쪽지', owner: a.id })
    const open = await b.cmd('t_open', null, 'create', { name: '공개 쪽지' })
    const seen = async (u, sql, ...p) => (await k.db.asUser(u, sql, p)).rows.length
    for (const [who, n] of [[a, 1], [b, 0], [staff, 1]]) {
      assert.equal(await seen(who.id, `select * from public.erp_records where type = 't_note'`), n)
      assert.equal(await seen(who.id, `select * from public.erp_events where stream_type = 't_note'`), n)
      assert.equal(await seen(who.id, `select * from public.erp_records where id = $1`, open.id), 1, 'the open type is not touched')
      assert.equal((await k.db.asUser(who.id, `select public.erp_records_at('t_note', now() + interval '1 day') r`)).rows[0].r.total, n)
    }
    await rejects(k.db.asUser(b.id, 'select public.erp_stream($1)', [note.id]), 'ERP_FORBIDDEN')
    await rejects(b.cmd('t_note', note.id, 'update', { name: 'x' }), 'ERP_NOT_FOUND')
    assert.equal((await a.cmd('t_note', note.id, 'update', { name: '고침' })).name, '고침')
    assert.ok((await k.db.asUser(b.id, 'select erp.scoped_types() t')).rows[0].t.includes('t_note'))
    assert.ok(!(await k.db.asUser(staff.id, 'select erp.scoped_types() t')).rows[0].t.includes('t_note'))
    assert.deepEqual((await k.db.asUser(k.adminId, 'select erp.scoped_types() t')).rows[0].t, [])
    assert.deepEqual((await k.db.asUser(null, 'select erp.scoped_types() t')).rows[0].t, [], 'no login, no scope: and no type readable either')
    assert.deepEqual((await k.db.asUser(null, 'select erp.readable_types() t')).rows[0].t, [])
  } finally { await k.close() }
})

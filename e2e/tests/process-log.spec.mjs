// S22 on the screen: orders worked through the real modules become cases; the page counts them, shows the common flows, and its buttons
// give a CSV, an XES and an OCEL 2.0 file a mining tool reads, and a note a person pastes into Process GPT. Real stack.
import fs from 'node:fs'
import { test, expect, shot, connectAndLogin, expectFitsWidth } from '../lib/fixtures.mjs'
import { ADMIN, command, freshCompany, sql, tokenFor, waitFor } from '../lib/stack.mjs'

test.describe.configure({ mode: 'serial', timeout: 120_000 })

const SALES = { name: '박영업', email: 'sales@example.com', password: 'sales-pass-1234' }
const FULL = ['견적 생성', '주문 확정', '전표 생성', '전표 확인', '입출고 완료', '청구서 생성', '청구서 게시', '입금 초안', '결제 게시', '결제 반영']
// Delivery waits behind any open transaction in the cluster, and other test runs share it. This is what cron does, sooner.
const until = (check, what) => waitFor(async () => { await sql('select erp.bus_run(1500)'); return check() }, what, 400)
const slip = async (order) => (await sql(`select id from erp.records where type = 'picking' and state ->> 'origin_id' = $1 and status not in ('done', 'cancelled')`, [order])).rows[0]?.id

test.beforeAll(async () => {
  test.setTimeout(120_000)
  await freshCompany()
  const token = await tokenFor(ADMIN.email, ADMIN.password)
  await command(token, 'member', null, 'create', { ...SALES, roles: ['sales'] })
  const customer = (await command(token, 'partner', null, 'create', { name: '가온마트', region: '수도권' })).id
  const product = await command(token, 'product', null, 'create', { name: '에어서큘레이터', list_price: 89000, standard_price: 52000, type: 'goods' })
  const variant = product.state.variants[0].id
  await command(token, 'stock_adjustment', null, 'create', { variant_id: variant, counted_qty: 50, apply: true })
  const order = async () => {
    const o = await command(token, 'sales_order', null, 'create', { partner_id: customer, lines: [{ variant_id: variant, qty: 2 }] })
    await command(token, 'sales_order', o.id, 'confirm')
    let pk
    await until(async () => !!(pk = await slip(o.id)), `주문 ${o.id} 의 출고 전표`)
    return { id: o.id, pk }
  }
  // Three orders the whole way to payment, one still waiting to ship, and one cancelled.
  for (let i = 0; i < 3; i++) {
    const o = await order()
    await command(token, 'picking', o.pk, 'validate')
    await until(async () => (await sql(`select state ->> 'delivery_status' s from erp.records where id = $1`, [o.id])).rows[0].s === 'full', '출고 반영')
    const inv = await command(token, 'account_move', null, 'create', { from_sales_order: o.id })
    await command(token, 'account_move', inv.id, 'post')
    await command(token, 'payment', null, 'create', { from_moves: [inv.id], post: true })
  }
  await order()
  const cancelled = await order()
  await command(token, 'sales_order', cancelled.id, 'cancel')
  await until(async () => !(await slip(cancelled.id)), '취소한 주문의 전표 취소')
  await sql('select erp.bus_run(5000)')
})

test('프로세스 마이닝 로그: 사례 수와 자주 나온 흐름을 보여 준다', async ({ page }) => {
  await connectAndLogin(page)
  await page.locator('[data-module="analytics"]').click()
  await page.locator('[data-screen="/analytics/process-log"]').click()
  await expect(page).toHaveURL(/#\/analytics\/process-log/)
  await expect(page.getByTestId('pl-cases')).toHaveText('5건')
  await expect(page.getByTestId('pl-variants')).toHaveText('3가지')
  const first = page.getByTestId('pl-variant').first()
  await expect(first.locator('.step')).toHaveText(FULL)
  await expect(first).toContainText('60.0%')
  await expect(page.getByTestId('pl-variant').filter({ hasText: '주문 취소' })).toHaveCount(1)
  await shot(page, 'process-log-01-o2c')

  // Every activity brings the bookkeeping back; major-only is the default.
  const short = Number((await page.getByTestId('pl-events').textContent()).replace(/\D/g, ''))
  await page.getByTestId('pl-major').uncheck()
  await expect(page.getByTestId('pl-events')).not.toHaveText(`${short.toLocaleString('ko-KR')}건`)
  expect(Number((await page.getByTestId('pl-events').textContent()).replace(/\D/g, ''))).toBeGreaterThan(short)
  await page.getByTestId('pl-major').check()
  await expect(page.getByTestId('pl-events')).toHaveText(`${short.toLocaleString('ko-KR')}건`)

  // No purchase was made, and each transfer on its own is a case.
  await page.getByTestId('pl-notion-purchase_order').click()
  await expect(page.getByTestId('empty-state')).toContainText('이 기간에 시작한 사례가 없습니다')
  await expect(page.getByTestId('pl-csv')).toHaveCount(0)
  await page.getByTestId('pl-notion-document').click()
  await page.getByTestId('pl-doc-type').selectOption('picking')
  await expect(page.getByTestId('pl-cases')).toHaveText('5건')
})

test('세 파일은 형식대로이고, 변형 요약은 쉬운 말로 복사된다', async ({ page }) => {
  await connectAndLogin(page)
  await page.goto('/#/analytics/process-log')
  await expect(page.getByTestId('pl-cases')).toHaveText('5건')

  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByTestId('pl-csv').click()])
  expect(csv.suggestedFilename()).toMatch(/^erp-o2c-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/)
  const text = fs.readFileSync(await csv.path(), 'utf8')
  expect(text.charCodeAt(0)).toBe(0xfeff)
  const lines = text.slice(1).trimEnd().split('\n')
  expect(lines[0]).toBe('case_id,case_label,activity,event_type,timestamp,resource,source,document_type,document,seq')
  expect(lines.length - 1).toBe(Number((await page.getByTestId('pl-events').textContent()).replace(/\D/g, '')))
  expect(lines[1].split(',')[4]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+09:00$/)

  const [xes] = await Promise.all([page.waitForEvent('download'), page.getByTestId('pl-xes').click()])
  const xml = fs.readFileSync(await xes.path(), 'utf8')
  const parsed = await page.evaluate((s) => {
    const doc = new DOMParser().parseFromString(s, 'application/xml')
    return { error: doc.getElementsByTagName('parsererror').length, root: doc.documentElement.localName, version: doc.documentElement.getAttribute('xes.version'),
      traces: doc.getElementsByTagName('trace').length, events: doc.getElementsByTagName('event').length,
      first: [...doc.querySelector('trace > event').children].map((a) => a.getAttribute('key')) }
  }, xml)
  expect(parsed).toMatchObject({ error: 0, root: 'log', version: '1849-2016', traces: 5, events: lines.length - 1 })
  expect(parsed.first).toEqual(['concept:name', 'time:timestamp', 'org:resource', 'erp:event_type', 'erp:document', 'erp:document_type', 'erp:source', 'erp:seq'])

  const [ocelFile] = await Promise.all([page.waitForEvent('download'), page.getByTestId('pl-ocel').click()])
  expect(ocelFile.suggestedFilename()).toMatch(/\.ocel\.json$/)
  const ocel = JSON.parse(fs.readFileSync(await ocelFile.path(), 'utf8'))
  expect(Object.keys(ocel).sort()).toEqual(['eventTypes', 'events', 'objectTypes', 'objects'])
  expect(ocel.objectTypes.map((t) => t.name).sort()).toEqual(['견적·주문', '입금·지급', '입출고 전표', '청구서'])
  const objects = new Set(ocel.objects.map((o) => o.id))
  expect(ocel.events.every((e) => e.relationships.length >= 1 && e.relationships.every((r) => objects.has(r.objectId)))).toBe(true)
  expect(ocel.events.length).toBe(lines.length - 1)

  await page.getByTestId('pl-copy').click()
  await expect(page.getByTestId('pl-copied')).toBeVisible()
  const note = await page.evaluate(() => navigator.clipboard.readText())
  expect(note).toContain('주문-수금 흐름 5건')
  expect(note).toContain(`1. ${FULL.join(' → ')} (3건, 60%`)
  expect(note).toContain('프로세스를 만들어 주세요')
  expect(note).not.toMatch(/[A-Z][a-z]+[A-Z]|[0-9a-f]{8}-[0-9a-f]{4}/)
  await shot(page, 'process-log-02-copied')
})

test('영업만 가진 사람에게는 입금이 빠진 사례가 보이고, 좁은 화면에서도 넘치지 않는다', async ({ page }) => {
  await connectAndLogin(page, SALES)
  await page.goto('/#/analytics/process-log')
  await expect(page.getByTestId('pl-cases')).toHaveText('5건')
  const first = page.getByTestId('pl-variant').first()
  await expect(first.locator('.step')).toHaveText(['견적 생성', '주문 확정', '전표 생성', '전표 확인', '입출고 완료', '청구서 생성', '청구서 게시', '결제 반영'])
  await page.setViewportSize({ width: 390, height: 800 })
  await expectFitsWidth(page, '[data-testid="process-log"] .toolbar, [data-testid="pl-counts"], [data-testid="process-log"] .actions')
  await shot(page, 'process-log-03-sales-phone')
})

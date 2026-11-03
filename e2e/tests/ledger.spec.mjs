// The event ledger, causal chains, integrity check, usage and backup.
import fs from 'node:fs'
import zlib from 'node:zlib'
import { test, expect, shot, connectAndLogin } from '../lib/fixtures.mjs'
import { ADMIN, command, freshCompany, sql, tokenFor } from '../lib/stack.mjs'
import { installTestTypes } from '../lib/test-types.mjs'

test.describe.configure({ mode: 'serial' })
let orderId
let token
let customerId

test.beforeAll(async () => {
  await freshCompany()
  await installTestTypes()
  token = await tokenFor(ADMIN.email, ADMIN.password)
  const { rows } = await sql(`select id from erp.records where type = 'test_customer' order by name limit 1`)
  customerId = rows[0].id
  const created = await command(token, 'test_order', null, 'create', { customer_id: customerId, lines: [] })
  orderId = created.id
  await command(token, 'test_order', orderId, 'update', { note: '에이전트가 고침' }, { p_source: 'agent', p_reason: '재고 부족 감지' })
  await command(token, 'test_order', orderId, 'confirm', { promised: '2026-12-01' })
})

test('원장 표와 필터', async ({ page }) => {
  await connectAndLogin(page)
  await page.locator('[data-module="events"]').click()
  await expect(page.getByTestId('events-table')).toBeVisible()
  await expect(page.getByTestId('event-row').first()).toContainText('연쇄 반응')
  await shot(page, '30-events')

  await page.getByTestId('filter-type').selectOption('test_order')
  await expect(page.getByTestId('events-count')).toHaveText('3건')
  await page.getByTestId('filter-source').selectOption('agent')
  await expect(page.getByTestId('events-count')).toHaveText('1건')
  await expect(page.getByTestId('event-row').first()).toContainText('에이전트')
  await page.getByTestId('filter-clear').click()

  await page.getByTestId('filter-event').fill('Confirmed')
  await expect(page.getByTestId('events-count')).toHaveText('1건')
  await page.getByTestId('filter-clear').click()
  await page.getByTestId('filter-actor').fill('없는사람')
  await expect(page.getByTestId('empty-state')).toContainText('조건에 맞는 이벤트가 없습니다')
  await page.getByTestId('filter-clear').click()
  await expect(page.getByTestId('event-row').first()).toBeVisible()
})

test('행을 누르면 원본 JSON 과 인과 사슬 트리가 나온다', async ({ page }) => {
  await connectAndLogin(page)
  await page.goto('/#/events?type=test_shipment')
  await page.getByTestId('event-row').first().click()
  const detail = page.getByTestId('event-detail')
  await expect(detail.getByTestId('event-json')).toContainText('"order_id"')
  const tree = detail.getByTestId('chain-tree')
  // A confirmation (root) caused the shipment (child), one level down.
  await expect(tree.locator('> li > button .chain-title')).toHaveText('시험 주문 확정')
  await expect(tree.locator('> li > ul > li > button .chain-title')).toHaveText('시험 출고 생성')
  await shot(page, '31-event-chain')
  // Selecting a node shows that event.
  await tree.locator('> li > button').click()
  await expect(detail.getByTestId('event-json')).toContainText('"promised"')
  await detail.getByTestId('event-open-record').click()
  await expect(page).toHaveURL(new RegExp(`test_order/${orderId}`))
})

test('이력은 출처와 사유를 구분해 보여 준다', async ({ page }) => {
  await connectAndLogin(page)
  await page.goto(`/#/r/test_order/${orderId}`)
  const agentItem = page.getByTestId('history-item').filter({ hasText: '에이전트' })
  await expect(agentItem).toContainText('재고 부족 감지')
  await shot(page, '32-history-sources')
})

test('무결성 검증은 진행률과 결과를 보여 주고, 손상을 찾아낸다', async ({ page }) => {
  await connectAndLogin(page)
  await page.goto('/#/events')
  await page.getByTestId('verify').click()
  await expect(page.getByTestId('verify-ok')).toContainText('불일치 0건')
  await shot(page, '33-verify-ok')

  // Damage the projection behind the ledger's back; replay must notice.
  await sql(`update erp.records set state = state || '{"note":"몰래 고친 값"}' where id = $1`, [orderId])
  await page.getByTestId('verify').click()
  await expect(page.getByTestId('verify-bad')).toContainText('1건이 이벤트와 다릅니다')
  await shot(page, '34-verify-bad')
  await sql(`update erp.records set state = erp.fold(id) where id = $1`, [orderId])
  await page.getByTestId('verify').click()
  await expect(page.getByTestId('verify-ok')).toContainText('불일치 0건')
})

test('사용량은 500MB 대비 막대와 무료 플랜 안내를 보여 준다', async ({ page }) => {
  await connectAndLogin(page)
  await page.goto('/#/settings/usage')
  await expect(page.getByTestId('usage-text')).toContainText('/ 500.0 MB')
  await expect(page.getByTestId('usage').getByRole('progressbar')).toBeVisible()
  const notes = page.getByTestId('free-plan-notes')
  await expect(notes).toContainText('자동 백업이 없습니다')
  await expect(notes).toContainText('7일 동안 활동이 없으면')
  await shot(page, '35-usage')
})

test('백업은 묶음으로 받아 NDJSON.gz 파일로 저장한다', async ({ page }) => {
  await connectAndLogin(page)
  await page.goto('/#/settings/backup')
  const download = page.waitForEvent('download')
  await page.getByTestId('backup').click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/^uengine-erp_.*\.ndjson\.gz$/)
  await expect(page.getByTestId('backup-done')).toContainText('받았습니다')
  await shot(page, '36-backup')
  const lines = zlib.gunzipSync(fs.readFileSync(await file.path())).toString('utf8').trim().split('\n').map((l) => JSON.parse(l))
  expect(lines[0]._meta).toBe('uengine-erp-ledger')
  expect(lines.at(-1)._meta).toBe('sequences')
  const events = lines.slice(1, -1)
  const { rows } = await sql('select count(*)::int as n from erp.events')
  expect(events.length).toBe(rows[0].n)
  expect(lines.at(-1).events).toBe(rows[0].n)
  expect(events[0].seq).toBeLessThan(events.at(-1).seq)
  expect(lines.at(-1).sequences.T).toBe(1)
})

test('회사 정보는 저장되고 통화는 읽기 전용이며 표시줄에 바로 반영된다', async ({ page }) => {
  await connectAndLogin(page)
  await page.goto('/#/settings/company')
  await page.locator('[data-field="representative"] input').fill('김대표')
  await page.locator('[data-field="name"] input').fill('한빛정밀 (주)')
  await expect(page.locator('[data-field="currency"] input')).toHaveCount(0)
  await expect(page.locator('[data-field="currency"] .field-value')).toHaveText('KRW')
  await shot(page, '37-settings-company')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('company-name')).toHaveText('한빛정밀 (주)')
})

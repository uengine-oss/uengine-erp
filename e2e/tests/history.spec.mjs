// Time travel: a document's slider by version, and the whole company as it stood on a date. Scenario S6 step 1.
import { test, expect, shot, connectAndLogin, expectDark, expectFitsWidth, failRpc, fieldInput, restoreRpc } from '../lib/fixtures.mjs'
import { ADMIN, command, freshCompany, sql, tokenFor } from '../lib/stack.mjs'
import { installTestTypes } from '../lib/test-types.mjs'

test.describe.configure({ mode: 'serial' })

const VIEWER = { name: '박조회', email: 'viewer@example.com', password: 'viewer-pass-1234' }
let token
let customer
let spring
let april
let sameTime

async function seedAt(at, type, id, cmd, payload = {}) {
  const { rows } = await sql(`with c as materialized (select set_config('erp.clock', $1, true)) select erp.dispatch($2, $3::uuid, $4, $5::jsonb) as id from c`, [at, type, id, cmd, JSON.stringify(payload)])
  return rows[0].id
}

const pickDate = async (page, day) => {
  await page.getByTestId('time-view-date').fill(day)
  await expect(page.getByTestId('company-time-banner')).toContainText(`${day} 시점을 보고 있습니다`)
}

test.beforeAll(async () => {
  await freshCompany()
  await installTestTypes()
  token = await tokenFor(ADMIN.email, ADMIN.password)
  await command(token, 'member', null, 'create', { ...VIEWER, roles: ['viewer'] })
  customer = (await sql(`select id from erp.records where type = 'test_customer' order by name limit 1`)).rows[0].id

  spring = await seedAt('2026-02-10 10:00+09', 'test_order', null, 'create', { customer_id: customer, note: '2월 메모', lines: [] })
  await seedAt('2026-02-20 10:00+09', 'test_order', spring, 'update', { note: '2월 말 메모' })
  await seedAt('2026-03-15 10:00+09', 'test_order', spring, 'send')
  await seedAt('2026-03-16 10:00+09', 'test_order', spring, 'update', { note: '3월 메모' })
  april = await seedAt('2026-04-02 10:00+09', 'test_order', null, 'create', { customer_id: customer, note: '4월 주문', lines: [] })

  // Two events at one instant: only their versions tell them apart.
  sameTime = await seedAt('2026-02-01 09:00+09', 'test_order', null, 'create', { customer_id: customer, note: '같은 순간 첫째', lines: [] })
  await seedAt('2026-02-01 09:00+09', 'test_order', sameTime, 'update', { note: '같은 순간 둘째' })
  await seedAt('2026-02-01 09:00+09', 'test_order', sameTime, 'update', { note: '같은 순간 셋째' })
})

test('문서 슬라이더는 버전으로 읽어서, 같은 순간의 이벤트도 구분한다', async ({ page }) => {
  const reads = []
  page.on('request', (r) => { if (/rpc\/erp_(at_version|as_of)$/.test(r.url())) reads.push(r.url().split('/').pop()) })
  await connectAndLogin(page)
  await page.goto(`/#/r/test_order/${sameTime}`)
  const slider = page.getByTestId('time-slider').locator('input[type=range]')
  await slider.fill('1')
  await expect(page.getByTestId('time-banner')).toContainText('v1')
  await expect(page.locator('[data-field="note"] .field-value')).toHaveText('같은 순간 첫째')
  await slider.fill('2')
  await expect(page.getByTestId('time-banner')).toContainText('v2')
  await expect(page.locator('[data-field="note"] .field-value')).toHaveText('같은 순간 둘째')
  expect(new Set(reads)).toEqual(new Set(['erp_at_version']))
  await shot(page, '120-slider-by-version')
  await page.getByTestId('time-exit').click()
  await expect(page.locator('[data-field="note"] textarea')).toHaveValue('같은 순간 셋째')
})

test('날짜를 고르면 목록이 그 시점으로 바뀌고 쓰기 버튼이 모두 사라진다', async ({ page }) => {
  const reads = []
  page.on('request', (r) => { if (r.url().endsWith('/rpc/erp_records_at')) reads.push(r.postDataJSON()) })
  await connectAndLogin(page)
  await page.goto('/#/r/test_order')
  await expect(page.getByTestId('list-count')).toHaveText('3건')
  await expect(page.getByTestId('new-record')).toBeVisible()

  await pickDate(page, '2026-03-01')
  await expect(page.getByTestId('list-count'), '4월 주문은 아직 없다').toHaveText('2건')
  await expect(page.getByTestId('new-record')).toHaveCount(0)
  await expect(page.getByTestId('list-search')).toHaveCount(0)
  await expect(page.getByTestId('past-note')).toBeVisible()
  expect(reads.at(-1).p_at).toBe(new Date('2026-03-01T23:59:59.999+09:00').toISOString())
  await shot(page, '121-company-time-list')

  // The state filter is asked of the ledger too: on March 1 the order had not been sent.
  await page.getByTestId('state-filter').getByRole('button', { name: '발송' }).click()
  await expect(page.getByTestId('empty-state')).toContainText('조건에 맞는 시험 주문이 없습니다')
  await pickDate(page, '2026-03-20')
  await expect(page.getByTestId('list-count')).toHaveText('1건')
  await page.getByTestId('state-filter').getByRole('button', { name: '전체' }).click()
  await expect(page.getByTestId('list-count')).toHaveText('2건')

  await page.getByTestId('company-time-exit').click()
  await expect(page.getByTestId('company-time-banner')).toHaveCount(0)
  await expect(page.getByTestId('list-count')).toHaveText('3건')
  await expect(page.getByTestId('new-record')).toBeVisible()
  await expect(page.getByTestId('time-view-date')).toHaveValue('')
})

test('그 시점의 문서는 읽기 전용이고, 그때 없던 문서와 새 문서는 안내한다', async ({ page }) => {
  await connectAndLogin(page)
  await page.goto(`/#/r/test_order/${spring}`)
  await expect(page.getByTestId('save')).toBeVisible()
  await pickDate(page, '2026-03-01')
  const note = page.locator('[data-field="note"] .field-value')
  await expect(note).toHaveText('2월 말 메모')
  await expect(page.locator('.pipeline li.on')).toHaveText('초안')
  await expect(page.getByTestId('form-version')).toHaveText('v2')
  await expect(page.getByTestId('save')).toHaveCount(0)
  await expect(page.locator('[data-testid^="tr-"]')).toHaveCount(0)
  await expect(page.getByTestId('more-menu')).toHaveCount(0)
  await expect(page.locator('[data-field="note"] textarea')).toHaveCount(0)
  await expect(page.getByTestId('time-banner'), '배너는 위에 하나만').toHaveCount(0)
  await expect(page.getByTestId('history-rollback-work')).toHaveCount(0)
  await shot(page, '122-company-time-form')

  await pickDate(page, '2026-03-16')
  await expect(note).toHaveText('3월 메모')
  await expect(page.locator('.pipeline li.on')).toHaveText('발송')

  await page.goto(`/#/r/test_order/${april}`)
  await expect(page.getByTestId('empty-state')).toContainText('이 시점에는 없던 문서입니다')
  await shot(page, '123-company-time-absent')
  await page.goto('/#/r/test_order/new')
  await expect(page.getByTestId('empty-state')).toContainText('과거 시점에서는 새로 만들 수 없습니다')

  // The company itself was set up today, in this test run.
  await page.goto('/#/settings/members')
  await expect(page.getByTestId('empty-state')).toContainText('표시할 구성원이 없습니다')
  await expect(page.getByTestId('member-add')).toHaveCount(0)
  await page.goto('/#/settings/company')
  await expect(page.getByTestId('empty-state')).toContainText('이 시점에는 없던 문서입니다')
  await expect(page.getByTestId('save')).toHaveCount(0)
  await pickDate(page, new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date()))
  await page.goto('/#/settings/members')
  await expect(page.getByTestId('members-table')).toBeVisible()
  await expect(page.getByTestId('member-add')).toHaveCount(0)
  await expect(page.getByTestId('member-deactivate')).toHaveCount(0)
  await page.goto('/#/settings/company')
  await expect(page.locator('[data-field="name"] .field-value')).toBeVisible()
  await expect(page.getByTestId('save')).toHaveCount(0)

  await page.goto(`/#/r/test_order/${april}`)
  await page.getByTestId('company-time-exit').click()
  await expect(page.locator('[data-field="note"] textarea')).toHaveValue('4월 주문')
  await expect(page.getByTestId('save')).toBeVisible()
})

test('입력 중이던 내용은 과거를 보고 돌아와도 남아 있다', async ({ page }) => {
  await connectAndLogin(page)
  await page.goto(`/#/r/test_order/${spring}`)
  await fieldInput(page, 'note').fill('아직 저장하지 않은 메모')
  await page.waitForTimeout(400)
  await expect(page.getByTestId('dirty-mark')).toBeVisible()
  await pickDate(page, '2026-03-01')
  await expect(page.locator('[data-field="note"] .field-value')).toHaveText('2월 말 메모')
  await page.getByTestId('company-time-exit').click()
  await expect(fieldInput(page, 'note')).toHaveValue('아직 저장하지 않은 메모')
  await expect(page.getByTestId('dirty-mark')).toBeVisible()
  await page.getByTestId('revert').click()
})

test('원장과 홈도 그 시점까지만 보여 주고, 아무것도 없던 날은 빈 상태로 안내한다', async ({ page }) => {
  await connectAndLogin(page)
  await page.goto('/#/events?type=test_order')
  await expect(page.getByTestId('events-count')).toHaveText('8건')
  await page.getByTestId('event-row').first().click()
  await expect(page.getByTestId('event-rollback')).toBeVisible()
  await pickDate(page, '2026-03-01')
  await expect(page.getByTestId('events-count')).toHaveText('5건')
  await expect(page.getByTestId('event-rollback'), '그 시점을 보는 동안은 되돌리지 않는다').toHaveCount(0)
  await shot(page, '124-company-time-ledger')
  await page.goto('/#/')
  await expect(page.getByTestId('home-events')).not.toContainText('4월')

  await pickDate(page, '2020-01-01')
  await page.goto('/#/r/test_order')
  await expect(page.getByTestId('empty-state')).toContainText('이 시점에는 시험 주문이 없습니다')
  await expect(page.getByTestId('empty-state').getByRole('link')).toHaveCount(0)
  await shot(page, '125-company-time-empty')
})

test('시점 읽기가 실패하면 오류와 다시 시도를 보여 주고, 읽기 권한도 그대로 지킨다', async ({ page }) => {
  await connectAndLogin(page)
  await page.goto('/#/r/test_order')
  await failRpc(page, 'erp_records_at')
  await pickDate(page, '2026-03-01')
  const error = page.locator('.banner-error').filter({ hasText: '요청을 처리하지 못했습니다' })
  await expect(error).toBeVisible()
  await shot(page, '126-company-time-error')
  await expect(page.getByTestId('list-table'), '오늘의 줄을 그날의 것처럼 남겨 두지 않는다').toHaveCount(0)
  await restoreRpc(page, 'erp_records_at')
  await error.getByRole('button', { name: '다시 시도' }).click()
  await expect(page.getByTestId('list-count')).toHaveText('2건')

  await failRpc(page, 'erp_as_of')
  await page.goto(`/#/r/test_order/${spring}`)
  await expect(page.getByTestId('empty-state')).toContainText('그 시점의 모습을 읽지 못했습니다')
  await expect(page.locator('[data-field="note"]'), '오늘의 값을 그날의 것처럼 보여 주지 않는다').toHaveCount(0)
  await restoreRpc(page, 'erp_as_of')
  await page.getByTestId('time-retry').click()
  await expect(page.locator('[data-field="note"] .field-value')).toHaveText('2월 말 메모')
  await page.getByTestId('company-time-exit').click()
})

test('조회 역할도 과거를 볼 수 있지만, 볼 수 없는 유형은 과거에도 볼 수 없다', async ({ page }) => {
  const secret = await command(token, 'test_secret', null, 'create', { name: '급여 대장' })
  await connectAndLogin(page, VIEWER)
  await pickDate(page, '2026-03-01')
  await page.goto('/#/r/test_order')
  await expect(page.getByTestId('list-count')).toHaveText('2건')
  await expect(page.getByTestId('list-table').locator('tbody tr')).toHaveCount(2)
  await page.goto('/#/r/test_secret')
  await expect(page.locator('.banner-error').filter({ hasText: '이 유형을 볼 권한이 없습니다' })).toBeVisible()
  await expect(page.locator('body')).not.toContainText('급여 대장')
  await page.goto(`/#/r/test_secret/${secret.id}`)
  await expect(page.getByTestId('empty-state')).toContainText('이 문서를 찾을 수 없습니다')
})

test('휴대폰 폭과 어두운 테마에서도 시점 보기가 된다', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 720 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await connectAndLogin(page)
  await expect(page.getByTestId('time-view-date')).toBeVisible()
  await page.goto('/#/r/test_order')
  await expect(page.getByTestId('list-table')).toBeVisible()
  await pickDate(page, '2026-03-01')
  await expectFitsWidth(page, '[data-testid="company-time-banner"]')
  await expectFitsWidth(page, '.top')
  await expectDark(page, 'body')
  await expectDark(page, '.page-head h1')
  await shot(page, '127-company-time-mobile-dark')
  await page.goto(`/#/r/test_order/${spring}`)
  await expect(page.locator('[data-field="note"] .field-value')).toHaveText('2월 말 메모')
  await expectFitsWidth(page, '.field-grid')
  await shot(page, '128-company-time-form-mobile-dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await shot(page, '129-company-time-form-mobile')
})

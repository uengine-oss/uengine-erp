// Scenario S14's CRM at the speed of a person: menus are clicked, words are typed one key at a time, choices are clicked in the list
// that opens. The win goes through the real bus to the real sales module. Names are made up.
import { test, expect, shot, connectAndLogin, fieldInput } from '../lib/fixtures.mjs'
import { ADMIN, command, freshCompany, sql, tokenFor } from '../lib/stack.mjs'

test.describe.configure({ mode: 'serial' })

const SELLER = { name: '박영업', email: 'seller@example.com', password: 'seller-pass-1234' }
const VIEWER = { name: '조회만', email: 'viewer@example.com', password: 'viewer-pass-1234' }
const PHONE = '010-5555-9876'

const card = (page, id) => page.locator(`[data-testid="module-card"][data-id="${id}"]`)
const modelCard = (page, id) => page.locator(`[data-testid="model-card"][data-id="${id}"]`)
const column = (page, state) => page.locator(`.board-col[data-state="${state}"]`)
const pill = (page, text) => page.locator('.form-head .pill').filter({ hasText: new RegExp(`^${text}$`) }).first()

async function type(page, input, text) {
  await input.click()
  await input.pressSequentially(text, { delay: 15 })
}
async function menu(page, module, screen) {
  await page.locator(`[data-module="${module}"]`).click()
  if (screen) await page.locator(`[data-screen="${screen}"]`).click()
}
const press = (page, label) => page.getByRole('button', { name: label, exact: true }).click()
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())
const daysAgo = (n) => new Date(Date.parse(`${today()}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10)

async function typeDate(page, input, iso) {
  const [y, m, d] = iso.split('-')
  await input.blur()
  await input.focus()
  await page.keyboard.type(y, { delay: 15 })
  await page.keyboard.press('ArrowRight')
  await page.keyboard.type(m, { delay: 15 })
  await page.keyboard.type(d, { delay: 15 })
}

/** By the menu and the list, the way a person gets there. */
async function openDeal(page) {
  await menu(page, 'crm', 'opportunity')
  await page.getByTestId('list-row').first().click()
  await expect(page.getByTestId('form-title')).toContainText('OP')
}

let admin, dealId

test.beforeAll(async () => {
  await freshCompany({ modules: 'default' })
  admin = await tokenFor(ADMIN.email, ADMIN.password)
  await command(admin, 'member', null, 'create', { ...SELLER, roles: ['sales'] })
  await command(admin, 'member', null, 'create', { ...VIEWER, roles: ['viewer'] })
})

test('S14-0. CRM 을 켜기 전에는 메뉴에 없고 모델은 잠겨 있으며, 켜면 다른 모듈 없이 열린다', async ({ page }) => {
  await connectAndLogin(page)
  await expect(page.locator('[data-module="crm"]')).toHaveCount(0)
  await menu(page, 'analytics', '/analytics/models')
  await expect(modelCard(page, 'crm_conversion').getByTestId('model-state')).toHaveText('잠김')
  await expect(modelCard(page, 'crm_forecast').getByTestId('model-message')).toContainText('CRM 모듈을 켜면 열립니다')
  await menu(page, 'settings', '/settings/modules')
  await expect(card(page, 'crm').getByTestId('module-unlocks')).toContainText('단계별 전환율')
  await card(page, 'crm').getByTestId('module-enable').click()
  await expect(page.getByRole('dialog')).toContainText('판매를 나중에 켜면 그 뒤의 수주만 견적 초안이 됩니다')
  await page.getByTestId('dlg-confirm').click()
  await expect(card(page, 'crm').getByTestId('module-state')).toHaveText('켜짐')
  await expect(page.locator('[data-module="crm"]')).toBeVisible()
  await menu(page, 'analytics', '/analytics/models')
  await expect(modelCard(page, 'crm_forecast').getByTestId('model-state')).toHaveText('근거 부족')
  await expect(modelCard(page, 'crm_forecast').getByTestId('model-message')).toContainText('0~전체 범위로만')
})

test('S14-1. 박영업이 리드를 등록한다. 음수 금액은 칸을 짚어 막히고, 지난 활동일은 목록에 표시되며, 연락처는 원장 밖에 저장된다', async ({ page }) => {
  await connectAndLogin(page, SELLER)
  await menu(page, 'crm', 'opportunity')
  await page.getByTestId('new-record').click()
  await type(page, fieldInput(page, 'name'), '여름 제습기 납품')
  await type(page, fieldInput(page, 'company_name'), '한빛상사')
  await type(page, fieldInput(page, 'expected_amount'), '-5')
  await page.getByTestId('save').click()
  await expect(page.getByRole('alert').first()).toContainText('예상 금액 항목은 0 이상이어야 합니다')
  const amount = fieldInput(page, 'expected_amount')
  await amount.click()
  await amount.press('ControlOrMeta+a')
  await amount.pressSequentially('2500000', { delay: 15 })
  await type(page, fieldInput(page, 'next_activity'), '전화로 일정 잡기')
  await typeDate(page, fieldInput(page, 'next_activity_date'), daysAgo(2))
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-version')).toHaveText('v1')
  await expect(page.getByTestId('form-title')).toContainText('OP')
  dealId = page.url().split('/').pop()

  await expect(page.getByTestId('contact-note')).toContainText('원장 밖에 저장합니다')
  await type(page, fieldInput(page, 'contact-contact_name'), '김담당')
  await type(page, fieldInput(page, 'contact-phone'), PHONE)
  await page.getByTestId('contact-save').click()
  await expect(page.locator('.toast').filter({ hasText: '연락처를 저장했습니다' })).toBeVisible()
  expect((await sql(`select count(*)::int n from erp.events where data::text like $1`, [`%${PHONE}%`])).rows[0].n).toBe(0)
  await shot(page, 'crm-01-lead')

  await menu(page, 'crm', 'opportunity')
  await expect(page.getByTestId('list-row').first()).toContainText('활동 지남')
})

test('S14-2. 칸반으로 보고 단추 하나로 다음 단계로 옮긴다. 칸마다 건수와 금액이 맞는다', async ({ page }) => {
  await connectAndLogin(page, SELLER)
  await menu(page, 'crm', 'opportunity')
  await page.getByTestId('view-switch').getByRole('button', { name: '칸반' }).click()
  await expect(column(page, 'new').getByTestId('board-card')).toHaveCount(1)
  await expect(column(page, 'new')).toContainText('2,500,000')
  await expect(column(page, 'new').getByTestId('board-card')).toContainText('여름 제습기 납품')
  await expect(column(page, 'new').getByTestId('board-card')).toContainText('한빛상사')
  await column(page, 'new').getByTestId('board-move').click()
  await expect(column(page, 'talk').getByTestId('board-card')).toHaveCount(1)
  await expect(column(page, 'new').getByTestId('board-card')).toHaveCount(0)
  await column(page, 'talk').getByTestId('board-move').click()
  await expect(column(page, 'proposal').getByTestId('board-card')).toHaveCount(1)
  await shot(page, 'crm-02-board')
  // 수주와 실주는 물어볼 것이 있으므로 칸반에서 바로 하지 않는다.
  await column(page, 'proposal').getByTestId('board-move').click()
  await expect(column(page, 'negotiation').getByTestId('board-card')).toHaveCount(1)
  await expect(column(page, 'negotiation').getByTestId('board-move')).toHaveCount(0)
  await column(page, 'negotiation').getByTestId('board-card').click()
  await expect(page.getByTestId('form-title')).toContainText('OP')
  await expect(pill(page, '협상')).toBeVisible()
})

test('S14-3. 실주는 사유 없이 못 하고, 기타이면 내용을 적어야 하며, 다시 열면 신규로 돌아간다', async ({ page }) => {
  await connectAndLogin(page, SELLER)
  await openDeal(page)
  await press(page, '실주')
  let dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('사유는 전환율 분석에 쓰입니다')
  await dialog.getByLabel('실주 사유').selectOption('other')
  await page.getByTestId('dlg-confirm').click()
  await expect(page.getByRole('alert').first()).toContainText('사유가 기타이면 내용을 적어 주세요')
  await press(page, '실주')
  dialog = page.getByRole('dialog')
  await dialog.getByLabel('실주 사유').selectOption('price')
  await page.getByTestId('dlg-confirm').click()
  await expect(pill(page, '실주')).toBeVisible()
  await expect(page.locator('[data-field="lost_reason"]')).toContainText('가격')
  await expect(page.getByTestId('save')).toHaveCount(0)
  await press(page, '다시 열기')
  await expect(page.getByRole('dialog')).toContainText('신규 단계로 다시 엽니다')
  await page.getByTestId('dlg-confirm').click()
  await expect(pill(page, '신규')).toBeVisible()
  await expect(page.locator('[data-field="lost_reason"]')).toHaveCount(0)
})

test('S14-4. 수주하면 판매 모듈이 이벤트를 듣고 견적 초안을 만든다. CRM 화면에서 그 견적으로 간다', async ({ page }) => {
  await connectAndLogin(page, SELLER)
  await openDeal(page)
  await press(page, '수주')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('판매가 켜져 있으면 견적 초안이 생깁니다')
  await page.getByTestId('dlg-confirm').click()
  await expect(pill(page, '수주')).toBeVisible()
  await expect(page.getByTestId('opportunity-quote')).toHaveCount(1, { timeout: 20_000 })
  await shot(page, 'crm-03-won')
  await page.getByTestId('opportunity-quote').getByRole('link').click()
  await expect(page).toHaveURL(/\/r\/sales_order\//)
  await expect(page.locator('.form-head .pill').filter({ hasText: '견적' }).first()).toBeVisible()
  await expect(fieldInput(page, 'partner_id')).toHaveValue(/한빛상사/)
  await expect(page.locator('[data-field="lines"]').locator('input, textarea').first()).toHaveValue(/여름 제습기 납품.*2,500,000/)
  await shot(page, 'crm-03b-quote')
  const count = (await sql(`select count(*)::int n from erp.events where stream_id = $1 and event_type = 'SalesOrderConfirmed'`, [page.url().split('/').pop()])).rows[0].n
  expect(count, '주문은 사람이 확정한다').toBe(0)
})

test('S14-5. 다시 열면 보내지 않은 견적은 취소된다', async ({ page }) => {
  await connectAndLogin(page, SELLER)
  await openDeal(page)
  await press(page, '다시 열기')
  await page.getByTestId('dlg-confirm').click()
  await expect(pill(page, '신규')).toBeVisible()
  const quote = page.getByTestId('opportunity-quote')
  await expect(quote).toContainText('취소', { timeout: 20_000 })
})

test('S14-6. 조회 역할은 등록하지 못하고 연락처도 못 보며, 데이터베이스도 답하지 않는다', async ({ page }) => {
  await connectAndLogin(page, VIEWER)
  await menu(page, 'crm', 'opportunity')
  await expect(page.getByTestId('new-record')).toHaveCount(0)
  await page.getByTestId('list-row').first().click()
  await expect(page.getByTestId('form-title')).toContainText('OP')
  await expect(page.getByTestId('contact-note')).toHaveCount(0)
  await expect(page.getByTestId('contact-save')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '수주', exact: true })).toHaveCount(0)
  const viewer = await tokenFor(VIEWER.email, VIEWER.password)
  await expect(command(viewer, 'opportunity', dealId, 'stage_talk', {})).rejects.toThrow(/권한이 없습니다/)
})

test('S14-7. 끝난 건이 모자라면 범위로만 말하고, 20건이 되면 수치와 구간을 말한다. 재구매 후보에서 바로 영업 기회를 만든다', async ({ page }) => {
  await connectAndLogin(page, SELLER)
  await menu(page, 'crm', '/crm/analysis')
  await expect(page.getByTestId('crm-forecast-state')).toHaveText('근거 부족')
  await expect(page.getByTestId('crm-forecast-range')).toContainText('범위로만')
  await expect(page.getByTestId('crm-forecast-expected')).toHaveCount(0)
  await expect(page.getByTestId('crm-conversion-short')).toContainText('아직 믿을 만하지 않습니다')
  await shot(page, 'crm-04-range')

  // 끝난 거래 20건과 주문 이력을 쌓는다. 화면으로 다시 누를 일이 아니다.
  const seller = await tokenFor(SELLER.email, SELLER.password)
  for (let i = 0; i < 20; i++) {
    const o = await command(seller, 'opportunity', null, 'create', { name: `지난 거래 ${i}`, company_name: '회사', expected_amount: 100000 })
    await command(seller, 'opportunity', o.id, 'stage_negotiation', {})
    if (i % 2) await command(seller, 'opportunity', o.id, 'win', { make_quote: false })
    else await command(seller, 'opportunity', o.id, 'lose', { lost_reason: 'competitor' })
  }
  // 지난 날짜의 주문은 시계를 돌려 넣는다. 한 요청 안에서 시계와 사용자를 정하는 것은 로컬 스택에서만 할 수 있는 일이다.
  const owner = (await sql(`select user_id from erp.members where email = $1`, [ADMIN.email])).rows[0].user_id
  const past = async (ago, type, id, cmd, payload) => (await sql(
    `with c as materialized (select set_config('erp.clock', $1, true), set_config('request.jwt.claims', $2, true)) select public.erp_command($3, $4, $5, $6) r from c`,
    [`${daysAgo(ago)}T10:00:00+09:00`, JSON.stringify({ sub: owner, role: 'authenticated' }), type, id, cmd, JSON.stringify(payload)])).rows[0].r
  for (const name of ['단골 하나', '단골 둘', '단골 셋']) {
    const p = await command(admin, 'partner', null, 'create', { name, company_type: 'company' })
    for (const ago of [90, 60]) {
      const o = await past(ago, 'sales_order', null, 'create', { partner_id: p.id })
      await past(ago, 'sales_order', o.id, 'confirm', {})
    }
  }
  await page.reload()
  await expect(page.getByTestId('crm-forecast-state')).toHaveText('사용 가능')
  await expect(page.getByTestId('crm-forecast-expected')).toContainText('80% 구간')
  await expect(page.locator('[data-testid="crm-funnel-row"][data-stage="negotiation"]')).toContainText('50%')
  await expect(page.getByTestId('crm-lost-reasons')).toContainText('경쟁사 10건')
  await shot(page, 'crm-05-forecast')
  await expect(page.getByTestId('crm-repurchase-state')).toHaveText('사용 가능')
  await expect(page.getByTestId('crm-repurchase-row')).toHaveCount(3)
  const row = page.getByTestId('crm-repurchase-row').filter({ hasText: '단골 둘' })
  await expect(row).toContainText('30')
  await expect(row).toContainText('60일')
  await row.getByTestId('crm-repurchase-start').click()
  await expect(page).toHaveURL(/\/r\/opportunity\//)
  await expect(page.locator('[data-field="partner_id"]').locator('input').first()).toHaveValue(/단골 둘/)
  await menu(page, 'crm', '/crm/analysis')
  await expect(page.getByTestId('crm-repurchase-row')).toHaveCount(2)
})

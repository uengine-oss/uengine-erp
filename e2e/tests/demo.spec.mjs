// Starting with the made-up company, from the setup wizard. The story is the short one test/demo.test.mjs uses.
import { test, expect, shot, expectFitsWidth, fieldInput } from '../lib/fixtures.mjs'
import { ADMIN, API_URL, PUBLISHABLE_KEY, command, installScript, sql, tokenFor, waitForInstalled, wipe } from '../lib/stack.mjs'

test.describe.configure({ mode: 'serial' })

const STAGES = { inventory: '2023-11-11', purchase: '2023-11-21', invoicing: '2023-12-01', accounting: '2023-12-11', end: '2024-01-10' }
const APPLY = `${API_URL}/rest/v1/rpc/erp_demo_apply`

async function openCompanyStep(page) {
  await wipe()
  // The story's people sign in with addresses that scripts/reset-local.mjs does not know about.
  await sql(`delete from auth.users where email like '%@demo.example'`)
  await sql(installScript())
  await sql(`select erp.set_setup_code('demo-code')`)
  await waitForInstalled()
  await page.addInitScript((stages) => { localStorage.setItem('erp.demo.stages', stages) }, JSON.stringify(STAGES))
  await page.goto('/#/setup')
  await page.evaluate(([url, key]) => {
    localStorage.setItem('erp.connection', JSON.stringify({ url, key }))
    localStorage.setItem('erp.setup', JSON.stringify({ url, code: 'demo-code' }))
  }, [API_URL, PUBLISHABLE_KEY])
  await page.reload()
  await expect(page.getByRole('heading', { name: '회사 만들기' })).toBeVisible()
}

async function fillAdmin(page) {
  await page.getByLabel('관리자 이름').fill(ADMIN.name)
  await page.getByLabel('관리자 이메일').fill(ADMIN.email)
  await page.getByLabel(/^비밀번호/).first().fill(ADMIN.password)
  await page.getByLabel('비밀번호 확인').fill(ADMIN.password)
}

const failOnce = (page, predicate, body) => {
  let done = false
  return page.route(APPLY, (route) => {
    if (!done && predicate(route.request().postDataJSON())) {
      done = true
      return route.fulfill({ status: 500, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) })
    }
    return route.fallback()
  })
}

test('회사를 만들기 전에 가상 회사를 고르면 용량을 알리고, 고르지 않으면 데모 코드를 받지 않는다', async ({ page }) => {
  const scripts = []
  page.on('request', (r) => { if (r.url().endsWith('.js')) scripts.push(r.url()) })
  await openCompanyStep(page)
  await expect(page.getByTestId('start-real')).toBeChecked()
  await expect(page.getByTestId('demo-cost')).toHaveCount(0)
  await page.waitForTimeout(200)
  const before = scripts.length
  await expect(page.getByLabel('회사명')).toBeVisible()
  await shot(page, '200-setup-start-with')

  await page.getByTestId('start-demo').check()
  await expect(page.getByTestId('demo-cost')).toContainText('약 250 MB')
  await expect(page.getByLabel('회사명'), '가상 회사의 이름은 정해져 있다').toHaveCount(0)
  await shot(page, '201-setup-demo-chosen')
  expect(scripts.length, '고르기만 해서는 데모 코드를 받지 않는다').toBe(before)
})

test('가상 회사를 만들면 묶음으로 보내며 진행을 보여 주고, 오류와 시간 제한을 스스로 넘긴다', async ({ page }) => {
  test.setTimeout(180_000)
  const sizes = []
  await openCompanyStep(page)
  await page.route(APPLY, (route) => { sizes.push(route.request().postDataJSON().p_steps.length); return route.fallback() })
  // A statement the time limit cut off, and the debugging extension's random failure. Neither did anything.
  await failOnce(page, (b) => b.p_steps.length > 100 && sizes.length === 2, { code: '57014', message: 'canceling statement due to statement timeout' })
  await failOnce(page, () => sizes.length === 1, { code: 'XX000', message: 'cannot find parent statement on pldbgapi2' })
  await page.getByTestId('start-demo').check()
  await fillAdmin(page)
  await page.getByTestId('company-create').click()
  await expect(page).toHaveURL(/demo-build/)
  await expect(page.getByTestId('demo-progress')).toBeVisible()
  await expect(page.getByTestId('demo-day')).toContainText(/\d{4}-\d{2}-\d{2} 까지 만들었습니다/, { timeout: 60_000 })
  await shot(page, '202-demo-building')
  await expect(page.getByTestId('home-title')).toHaveText('홈', { timeout: 150_000 })

  expect(sizes[0], '보통 약 300개씩 보낸다').toBeLessThanOrEqual(310)
  expect(sizes[1], '같은 묶음을 다시 보낸다').toBe(sizes[0])
  const cut = sizes.findIndex((n, i) => i > 1 && n <= Math.ceil(sizes[2] / 2) && sizes[i - 1] === sizes[2])
  expect(cut, `시간 제한에 걸린 묶음은 반으로 나눈다: ${sizes.slice(0, 6)}`).toBeGreaterThan(0)

  await expect(page.getByTestId('company-name')).toHaveText('가온가전(데모)')
  await expect(page.getByTestId('demo-mark')).toHaveText('가상 회사입니다')
  await shot(page, '203-demo-home')
  await page.goto('/#/settings/modules')
  for (const id of ['sales', 'inventory', 'purchase', 'invoicing', 'accounting']) await expect(page.locator(`[data-testid="module-card"][data-id="${id}"]`).getByTestId('module-state')).toHaveText('켜짐')
  expect((await sql(`select count(*)::int as n from erp.meta where key in ('demo_open', 'bus_paused')`)).rows[0].n, '끝나면 전달이 다시 돈다').toBe(0)
  expect((await sql(`select min(occurred_at) as t from erp.events`)).rows[0].t.toISOString().slice(0, 7), '회사는 이야기의 첫날부터 있었다').toBe('2023-10')
  await page.goto('/#/r/sales_order')
  await expect(page.getByTestId('list-table').locator('tbody tr').first()).toBeVisible()
  await shot(page, '204-demo-orders')
  await page.goto('/#/accounting/trial-balance')
  await page.getByTestId('books-from').fill('')
  await page.getByTestId('books-to').fill('')
  await expect(page.getByTestId('trial-balanced')).toHaveText('차변과 대변이 맞습니다.')
  await page.goto('/#/analytics/models')
  await expect(page.locator('[data-testid="model-card"][data-id="stat_sales"]').getByTestId('model-state')).toHaveText('사용 가능')
})

test('고칠 수 없는 오류는 보여 주고 다시 시도할 수 있으며, 탭을 닫았다 와도 이어서 만든다', async ({ page }) => {
  test.setTimeout(180_000)
  await openCompanyStep(page)
  let applied = 0
  await page.route(APPLY, async (route) => {
    applied++
    if (applied === 2) {
      return route.fulfill({ status: 500, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ code: 'XX001', message: '시험용 고장' }) })
    }
    return route.fallback()
  })
  await page.getByTestId('start-demo').check()
  await fillAdmin(page)
  await page.getByTestId('company-create').click()
  await expect(page.getByTestId('demo-error')).toContainText('요청을 처리하지 못했습니다', { timeout: 60_000 })
  await shot(page, '205-demo-error')
  const firstBatch = (await sql(`select count(*)::int as n from erp.events where source = 'demo'`)).rows[0].n
  expect(firstBatch, '앞 묶음은 이미 들어갔다').toBeGreaterThan(0)
  const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('erp.demo.progress')))
  expect(saved.applied).toBeGreaterThan(0)

  // The answer to the next batch is lost after it landed. Sending it again would stop the build on its own documents.
  await page.route(APPLY, async (route) => {
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    await route.abort('connectionfailed')
  }, { times: 1 })
  await page.getByTestId('demo-retry').click()
  await expect.poll(async () => JSON.parse(await page.evaluate(() => localStorage.getItem('erp.demo.progress'))).applied, { timeout: 30_000 }).toBeGreaterThan(saved.applied)

  // The tab goes away here. Coming back, an unfinished company says so, and picks up after what it already sent.
  await page.reload()
  await expect(page.getByTestId('demo-day')).toContainText('까지 만들었습니다', { timeout: 60_000 })
  await page.getByTestId('demo-progress').waitFor()
  await expect(page.getByTestId('home-title')).toHaveText('홈', { timeout: 150_000 })
  expect((await sql(`select count(*)::int as n from erp.quants where qty < 0`)).rows[0].n).toBe(0)
  expect(await page.evaluate(() => localStorage.getItem('erp.demo.progress')), '끝나면 지운다').toBeNull()
  await expect(page.getByTestId('demo-mark')).toBeVisible()
})

test('중간에 멈춘 회사는 관리자에게 알리고, 여기까지만 만들고 둘러볼 수 있다', async ({ page }) => {
  test.setTimeout(180_000)
  await openCompanyStep(page)
  let applied = 0
  await page.route(APPLY, async (route) => {
    applied++
    if (applied >= 2) return route.fulfill({ status: 500, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ code: 'XX001', message: '시험용 고장' }) })
    return route.fallback()
  })
  await page.getByTestId('start-demo').check()
  await fillAdmin(page)
  await page.getByTestId('company-create').click()
  await expect(page.getByTestId('demo-error')).toBeVisible({ timeout: 60_000 })

  await page.goto('/#/')
  await expect(page.getByTestId('demo-unfinished')).toContainText('가상 회사를 만들다 멈췄습니다')
  await expect(page.locator('nav.side').getByRole('link', { name: '재고', exact: true }), '이야기가 켠 모듈이 메뉴에 나온다').toBeVisible()
  await expectFitsWidth(page, '[data-testid="demo-unfinished"]')
  await shot(page, '206-demo-unfinished')
  await page.getByTestId('demo-resume').click()
  await expect(page.getByTestId('demo-error')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('demo-stop').click()
  await expect(page.getByTestId('home-title')).toHaveText('홈', { timeout: 30_000 })
  await expect(page.getByTestId('demo-unfinished')).toHaveCount(0)
  await expect(page.getByTestId('demo-mark')).toBeVisible()
  expect((await sql(`select count(*)::int as n from erp.meta where key = 'bus_paused'`)).rows[0].n).toBe(0)
})

test('실제 회사로 시작하면 가상 회사 표시도 데모 코드도 없고, 일반 쓰기는 같은 오류를 한 번 스스로 넘긴다', async ({ page }) => {
  await wipe()
  await sql(installScript())
  await sql(`select erp.set_setup_code('demo-code')`)
  await waitForInstalled()
  const scripts = []
  page.on('request', (r) => { if (r.url().endsWith('.js')) scripts.push(r.url()) })
  await page.goto('/#/setup')
  await page.evaluate(([url, key]) => {
    localStorage.setItem('erp.connection', JSON.stringify({ url, key }))
    localStorage.setItem('erp.setup', JSON.stringify({ url, code: 'demo-code' }))
  }, [API_URL, PUBLISHABLE_KEY])
  await page.reload()
  await page.getByLabel('회사명').fill('실제 회사')
  await fillAdmin(page)
  await page.getByTestId('company-create').click()
  await expect(page.getByTestId('home-title')).toHaveText('홈')
  await expect(page.getByTestId('demo-mark')).toHaveCount(0)
  await expect(page.getByTestId('demo-unfinished')).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('home-title')).toHaveText('홈')
  // An address typed by hand does not turn a real company into a demo.
  await page.goto('/#/demo-build')
  await expect(page.getByTestId('home-title')).toHaveText('홈')
  expect((await sql(`select count(*)::int as n from erp.meta where key in ('demo', 'demo_open')`)).rows[0].n).toBe(0)
  expect(scripts.filter((u) => /generate|world|build-/.test(u)), '데모 코드는 받지 않는다').toEqual([])

  let calls = 0
  await page.route(`${API_URL}/rest/v1/rpc/erp_command`, (route) => {
    calls++
    if (calls === 1) return route.fulfill({ status: 500, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ code: 'XX000', message: 'cannot find parent statement on pldbgapi2' }) })
    return route.fallback()
  })
  await page.goto('/#/r/partner/new')
  await fieldInput(page, 'name').fill('한 번 실패해도 저장되는 거래처')
  await page.getByTestId('save').click()
  await expect(page).toHaveURL(/partner\/[0-9a-f-]{36}/)
  await expect(page.getByTestId('form-error')).toHaveCount(0)
  expect(calls).toBe(2)
  const token = await tokenFor(ADMIN.email, ADMIN.password)
  await expect(command(token, 'picking', null, 'create', {})).rejects.toThrow(/ERP_MODULE_OFF/)
})

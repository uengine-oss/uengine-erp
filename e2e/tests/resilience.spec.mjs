// What happens when things go wrong: paused project, old schema, dropped realtime, invite links.
import { test, expect, shot, connectAndLogin, watchPage, login, fieldInput } from '../lib/fixtures.mjs'
import { ADMIN, ANON_KEY, API_URL, COMPANY, command, freshCompany, inviteHash, installScript, PUBLISHABLE_KEY, sql, tokenFor, waitForInstalled, wipe } from '../lib/stack.mjs'
import { installTestTypes } from '../lib/test-types.mjs'

test.describe.configure({ mode: 'serial' })
const apiPattern = `${API_URL}/**`

test.beforeAll(async () => {
  await freshCompany()
  await installTestTypes()
})

test('프로젝트가 일시 중지되면 재시도와 재개 안내를 보여 주고, 살아나면 돌아온다', async ({ page }) => {
  await connectAndLogin(page)
  await page.route(apiPattern, (route) => route.abort('connectionfailed'))
  await page.goto('/#/events')
  await page.reload()
  await expect(page).toHaveURL(/#\/offline/)
  await expect(page.getByTestId('connection-problem')).toContainText('7일 동안 활동이 없으면 일시 중지')
  await expect(page.getByRole('link', { name: '대시보드 열기' })).toHaveAttribute('href', /supabase\.com\/dashboard/)
  await shot(page, '40-offline')
  await page.getByTestId('retry').click()
  await expect(page).toHaveURL(/#\/offline/)
  await page.unroute(apiPattern)
  await page.getByTestId('retry').click()
  await expect(page).toHaveURL(/#\/events/)
  await expect(page.getByTestId('events-table')).toBeVisible()
})

test('일시 중지 응답(540)도 같은 안내로 처리한다', async ({ page }) => {
  await connectAndLogin(page)
  await page.route(apiPattern, (route) => route.fulfill({ status: 540, body: 'paused', headers: { 'access-control-allow-origin': '*' } }))
  await page.reload()
  await expect(page).toHaveURL(/#\/offline/)
  await page.unroute(apiPattern)
})

test('쓰는 중에 연결이 끊겨도 입력은 그대로 있고, 재시도할 수 있다', async ({ page }) => {
  await connectAndLogin(page)
  await page.goto('/#/r/test_customer/new')
  await fieldInput(page, 'name').fill('연결 끊긴 동안 입력한 고객')
  await page.route(`${API_URL}/rest/**`, (route) => route.abort('connectionfailed'))
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-error')).toContainText('연결할 수 없습니다')
  await expect(page.getByTestId('net-banner')).toBeVisible()
  await shot(page, '41-net-banner')
  await expect(fieldInput(page, 'name')).toHaveValue('연결 끊긴 동안 입력한 고객')
  await page.unroute(`${API_URL}/rest/**`)
  await page.getByTestId('net-banner').getByRole('button', { name: '다시 시도' }).click()
  await expect(page.getByTestId('net-banner')).toHaveCount(0)
  await page.getByTestId('save').click()
  await expect(page).toHaveURL(/test_customer\/[0-9a-f-]{36}/)
})

test('DB 스키마가 앱보다 낮으면 업그레이드를 안내하고, 같은 SQL 을 다시 돌리면 데이터는 그대로다', async ({ page }) => {
  const token = await tokenFor(ADMIN.email, ADMIN.password)
  const made = await command(token, 'test_customer', null, 'create', { name: '업그레이드 전에 만든 고객', code: 'KEEP-1' })
  const before = (await sql('select count(*)::int as n from erp.events')).rows[0].n
  await sql(`update erp.meta set value = '"0.0.1"' where key = 'schema_version'`)

  await connectAndLogin(page)
  const banner = page.getByTestId('upgrade-banner')
  await expect(banner).toContainText('이전 버전')
  await expect(banner).toContainText('데이터는 그대로 보존')
  await shot(page, '42-upgrade')

  await banner.getByRole('button', { name: 'SQL 복사' }).click()
  await expect(page.locator('.toast').filter({ hasText: '복사했습니다' })).toBeVisible()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied).toContain('schema_version')
  expect(copied, '업그레이드 SQL 에는 설치 코드가 없다').not.toContain('set_setup_code(\'')
  await sql(copied)
  await banner.getByRole('button', { name: '다시 확인' }).click()
  await expect(banner).toHaveCount(0)

  expect((await sql('select count(*)::int as n from erp.events')).rows[0].n).toBe(before)
  await page.goto(`/#/r/test_customer/${made.id}`)
  await expect(page.getByTestId('form-title')).toHaveText('업그레이드 전에 만든 고객')
})

test('초대 링크는 주소를 확인시키고 접속 정보를 넘긴다 (예전 anon 키도 허용)', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:5301', viewport: { width: 1280, height: 720 }, locale: 'ko-KR' })
  const page = await context.newPage()
  const problems = []
  watchPage(page, problems)
  await page.goto(`/${inviteHash(ANON_KEY)}`)
  await expect(page.getByTestId('connect-host')).toHaveText(new URL(API_URL).host)
  await shot(page, '43-connect')
  expect(await page.evaluate(() => localStorage.getItem('erp.connection')), '누르기 전에는 저장하지 않는다').toBeNull()
  await page.getByTestId('connect-accept').click()
  await expect(page.getByTestId('login-project')).toBeVisible()
  await expect(page.locator('body')).not.toContainText(COMPANY)
  await login(page)
  expect(problems).toEqual([])
  await context.close()
})

test('비밀 키가 든 초대 링크는 거부하고 주소에서 지운다', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:5301', locale: 'ko-KR' })
  const page = await context.newPage()
  const secret = `sb_${'secret'}_not_a_real_key`
  await page.goto(`/#/connect?u=${encodeURIComponent(API_URL)}&k=${secret}`)
  await expect(page.getByTestId('connect-error')).toHaveText('이 키는 공개하면 안 되는 키입니다. Publishable(공개) 키를 넣으세요')
  expect(page.url()).not.toContain(secret)
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(secret)
  await context.close()
})

test('실시간: 다른 사람이 만든 문서가 내 목록과 원장에 바로 나타난다', async ({ page }) => {
  await connectAndLogin(page)
  await expect(page.getByTestId('live')).toHaveText('실시간', { timeout: 20_000 })
  await page.goto('/#/r/test_item')
  await expect(page.getByTestId('list-count')).toHaveText('3건')
  const token = await tokenFor(ADMIN.email, ADMIN.password)
  await command(token, 'test_item', null, 'create', { name: '실시간으로 들어온 품목', price: 1000 })
  await expect(page.getByTestId('list-count')).toHaveText('4건')
  await expect(page.getByTestId('list-table')).toContainText('실시간으로 들어온 품목')
  await page.goto('/#/events')
  await command(token, 'test_item', null, 'create', { name: '원장에 바로 뜨는 품목', price: 2000 })
  await expect(page.getByTestId('event-row').first()).toContainText('원장에 바로 뜨는 품목')
})

test('실시간 연결이 막혀도 앱은 그대로 돌아간다', async ({ page }) => {
  await page.routeWebSocket(/realtime/, (ws) => ws.close())
  await connectAndLogin(page)
  await page.goto('/#/r/test_item')
  await expect(page.getByTestId('list-table')).toBeVisible()
  await expect(page.getByTestId('live')).not.toHaveText('실시간', { timeout: 15_000 })
  await page.goto('/#/r/test_customer/new')
  await fieldInput(page, 'name').fill('실시간 없이 저장')
  await page.getByTestId('save').click()
  await expect(page).toHaveURL(/test_customer\/[0-9a-f-]{36}/)
})

test('다른 브라우저에서 설치했으면 설치 코드를 다시 발급한다', async ({ browser }) => {
  await wipe()
  await sql(installScript())
  await waitForInstalled()
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:5301', viewport: { width: 1280, height: 720 }, locale: 'ko-KR', permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await context.newPage()
  await page.goto('/#/setup')
  await page.getByLabel('Project URL').fill(API_URL)
  await page.getByLabel('Publishable 키').fill(PUBLISHABLE_KEY)
  await page.getByTestId('connect-next').click()
  await expect(page.getByTestId('reissue-code')).toBeVisible()
  await shot(page, '45-setup-reissue')
  const line = await page.getByTestId('reissue-code').locator('code').textContent()
  await page.getByLabel('회사명').fill(COMPANY)
  await page.getByLabel('관리자 이름').fill(ADMIN.name)
  await page.getByLabel('관리자 이메일').fill(ADMIN.email)
  await page.getByLabel(/^비밀번호/).first().fill(ADMIN.password)
  await page.getByLabel('비밀번호 확인').fill(ADMIN.password)
  await page.getByTestId('company-create').click()
  await expect(page.getByTestId('company-error')).toContainText('설치 코드가 맞지 않습니다')
  const fresh = await page.getByTestId('reissue-code').locator('code').textContent()
  expect(fresh).not.toBe(line)
  await sql(fresh)
  await page.getByTestId('company-create').click()
  await expect(page.getByTestId('home-title')).toHaveText('홈')
  await context.close()
})

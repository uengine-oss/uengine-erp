// Long-lived keys and the addresses to use them with, through the screen and then over real HTTP.
import { test, expect, shot, connectAndLogin, expectDark, expectFitsWidth, failRpc, restoreRpc } from '../lib/fixtures.mjs'
import { ADMIN, ANON_KEY, API_URL, command, freshCompany, sql, tokenFor } from '../lib/stack.mjs'

test.describe.configure({ mode: 'serial' })

const CLERK = { name: '정회계', email: 'clerk@example.com', password: 'clerk-pass-1234' }
const SALES = { name: '박영업', email: 'sales@example.com', password: 'sales-pass-1234' }
let key

const mcp = (extra, body = { jsonrpc: '2.0', id: 1, method: 'tools/list' }) => fetch(`${API_URL}/rest/v1/rpc/erp_mcp`, {
  method: 'POST', headers: { apikey: ANON_KEY, 'Content-Type': 'application/json', Authorization: `Bearer ${ANON_KEY}`, ...extra }, body: JSON.stringify(body),
})

test.beforeAll(async () => {
  await freshCompany({ modules: 'default' })
  const admin = await tokenFor(ADMIN.email, ADMIN.password)
  await command(admin, 'member', null, 'create', { ...CLERK, roles: ['accounting'] })
  await command(admin, 'member', null, 'create', { ...SALES, roles: ['sales'] })
})

test('연동 키가 없으면 안내하고, 주소와 헤더, REST 자원을 보여 준다', async ({ page }) => {
  await connectAndLogin(page)
  await page.locator('[data-module="settings"]').click()
  await page.locator('[data-screen="/settings/integration"]').click()
  await expect(page.getByTestId('keys-empty')).toContainText('아직 만든 키가 없습니다')
  await expect(page.getByTestId('mcp-url')).toHaveText(`${API_URL}/rest/v1/rpc/erp_mcp`)
  await expect(page.getByTestId('mcp-example')).toContainText('x-erp-key:')
  await expect(page.getByTestId('mcp-example')).toContainText('apikey:')
  await expect(page.getByTestId('rest-example')).toContainText('/rest/v1/erp_api_partner')
  await page.getByTestId('rest-guide').locator('summary').click()
  await expect(page.getByTestId('rest-resources')).toContainText('/rest/v1/erp_api_sales_order')
  await expect(page.getByTestId('rest-resources'), '꺼진 모듈의 자원은 없다').not.toContainText('erp_api_picking')
  await shot(page, '191-integration-empty')
})

test('키를 만들면 한 번만 보여 주고, 고른 구성원의 권한으로 동작하며, 폐기하면 끊긴다', async ({ page }) => {
  await connectAndLogin(page)
  await page.goto('/#/settings/integration')
  await page.getByTestId('key-create').click()
  const dialog = page.getByRole('dialog')
  await page.getByTestId('dlg-confirm').click()
  await expect(dialog).toContainText('이름과 구성원을 모두 고르세요')
  await dialog.getByLabel('이름').fill('회계 에이전트')
  const select = dialog.getByLabel('이 구성원의 권한으로 동작')
  await expect(select.locator('option')).toHaveCount(4)
  await select.selectOption({ label: `${CLERK.name} (${CLERK.email})` })
  await shot(page, '192-integration-create')
  await page.getByTestId('dlg-confirm').click()

  const once = page.getByTestId('key-once')
  await expect(once).toContainText('한 번만 보여 줍니다')
  await expect(once).toContainText(CLERK.name)
  key = await page.getByTestId('key-value').inputValue()
  expect(key).toMatch(/^erpk_[0-9a-f]{48}$/)
  await expect(page.getByTestId('mcp-example'), '예시에 바로 쓸 수 있게 들어간다').toContainText(key)
  await page.getByTestId('key-copy').click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(key)
  await shot(page, '193-integration-once')

  const row = page.locator('[data-testid="key-row"][data-label="회계 에이전트"]')
  await expect(row).toContainText(CLERK.name)
  await expect(row).toContainText(key.slice(0, 11))
  await expect(row, '표에는 앞자리만').not.toContainText(key)
  await expect(row.getByTestId('key-state')).toHaveText('사용 중')
  expect((await sql('select count(*)::int as n from erp.events where data::text like $1', [`%${key}%`])).rows[0].n, '키는 원장에 남지 않는다').toBe(0)

  // Leaving and coming back: the key is gone from the screen for good.
  await page.goto('/#/settings/usage')
  await page.goto('/#/settings/integration')
  await expect(page.getByTestId('key-once')).toHaveCount(0)
  await expect(page.locator('[data-testid="key-row"][data-label="회계 에이전트"]')).toBeVisible()
  await expect(page.locator('body')).not.toContainText(key)

  const ok = await mcp({ 'x-erp-key': key })
  expect(ok.status).toBe(200)
  expect((await ok.json()).result.tools.map((t) => t.name)).toEqual(['erp_read', 'erp_create', 'erp_update', 'erp_delete'])
  await page.reload()
  await expect(page.locator('[data-testid="key-row"][data-label="회계 에이전트"]')).not.toContainText('아직 없음')

  await page.locator('[data-testid="key-row"][data-label="회계 에이전트"]').getByTestId('key-revoke').click()
  await expect(page.getByRole('dialog')).toContainText('바로 접속할 수 없게 됩니다')
  await page.getByTestId('dlg-confirm').click()
  await expect(page.locator('[data-testid="key-row"][data-label="회계 에이전트"]').getByTestId('key-state')).toHaveText('폐기됨')
  await expect(page.locator('[data-testid="key-row"][data-label="회계 에이전트"]').getByTestId('key-revoke')).toHaveCount(0)
  await shot(page, '194-integration-revoked')
  const refused = await mcp({ 'x-erp-key': key })
  const body = await refused.json().catch(() => ({}))
  expect(refused.status === 200 ? !!body.error : true, '폐기한 키는 쓸 수 없다').toBe(true)
})

test('비관리자에게는 메뉴가 없고, 목록을 읽지 못하면 오류를 보여 주며, 휴대폰과 어두운 테마에서도 읽힌다', async ({ page }) => {
  await connectAndLogin(page, SALES)
  await page.locator('[data-module="settings"]').click()
  await expect(page.locator('[data-screen="/settings/integration"]')).toHaveCount(0)
  await page.goto('/#/settings/integration')
  await expect(page.getByTestId('empty-state')).toContainText('관리자만 볼 수 있습니다')
  await expect(page.getByTestId('key-create')).toHaveCount(0)
  await page.getByTestId('logout').click()
  await page.getByLabel('이메일').fill(ADMIN.email)
  await page.getByLabel('비밀번호').fill(ADMIN.password)
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('user')).toContainText(ADMIN.name)

  await failRpc(page, 'erp_api_keys')
  await page.goto('/#/settings/usage')
  await page.goto('/#/settings/integration')
  await expect(page.getByTestId('keys-error')).toContainText('요청을 처리하지 못했습니다')
  await restoreRpc(page, 'erp_api_keys')
  await page.getByTestId('keys-retry').click()
  await expect(page.getByTestId('keys-table')).toBeVisible()

  await page.setViewportSize({ width: 375, height: 720 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expectFitsWidth(page, '[data-testid="mcp-example"]')
  await expectFitsWidth(page, '[data-testid="rest-example"]')
  await expectDark(page, '[data-testid="mcp-example"]')
  await shot(page, '195-integration-mobile-dark')
})

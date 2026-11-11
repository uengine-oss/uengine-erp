// Scenario S25's quality at the speed of a person. A purchase is confirmed through the API, as the buyer would elsewhere; the receipt
// it leads to comes through the real bus to the real stock module, and the check through the bus again to quality. Names are made up.
import { test, expect, shot, connectAndLogin, fieldInput } from '../lib/fixtures.mjs'
import { ADMIN, command, freshCompany, rest, sql, tokenFor, waitFor } from '../lib/stack.mjs'

test.describe.configure({ mode: 'serial' })

const QA = { name: '최품질', email: 'qa@example.com', password: 'qa-pass-1234' }
const STOCK = { name: '이재고', email: 'stock@example.com', password: 'stock-pass-1234' }
const VENDOR = '한빛볼트'
const BOLT = '볼트 M10'

const card = (page, id) => page.locator(`[data-testid="module-card"][data-id="${id}"]`)
const modelCard = (page, id) => page.locator(`[data-testid="model-card"][data-id="${id}"]`)
const rows = (page) => page.getByTestId('list-row')
const stage = (page) => page.locator('.pipeline li.on')
const value = (page, field) => page.locator(`[data-field="${field}"] .field-value`)

async function type(input, text) {
  await input.click()
  await input.pressSequentially(text, { delay: 15 })
}
async function choose(page, input, text) {
  await input.click()
  await input.pressSequentially(text, { delay: 15 })
  const option = page.locator('.combo-menu').getByRole('option', { name: new RegExp(text) }).first()
  await option.waitFor()
  await option.click()
  await expect(input).toHaveValue(new RegExp(text))
}
async function menu(page, module, screen) {
  await page.locator(`[data-module="${module}"]`).click()
  if (screen) await page.locator(`[data-screen="${screen}"]`).click()
}
const tick = (token) => rest('erp_bus_tick', { p_budget_ms: 3000 }, token)
const checksFor = async (picking) => (await sql(`select id, status from erp.records where type = 'quality_check' and state ->> 'picking_id' = $1`, [picking])).rows

let admin, ids

/** A purchase confirmed elsewhere. Returns the receipt once stock has made it and quality has heard it. */
async function receipt(qty) {
  const po = await command(admin, 'purchase_order', null, 'create', { partner_id: ids.vendor, lines: [{ variant_id: ids.bolt, qty, unit_price: 120 }] })
  await command(admin, 'purchase_order', po.id, 'confirm')
  let picking
  await waitFor(async () => {
    await tick(admin)
    picking = (await sql(`select id from erp.records where type = 'picking' and state ->> 'origin_id' = $1`, [po.id])).rows[0]?.id
    return picking && (await checksFor(picking)).length === 1
  }, '입고 전표와 품질 검사', 120)
  return picking
}

test.beforeAll(async () => {
  await freshCompany({ modules: 'default' })
  admin = await tokenFor(ADMIN.email, ADMIN.password)
  await command(admin, 'module', null, 'enable', { id: 'inventory' })
  await command(admin, 'module', null, 'enable', { id: 'purchase' })
  await command(admin, 'member', null, 'create', { ...QA, roles: ['quality'] })
  await command(admin, 'member', null, 'create', { ...STOCK, roles: ['inventory'] })
  ids = {
    vendor: (await command(admin, 'partner', null, 'create', { name: VENDOR, company_type: 'company' })).id,
    bolt: (await command(admin, 'product', null, 'create', { name: BOLT, standard_price: 120 })).state.variants[0].id,
  }
})

test('S25-6. 품질을 켜기 전에는 메뉴에 없고 모델은 잠겨 있으며, 켤 때 검사가 아무것도 막지 않는다고 말한다', async ({ page }) => {
  await connectAndLogin(page)
  await expect(page.locator('[data-module="quality"]')).toHaveCount(0)
  await menu(page, 'analytics', '/analytics/models')
  await expect(modelCard(page, 'quality_defects').getByTestId('model-state')).toHaveText('잠김')
  await expect(modelCard(page, 'quality_defects').getByTestId('model-message')).toContainText('품질 모듈을 켜면 열립니다')
  await menu(page, 'settings', '/settings/modules')
  await card(page, 'quality').getByTestId('module-enable').click()
  await expect(page.getByRole('dialog')).toContainText('검사는 아무것도 막지 않습니다')
  await page.getByTestId('dlg-confirm').click()
  await expect(card(page, 'quality').getByTestId('module-state')).toHaveText('켜짐')
  await expect(page.locator('[data-module="quality"]')).toBeVisible()
  await shot(page, 'quality-01-on')
})

test('S25-7. 최품질이 볼트 길이를 입고 때마다 재는 검사 기준을 만든다. 하한이 상한보다 크면 막힌다', async ({ page }) => {
  await connectAndLogin(page, QA)
  await menu(page, 'quality', 'quality_point')
  await page.getByTestId('new-record').click()
  await type(fieldInput(page, 'name'), '볼트 길이')
  await choose(page, fieldInput(page, 'product_id'), BOLT)
  await fieldInput(page, 'check_type').selectOption('measure')
  await type(fieldInput(page, 'norm_min'), '50.2')
  await type(fieldInput(page, 'norm_max'), '49.8')
  await type(fieldInput(page, 'unit'), 'mm')
  await page.getByTestId('save').click()
  await expect(page.getByRole('alert').first()).toContainText('하한은 상한보다 클 수 없습니다')
  for (const [f, v] of [['norm_min', '49.8'], ['norm_max', '50.2']]) {
    const input = fieldInput(page, f)
    await input.click()
    await input.press('ControlOrMeta+a')
    await input.pressSequentially(v, { delay: 15 })
  }
  await page.getByTestId('save').click()
  await expect(page.getByTestId('form-title')).toContainText('볼트 길이')
  await expect(page.getByTestId('form-version')).toHaveText('v1')
  await shot(page, 'quality-02-point')
})

test('S25-8. 입고가 준비되면 측정 검사가 저절로 생기고, 이재고가 잰 값이 기준을 벗어나면 불합격과 불량 경보가 생긴다. 입고는 막히지 않는다', async ({ page }) => {
  // An earlier delivery from the same supplier that was fine.
  const first = await receipt(200)
  const [ok] = await checksFor(first)
  await command(admin, 'quality_check', ok.id, 'measure', { measured_value: 50.05 })

  ids.picking = await receipt(500)
  await connectAndLogin(page, STOCK)
  await menu(page, 'quality', 'quality_check')
  await rows(page).filter({ hasText: '검사 대기' }).first().click()
  await expect(page.getByTestId('form-title')).toContainText('QC')
  await expect(value(page, 'partner_id')).toHaveText(VENDOR)
  await expect(page.getByTestId('tr-pass'), '측정 검사는 값을 적고 기준이 판정한다').toHaveCount(0)
  await page.getByTestId('tr-measure').click()
  const dialog = page.getByRole('dialog')
  await type(dialog.getByLabel('측정값'), '50.6')
  await type(dialog.getByLabel('메모'), '다섯 개 중 두 개가 김')
  await page.getByTestId('dlg-confirm').click()
  await expect(stage(page)).toHaveText('불합격')
  await expect(value(page, 'measured_value')).toHaveText('50.6')
  await expect(value(page, 'alert_id')).toContainText('QA')
  await shot(page, 'quality-03-failed')
  expect((await sql(`select status from erp.records where id = $1`, [ids.picking])).rows[0].status, '재고는 검사를 모른다').toBe('ready')
  await command(admin, 'picking', ids.picking, 'validate', {})
  expect((await sql(`select status from erp.records where id = $1`, [ids.picking])).rows[0].status).toBe('done')
})

test('S25-9. 최품질이 불량 경보의 조치를 시작하고, 원인과 시정 조치를 적어야 해결로 닫는다', async ({ page }) => {
  await connectAndLogin(page, QA)
  await menu(page, 'quality', 'quality_alert')
  await rows(page).filter({ hasText: VENDOR }).first().click()
  await expect(page.getByTestId('form-title')).toContainText('QA')
  await expect(fieldInput(page, 'description')).toHaveValue(/측정값 50.6mm \(기준 49.8 ~ 50.2\)/)
  await page.getByTestId('tr-start').click()
  await expect(stage(page)).toHaveText('조치 중')
  await page.getByTestId('tr-resolve').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('원인 분류').selectOption('material')
  await type(dialog.getByLabel('원인', { exact: true }), '공급사 절단 공정의 길이 편차')
  await type(dialog.getByLabel('시정 조치'), '해당 로트 반품, 공급사에 공정 개선 요청')
  await page.getByTestId('dlg-confirm').click()
  await expect(stage(page)).toHaveText('해결')
  await shot(page, 'quality-04-resolved')
})

test('S25-10. 불량률 화면에 공급사별 불량률이 원장에서 나오고, 근거가 모자라면 그렇다고 말한다', async ({ page }) => {
  await connectAndLogin(page, QA)
  await menu(page, 'quality', '/quality/analysis')
  const row = page.getByTestId('quality-supplier-row').filter({ hasText: VENDOR })
  await expect(row).toContainText('2')
  await expect(row.getByTestId('quality-supplier-rate')).toHaveText('50.0%')
  await expect(page.getByTestId('quality-state')).toHaveText('근거 부족')
  await expect(page.getByTestId('quality-short')).toContainText('판정한 검사 30건 필요 (지금 2건)')
  await shot(page, 'quality-05-rates')
})

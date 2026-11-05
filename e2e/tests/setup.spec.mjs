// The whole first-run path a new company walks. Only pasting the SQL into the Supabase dashboard is
// replaced: the test runs what the app put on the clipboard through pg instead.
import { test, expect, shot, fieldInput } from '../lib/fixtures.mjs'
import { ADMIN, API_URL, COMPANY, PUBLISHABLE_KEY, sql, tokenFor, wipe, ANON_KEY } from '../lib/stack.mjs'

const STAFF = { name: '이영업', email: 'sales@example.com', password: 'sales-pass-1234' }

test.describe.configure({ mode: 'serial' })
let context
let page

test.beforeAll(async ({ browser }) => {
  await wipe()
  context = await browser.newContext({
    baseURL: 'http://127.0.0.1:5301', viewport: { width: 1280, height: 720 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul',
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  page = await context.newPage()
})
test.afterAll(async () => { await context.close() })

test('처음 접속하면 연결 화면이 나오고 찾는 곳을 안내한다', async () => {
  await page.goto('/')
  await expect(page).toHaveURL(/#\/setup/)
  await expect(page.getByRole('heading', { name: 'Supabase 프로젝트 연결' })).toBeVisible()
  await expect(page.getByRole('link', { name: '대시보드에서 새 프로젝트 만들기' })).toHaveAttribute('href', 'https://supabase.com/dashboard/new')
  await shot(page, '01-setup-connect')
})

test('비밀 키는 네트워크로 보내지도 저장하지도 않고 거부한다', async () => {
  const sent = []
  const onRequest = (r) => sent.push(`${r.url()} ${JSON.stringify(r.headers())}`)
  page.on('request', onRequest)
  const fakeJwt = (role) => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
    return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role, iss: 'supabase' })}.signature`
  }
  await page.getByLabel('Project URL').fill(API_URL)
  for (const secret of [`sb_${'secret'}_not_a_real_key`, fakeJwt('service_role')]) {
    await page.getByLabel('Publishable 키').fill(secret)
    await page.getByTestId('connect-next').click()
    await expect(page.getByTestId('key-error')).toHaveText('이 키는 공개하면 안 되는 키입니다. Publishable(공개) 키를 넣으세요')
    expect(sent.filter((s) => s.includes(secret))).toEqual([])
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }))
    expect(stored).not.toContain(secret)
  }
  await shot(page, '01b-setup-secret-key-refused')
  page.off('request', onRequest)
})

test('잘못된 주소와 키 형식을 알려 준다', async () => {
  await page.getByLabel('Project URL').fill('https://evil.example.com')
  await page.getByLabel('Publishable 키').fill('아무 글자')
  await page.getByTestId('connect-next').click()
  await expect(page.getByTestId('url-error')).toBeVisible()
  await expect(page.getByTestId('key-error')).toContainText('sb_publishable_')
})

test('함수가 없으면 설치 단계로 가고, 복사한 SQL 을 실행하면 자동으로 다음 단계로 넘어간다', async () => {
  await page.getByLabel('Project URL').fill(API_URL)
  await page.getByLabel('Publishable 키').fill(PUBLISHABLE_KEY)
  await page.getByTestId('connect-next').click()

  await expect(page.getByRole('heading', { name: '데이터베이스 설치' })).toBeVisible()
  await expect(page.getByTestId('why-sql')).toContainText('공개 키로는 표를 만들 수 없어서')
  await expect(page.getByTestId('why-sql')).toContainText('우리에게 오지 않습니다')
  await expect(page.getByTestId('install-waiting')).toBeVisible()
  await shot(page, '02-setup-install')

  // The cloud SQL Editor refuses the whole script, so it comes in parts cut at module boundaries, basic sales first.
  const parts = page.locator('[data-testid^="copy-part-"]')
  const total = await parts.count()
  expect(total).toBeGreaterThan(1)
  await expect(page.getByTestId('copy-part-1')).toContainText('기본(판매)')
  await expect(page.getByTestId('copy-part-1')).toHaveClass(/next/)
  for (let n = 1; n <= total; n++) {
    await page.getByTestId(`copy-part-${n}`).click()
    await expect(page.getByTestId(`copy-part-${n}`)).toContainText('복사했습니다')
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied, `${n}번 머리`).toContain(`-- uEngine ERP 설치 ${n}/${total}`)
    const code = copied.match(/select erp\.set_setup_code\('([0-9a-f]{48})'\);\s*$/)
    if (n < total) {
      expect(code, '설치 코드는 마지막 부분에만').toBeNull()
      await sql(copied)
      await expect(page.getByTestId(`copy-part-${n}`)).toHaveAttribute('data-done', 'true', { timeout: 15_000 })
      await expect(page.getByTestId(`copy-part-${n + 1}`)).toHaveClass(/next/)
      await expect(page.getByTestId('install-waiting')).toContainText(`${n}/${total} 실행됨`)
      await expect(page.getByRole('heading', { name: '데이터베이스 설치' })).toBeVisible()
      if (n === 1) await shot(page, '02b-setup-install-part')
    } else {
      expect(code, 'SQL 끝에 설치 코드').not.toBeNull()
      // The code waits in localStorage only until the company exists.
      expect(await page.evaluate(() => localStorage.getItem('erp.setup'))).toContain(code[1])
      await sql(copied)
    }
  }
  await expect(page.getByRole('heading', { name: '회사 만들기' })).toBeVisible({ timeout: 15_000 })
})

test('회사를 만들면 통화 자릿수가 정해지고 자동으로 로그인한다', async () => {
  await page.getByLabel('회사명').fill(COMPANY)
  await page.getByLabel('통화').selectOption('USD')
  await expect(page.getByTestId('co-decimals')).toContainText('소수 2자리')
  await page.getByLabel('통화').selectOption('KRW')
  await expect(page.getByTestId('co-decimals')).toContainText('소수 0자리')
  await page.getByLabel('관리자 이름').fill(ADMIN.name)
  await page.getByLabel('관리자 이메일').fill(ADMIN.email)
  await page.getByLabel(/^비밀번호/).first().fill(ADMIN.password)
  await page.getByLabel('비밀번호 확인').fill('틀린확인비밀번호')
  await page.getByTestId('company-create').click()
  await expect(page.getByTestId('company-error')).toContainText('일치하지 않습니다')
  await page.getByLabel('비밀번호 확인').fill(ADMIN.password)
  await shot(page, '03-setup-company')
  await page.getByTestId('company-create').click()

  await expect(page.getByTestId('home-title')).toHaveText('홈')
  await expect(page.getByTestId('user')).toContainText(ADMIN.name)
  await expect(page.getByTestId('company-name')).toHaveText(COMPANY)
  expect(await page.evaluate(() => localStorage.getItem('erp.setup')), '설치 코드는 끝나면 지운다').toBeNull()
  const keys = await page.evaluate(() => Object.keys(localStorage))
  expect(keys).toContain('erp.session')
  expect(keys.filter((k) => k.startsWith('sb-')), '기본 저장 키를 쓰지 않는다').toEqual([])
  await expect(page.getByTestId('home-events')).toContainText('설치')
  await expect(page.getByTestId('live')).toHaveText('실시간', { timeout: 15_000 })
  await shot(page, '04-home')
})

test('직원을 추가하면 메일 없이 바로 그 계정으로 로그인한다', async () => {
  await page.locator('[data-module="settings"]').click()
  await page.locator('[data-screen="/settings/members"]').click()
  await expect(page.getByTestId('member-row')).toHaveCount(1)
  await page.getByTestId('member-add').click()
  await page.getByLabel('이름').fill(STAFF.name)
  await page.getByLabel('이메일').fill(STAFF.email)
  await page.getByLabel('초기 비밀번호').fill('짧음')
  await page.getByRole('button', { name: '영업' }).click()
  await page.getByRole('button', { name: '조회' }).click()
  await page.getByTestId('dlg-confirm').click()
  await expect(page.getByRole('alert')).toContainText('8자 이상')
  await page.getByLabel('초기 비밀번호').fill(STAFF.password)
  await shot(page, '05-member-add')
  await page.getByTestId('dlg-confirm').click()
  await expect(page.getByTestId('member-row')).toHaveCount(2)
  await expect(page.locator(`[data-email="${STAFF.email}"]`)).toContainText('영업')
  await shot(page, '06-members')

  await page.getByTestId('logout').click()
  await expect(page.getByTestId('login-project')).toBeVisible()
  await expect(page.locator('body')).not.toContainText(COMPANY)
  await shot(page, '07-login')
  await page.getByLabel('이메일').fill(STAFF.email)
  await page.getByLabel('비밀번호').fill('다른비밀번호1234')
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('login-error')).toContainText('이메일 또는 비밀번호가 맞지 않습니다')
  await page.getByLabel('비밀번호').fill(STAFF.password)
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('user')).toContainText(STAFF.name)
})

test('직원에게는 관리자 동작이 보이지 않는다', async () => {
  await page.goto('/#/settings/members')
  await expect(page.getByTestId('member-row')).toHaveCount(2)
  await expect(page.getByTestId('member-add')).toHaveCount(0)
  await expect(page.getByTestId('member-deactivate')).toHaveCount(0)
  await page.goto('/#/settings/backup')
  await expect(page.getByTestId('backup')).toBeDisabled()
  await page.goto('/#/events')
  await expect(page.getByTestId('events-table')).toBeVisible()
  await expect(page.getByTestId('verify')).toHaveCount(0)
  await page.getByTestId('logout').click()
})

test('비활성화한 직원은 더 로그인하지 못한다', async () => {
  await page.getByLabel('이메일').fill(ADMIN.email)
  await page.getByLabel('비밀번호').fill(ADMIN.password)
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('user')).toContainText(ADMIN.name)
  await page.goto('/#/settings/members')
  await page.locator(`[data-email="${STAFF.email}"]`).getByTestId('member-deactivate').click()
  await page.getByLabel(/사유/).fill('퇴사')
  await page.getByTestId('dlg-confirm').click()
  await expect(page.locator(`[data-email="${STAFF.email}"]`)).toContainText('비활성')
  await page.getByTestId('logout').click()

  await page.getByLabel('이메일').fill(STAFF.email)
  await page.getByLabel('비밀번호').fill(STAFF.password)
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('login-error')).toContainText('비활성화된 계정')
})

test('회사가 생긴 뒤에는 공개 키로 가입도, 조회도 되지 않는다', async () => {
  const signup = await fetch(`${API_URL}/auth/v1/signup`, {
    method: 'POST', headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'stranger@example.com', password: 'stranger-pass-1234' }),
  })
  expect(signup.status, '자가 가입 차단').toBeGreaterThanOrEqual(400)
  for (const key of [ANON_KEY, PUBLISHABLE_KEY]) {
    for (const view of ['erp_records', 'erp_events', 'erp_members']) {
      const r = await fetch(`${API_URL}/rest/v1/${view}?select=*`, { headers: { apikey: key } })
      expect([401, 403], `${view} 은 공개 키로 읽히지 않는다`).toContain(r.status)
    }
  }
})

test('접속 해제하면 이 브라우저에서 토큰과 접속 정보가 사라진다', async () => {
  await page.getByLabel('이메일').fill(ADMIN.email)
  await page.getByLabel('비밀번호').fill(ADMIN.password)
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('user')).toContainText(ADMIN.name)
  await page.goto('/#/settings/access')
  await expect(page.getByTestId('security-notes')).toContainText('우리 서버로 오지 않습니다')
  await expect(page.getByTestId('invite-link')).toHaveValue(/#\/connect\?u=.*&k=•+$/)
  await page.getByTestId('invite-copy').click()
  const link = await page.evaluate(() => navigator.clipboard.readText())
  expect(link).toContain(`k=${encodeURIComponent(PUBLISHABLE_KEY)}`)
  await shot(page, '08-settings-access')
  await page.getByTestId('disconnect').click()
  await page.getByTestId('dlg-confirm').click()
  await expect(page).toHaveURL(/#\/setup/)
  const left = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('erp.') && k !== 'erp.history' || k.startsWith('sb-')))
  expect(left).toEqual([])
  // Sanity: the account still works, only this browser forgot it.
  expect(await tokenFor(ADMIN.email, ADMIN.password)).toBeTruthy()
})

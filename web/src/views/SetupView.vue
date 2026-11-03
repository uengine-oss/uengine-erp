<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  classifyKey, clearSetupCode, conn, issueSetupCode, loadSetupCode, normalizeUrl, projectRef, SECRET_KEY_MESSAGE, setConn, sqlEditorUrl,
} from '../lib/conn'
import { functionExists, probeStatus, rpc, type ApiError } from '../lib/api'
import { installSql, setupCodeSql } from '../lib/install'
import { boot, session, signIn } from '../lib/session'
import { copyText, toast } from '../lib/ui'
import ConnectionProblem from '../components/ConnectionProblem.vue'
import Icon from '../components/Icon.vue'
import SplitLayout from '../components/SplitLayout.vue'

type Step = 'connect' | 'install' | 'company' | 'demo'

const route = useRoute()
const router = useRouter()

const step = ref<Step>('connect')
const STEPS: { key: Step; label: string }[] = [
  { key: 'connect', label: '프로젝트 연결' },
  { key: 'install', label: '데이터베이스 설치' },
  { key: 'company', label: '회사 만들기' },
  { key: 'demo', label: '시작하기' },
]
const stepIndex = computed(() => STEPS.findIndex((s) => s.key === step.value))

/* Step 1: connection */
const url = ref(conn.value?.url ?? '')
const key = ref(conn.value?.key ?? '')
const connectError = ref('')
const urlError = ref('')
const keyError = ref('')
const checking = ref(false)
const offline = ref(false)

function validate(): { url: string; key: string } | null {
  urlError.value = ''
  keyError.value = ''
  const u = normalizeUrl(url.value)
  const kind = classifyKey(key.value)
  if (!u.ok) urlError.value = u.message
  if (kind === 'secret') keyError.value = SECRET_KEY_MESSAGE
  else if (kind === 'invalid') keyError.value = 'sb_publishable_ 로 시작하는 Publishable 키(또는 예전 anon 키)를 넣으세요'
  if (!u.ok || kind === 'secret' || kind === 'invalid') return null
  return { url: u.url, key: key.value.trim() }
}

// Validation runs on the pasted text before anything is saved or sent, so a secret key goes nowhere.
watch(key, () => {
  if (classifyKey(key.value) === 'secret') keyError.value = SECRET_KEY_MESSAGE
  else if (keyError.value === SECRET_KEY_MESSAGE) keyError.value = ''
})

async function routeByStatus() {
  checking.value = true
  connectError.value = ''
  offline.value = false
  const probe = await probeStatus()
  checking.value = false
  if (probe.kind === 'offline') { offline.value = true; step.value = 'connect'; return }
  if (probe.kind === 'bad-key') { keyError.value = probe.message; step.value = 'connect'; return }
  if (probe.kind === 'error') { connectError.value = probe.message; step.value = 'connect'; return }
  if (probe.kind === 'missing') { await openInstall(); return }
  session.status = probe.status
  if (!probe.status.initialized) { openCompany(); return }
  session.phase = 'idle'
  await router.replace({ name: 'login' })
}

async function submitConnect() {
  const next = validate()
  if (!next) return
  setConn(next)
  await routeByStatus()
}

/* Step 2: install */
const setupCode = ref('')
const sqlText = ref('')
const sqlSize = computed(() => `${Math.ceil(sqlText.value.length / 1024)} KB`)
const copied = ref(false)
const copyFailed = ref(false)
let pollTimer: ReturnType<typeof setInterval> | undefined

const editorLink = computed(() => sqlEditorUrl(conn.value?.url))
const hasRef = computed(() => !!projectRef(conn.value?.url))

function stopPolling() {
  clearInterval(pollTimer)
  pollTimer = undefined
  document.removeEventListener('visibilitychange', pollNow)
}
async function pollNow() {
  if (step.value !== 'install') return
  const probe = await probeStatus()
  if (step.value !== 'install' || probe.kind !== 'ok') return
  stopPolling()
  session.status = probe.status
  toast('설치를 확인했습니다.')
  if (probe.status.initialized) {
    session.phase = 'idle'
    await router.replace({ name: 'login' })
  } else {
    openCompany()
  }
}

async function openInstall() {
  const url_ = conn.value!.url
  setupCode.value = loadSetupCode(url_) ?? issueSetupCode(url_)
  sqlText.value = await installSql(setupCode.value)
  copied.value = false
  step.value = 'install'
  stopPolling()
  pollTimer = setInterval(pollNow, 3000)
  // Background tabs throttle timers, and the user is in the Supabase tab while the SQL runs.
  document.addEventListener('visibilitychange', pollNow)
}

async function copySql() {
  const ok = await copyText(sqlText.value)
  copied.value = ok
  copyFailed.value = !ok
}

/* Step 3: company */
const company = ref({ name: '', currency: 'KRW', adminName: '', email: '', password: '', password2: '' })
const CURRENCIES = [
  { code: 'KRW', label: 'KRW 대한민국 원', decimals: 0 },
  { code: 'USD', label: 'USD 미국 달러', decimals: 2 },
]
const currencyDecimals = computed(() => CURRENCIES.find((c) => c.code === company.value.currency)?.decimals ?? 0)
const companyError = ref('')
const creating = ref(false)
const needsCode = ref(false)
const reissueSql = ref('')

function openCompany() {
  stopPolling()
  const url_ = conn.value!.url
  const code = loadSetupCode(url_)
  if (code) {
    setupCode.value = code
    needsCode.value = false
  } else {
    // Installed from another browser: this one needs a code of its own.
    requireNewCode()
  }
  step.value = 'company'
}
function requireNewCode() {
  setupCode.value = issueSetupCode(conn.value!.url)
  reissueSql.value = setupCodeSql(setupCode.value)
  needsCode.value = true
}

async function createCompany() {
  companyError.value = ''
  const c = company.value
  if (c.password !== c.password2) { companyError.value = '비밀번호 확인이 일치하지 않습니다.'; return }
  creating.value = true
  try {
    await rpc('erp_bootstrap', {
      p_setup_code: setupCode.value,
      p_company: {
        name: c.name.trim(),
        currency: c.currency,
        decimal_places: currencyDecimals.value,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul',
      },
      p_email: c.email.trim(),
      p_password: c.password,
      p_name: c.adminName.trim(),
    })
    clearSetupCode()
    await signIn(c.email, c.password)
    await boot()
    company.value.password = ''
    company.value.password2 = ''
    if (await functionExists('erp_demo_seed')) step.value = 'demo'
    else await router.replace('/')
  } catch (e) {
    const err = e as ApiError
    if (err.code === 'ERP_SETUP_CODE') requireNewCode()
    if (err.code === 'ERP_INITIALIZED') { clearSetupCode(); await router.replace({ name: 'login' }); return }
    companyError.value = err.message
  } finally {
    creating.value = false
  }
}

async function copyReissue() {
  const ok = await copyText(reissueSql.value)
  toast(ok ? 'SQL 을 복사했습니다. SQL Editor 에서 실행하세요.' : '복사하지 못했습니다.', ok ? 'ok' : 'error')
}

/* Step 4: demo data (only when the install has a demo module) */
const seeding = ref(false)
const seedError = ref('')
async function seedDemo() {
  seeding.value = true
  seedError.value = ''
  try {
    // The API cuts statements at 8 seconds, so the seed returns a cursor until it is finished.
    let next: unknown = null
    do {
      const res = await rpc<{ next?: unknown } | null>('erp_demo_seed', next === null ? {} : { p_step: next })
      next = res?.next ?? null
    } while (next !== null)
    await boot()
    await router.replace('/')
  } catch (e) {
    seedError.value = (e as ApiError).message
  } finally {
    seeding.value = false
  }
}

onMounted(() => {
  // "Change connection" opens step 1 as is; a plain visit continues from wherever setup stopped.
  if (conn.value && route.query.change !== '1') void routeByStatus()
})
onBeforeUnmount(stopPolling)
</script>

<template>
  <SplitLayout note="이 앱은 정적 파일입니다. 접속 정보와 업무 데이터는 이 브라우저와 회사의 Supabase 프로젝트 사이에서만 오갑니다.">
    <template #side>
      <ol class="steps" aria-label="설치 단계">
        <li v-for="(s, i) in STEPS" :key="s.key" :class="{ on: i === stepIndex, done: i < stepIndex }" :aria-current="i === stepIndex ? 'step' : undefined">
          <span class="step-no"><Icon v-if="i < stepIndex" name="check" :size="11" /><template v-else>{{ i + 1 }}</template></span>
          <span>{{ s.label }}</span>
        </li>
      </ol>
    </template>

    <!-- 1. Connect -->
    <template v-if="step === 'connect'">
      <h1 class="split-title">Supabase 프로젝트 연결</h1>
      <p class="split-lead">회사 데이터는 회사 소유의 Supabase 프로젝트에 저장됩니다. 무료 플랜으로 시작할 수 있습니다.</p>

      <ConnectionProblem v-if="offline" :busy="checking" @retry="submitConnect" @change="offline = false" />

      <form v-else class="form-stack" novalidate @submit.prevent="submitConnect">
        <div class="field-stack">
          <label for="setup-url">Project URL</label>
          <input id="setup-url" v-model="url" class="input input-lg" :class="{ 'is-invalid': urlError }" placeholder="https://프로젝트ID.supabase.co" autocomplete="off" spellcheck="false" />
          <span v-if="urlError" class="err-text small" role="alert" data-testid="url-error">{{ urlError }}</span>
        </div>
        <div class="field-stack">
          <label for="setup-key">Publishable 키 (공개 키)</label>
          <input id="setup-key" v-model="key" class="input input-lg mono" :class="{ 'is-invalid': keyError }" placeholder="sb_publishable_..." autocomplete="off" spellcheck="false" />
          <span v-if="keyError" class="err-text small" role="alert" data-testid="key-error">{{ keyError }}</span>
          <span v-else class="hint">예전 프로젝트의 anon 키(eyJ...)도 쓸 수 있지만, Supabase 가 2026년 말까지 단계적으로 없애는 중이니 Publishable 키를 권합니다.</span>
        </div>
        <div v-if="connectError" class="banner banner-error" role="alert"><Icon name="alert" /><span>{{ connectError }}</span></div>
        <div class="row">
          <button type="submit" class="btn btn-primary btn-lg" :disabled="checking" data-testid="connect-next">{{ checking ? '확인 중…' : '다음' }}</button>
        </div>
      </form>

      <div v-if="!offline" class="section" style="margin-top: 22px; border-top: 1px solid var(--line); padding-top: 14px">
        <h3 class="section-title">어디서 찾나요?</h3>
        <ol class="note-list">
          <li>프로젝트가 없다면 <a href="https://supabase.com/dashboard/new" target="_blank" rel="noopener noreferrer">대시보드에서 새 프로젝트 만들기</a></li>
          <li>프로젝트 화면 위쪽의 <b>Connect</b> 를 누르면 Project URL 과 Publishable 키가 함께 보입니다.</li>
          <li>모든 키는 <b>Settings &gt; API Keys</b> 에 있습니다. <code>sb_secret_</code> 키는 비밀 키이니 넣지 마세요.</li>
        </ol>
      </div>
    </template>

    <!-- 2. Install -->
    <template v-else-if="step === 'install'">
      <h1 class="split-title">데이터베이스 설치</h1>
      <p class="split-lead" data-testid="why-sql">공개 키로는 표를 만들 수 없어서 SQL 을 한 번 직접 실행해야 합니다. 키나 데이터는 우리에게 오지 않습니다.</p>
      <ol class="how">
        <li>
          <div class="row">
            <button type="button" class="btn btn-primary" data-testid="copy-sql" @click="copySql"><Icon :name="copied ? 'check' : 'copy'" :size="13" />{{ copied ? '복사했습니다' : 'SQL 복사' }}</button>
            <span class="muted small">{{ sqlSize }} · 이 설치 전용 코드 포함</span>
          </div>
          <p v-if="copyFailed" class="err-text small" style="margin-top: 4px">복사하지 못했습니다. 아래 'SQL 내용 보기'에서 직접 복사하세요.</p>
        </li>
        <li>
          <template v-if="hasRef">
            <a class="btn" :href="editorLink" target="_blank" rel="noopener noreferrer" data-testid="sql-editor-link"><Icon name="external" :size="13" />이 프로젝트의 SQL Editor 열기</a>
          </template>
          <template v-else>
            <span data-testid="sql-editor-local">이 주소는 로컬 프로젝트입니다. 프로젝트의 SQL 실행 도구를 여세요.</span>
          </template>
        </li>
        <li>붙여 넣고 <b>Run</b> 을 누릅니다. 여러 번 실행해도 데이터는 지워지지 않습니다.</li>
      </ol>
      <div class="banner banner-info" data-testid="install-waiting">
        <span class="spin"></span><span>실행을 기다리는 중입니다. 끝나면 자동으로 다음 단계로 넘어갑니다.</span>
      </div>
      <details style="margin-top: 14px">
        <summary>SQL 내용 보기</summary>
        <textarea class="sqlbox" style="margin-top: 6px" readonly :value="sqlText" data-testid="install-sql" aria-label="설치 SQL"></textarea>
      </details>
      <p style="margin-top: 12px"><button type="button" class="btn btn-ghost btn-sm" @click="stopPolling(); step = 'connect'">접속 정보 변경</button></p>
    </template>

    <!-- 3. Company -->
    <template v-else-if="step === 'company'">
      <h1 class="split-title">회사 만들기</h1>
      <p class="split-lead">회사 정보와 첫 관리자 계정을 만듭니다. 메일 인증 없이 바로 로그인됩니다.</p>

      <div v-if="needsCode" class="banner banner-warn" style="margin-bottom: 12px; align-items: flex-start" data-testid="reissue-code">
        <Icon name="alert" />
        <div class="stack" style="gap: 6px">
          <span>이 브라우저에는 설치 코드가 없습니다. 아래 한 줄을 SQL Editor 에서 실행한 뒤 회사를 만드세요.</span>
          <code style="word-break: break-all">{{ reissueSql }}</code>
          <div class="row">
            <button type="button" class="btn btn-sm" @click="copyReissue"><Icon name="copy" :size="12" />복사</button>
            <a v-if="hasRef" class="btn btn-sm" :href="editorLink" target="_blank" rel="noopener noreferrer"><Icon name="external" :size="12" />SQL Editor</a>
          </div>
        </div>
      </div>

      <form class="form-stack" @submit.prevent="createCompany">
        <div class="form-row-2">
          <div class="field-stack">
            <label for="co-name">회사명</label>
            <input id="co-name" v-model="company.name" class="input" required autocomplete="organization" />
          </div>
          <div class="field-stack">
            <label for="co-currency">통화</label>
            <select id="co-currency" v-model="company.currency" class="select">
              <option v-for="c in CURRENCIES" :key="c.code" :value="c.code">{{ c.label }}</option>
            </select>
            <span class="hint" data-testid="co-decimals">소수 {{ currencyDecimals }}자리. 설치 후 변경 불가</span>
          </div>
        </div>
        <div class="form-row-2">
          <div class="field-stack">
            <label for="co-admin">관리자 이름</label>
            <input id="co-admin" v-model="company.adminName" class="input" required autocomplete="name" />
          </div>
          <div class="field-stack">
            <label for="co-email">관리자 이메일</label>
            <input id="co-email" v-model="company.email" class="input" type="email" required autocomplete="username" />
          </div>
        </div>
        <div class="form-row-2">
          <div class="field-stack">
            <label for="co-pass">비밀번호 <span class="muted">(8자 이상)</span></label>
            <input id="co-pass" v-model="company.password" class="input" type="password" minlength="8" required autocomplete="new-password" />
          </div>
          <div class="field-stack">
            <label for="co-pass2">비밀번호 확인</label>
            <input id="co-pass2" v-model="company.password2" class="input" type="password" minlength="8" required autocomplete="new-password" />
          </div>
        </div>
        <div v-if="companyError" class="banner banner-error" role="alert" data-testid="company-error"><Icon name="alert" /><span>{{ companyError }}</span></div>
        <div class="row">
          <button type="submit" class="btn btn-primary btn-lg" :disabled="creating" data-testid="company-create">{{ creating ? '만드는 중…' : '회사 만들기' }}</button>
        </div>
      </form>
    </template>

    <!-- 4. Demo data -->
    <template v-else>
      <h1 class="split-title">데모 데이터를 넣을까요?</h1>
      <p class="split-lead">거래처·제품·주문 예시로 화면을 먼저 둘러볼 수 있습니다. 실제 업무에 쓸 회사라면 빈 상태로 시작하세요.</p>
      <div v-if="seedError" class="banner banner-error" role="alert" style="margin-bottom: 12px"><Icon name="alert" /><span>{{ seedError }}</span></div>
      <div class="row">
        <button type="button" class="btn btn-primary btn-lg" :disabled="seeding" data-testid="demo-seed" @click="seedDemo">{{ seeding ? '넣는 중…' : '데모 데이터 넣기' }}</button>
        <button type="button" class="btn btn-lg" :disabled="seeding" data-testid="demo-skip" @click="router.replace('/')">빈 회사로 시작</button>
      </div>
    </template>
  </SplitLayout>
</template>

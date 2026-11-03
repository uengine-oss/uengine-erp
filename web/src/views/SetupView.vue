<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  classifyKey, clearSetupCode, conn, issueSetupCode, loadSetupCode, normalizeUrl, projectRef, SECRET_KEY_MESSAGE, setConn, sqlEditorUrl,
} from '../lib/conn'
import { probeStatus, rpc, type ApiError } from '../lib/api'
import { installSql, setupCodeSql } from '../lib/install'
import { boot, session, signIn } from '../lib/session'
import { copyText, toast } from '../lib/ui'
import ConnectionProblem from '../components/ConnectionProblem.vue'
import Icon from '../components/Icon.vue'
import SplitLayout from '../components/SplitLayout.vue'

type Step = 'connect' | 'install' | 'company'

const route = useRoute()
const router = useRouter()

const step = ref<Step>('connect')
const STEPS: { key: Step; label: string }[] = [
  { key: 'connect', label: '프로젝트 연결' },
  { key: 'install', label: '데이터베이스 설치' },
  { key: 'company', label: '회사 만들기' },
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
const startWith = ref<'real' | 'demo'>('real')
const isDemo = computed(() => startWith.value === 'demo')

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
    // Loaded only for those who ask: the story of a made-up company is no use to a real one.
    const demo = isDemo.value ? await import('../lib/demo/generate.ts') : null
    await rpc('erp_bootstrap', {
      p_setup_code: setupCode.value,
      p_company: demo
        ? { name: '가온가전(데모)', currency: 'KRW', decimal_places: 0, timezone: 'Asia/Seoul', started_at: demo.STARTED_AT }
        : {
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
    await router.replace(demo ? { name: 'demo-build', query: { start: '1' } } : '/')
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
      <p class="split-lead">{{ isDemo ? '둘러볼 가상 회사와 그 회사의 관리자 계정을 만듭니다.' : '회사 정보와 첫 관리자 계정을 만듭니다.' }} 메일 인증 없이 바로 로그인됩니다.</p>

      <fieldset class="start-with" data-testid="start-with">
        <legend class="sr-only">어떻게 시작할까요</legend>
        <label class="choice" :class="{ on: !isDemo }">
          <input v-model="startWith" type="radio" name="start-with" value="real" data-testid="start-real" />
          <span><b>실제 회사로 시작</b><small>빈 회사입니다. 판매 모듈이 켜진 채 시작하고, 나머지는 필요할 때 켭니다.</small></span>
        </label>
        <label class="choice" :class="{ on: isDemo }">
          <input v-model="startWith" type="radio" name="start-with" value="demo" data-testid="start-demo" />
          <span><b>가상 회사(가온가전)로 먼저 체험하기</b><small>3년치 판매·재고·구매·청구·회계를 실제 명령으로 만듭니다.</small></span>
        </label>
      </fieldset>
      <div v-if="isDemo" class="banner banner-warn" style="margin-bottom: 12px; align-items: flex-start" data-testid="demo-cost">
        <Icon name="alert" />
        <span>데이터베이스를 약 250 MB 씁니다(무료 플랜 한도 500 MB). 다 만드는 데 몇 분 걸립니다. 만든 데이터는 지어낸 것이니, 실제 업무에는 새 프로젝트로 시작하세요.</span>
      </div>

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
        <div v-if="!isDemo" class="form-row-2">
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
          <button type="submit" class="btn btn-primary btn-lg" :disabled="creating" data-testid="company-create">{{ creating ? '만드는 중…' : isDemo ? '가상 회사 만들기' : '회사 만들기' }}</button>
        </div>
      </form>
    </template>
  </SplitLayout>
</template>

<style scoped>
.start-with { display: flex; flex-direction: column; gap: 6px; max-width: 560px; margin: 0 0 12px; padding: 0; border: 0; }
.choice { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border: 1px solid var(--line-strong); border-radius: var(--radius); cursor: pointer; }
.choice.on { border-color: var(--navy-600); box-shadow: 0 0 0 1px var(--navy-600); }
.choice input { margin-top: 3px; flex: none; }
.choice b { display: block; font-weight: 600; }
.choice small { color: var(--text-2); font-size: 12px; }
</style>

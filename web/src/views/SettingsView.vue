<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { conn, db, inviteLink, projectRef } from '../lib/conn'
import { messageOf, rpc, toApiError, type ApiError } from '../lib/api'
import { exportLedger } from '../lib/backup'
import { sendCommand } from '../lib/commands'
import { timeView, writeBlock } from '../lib/mode'
import { APP_VERSION } from '../lib/install'
import { catalogOf, disconnect, isAdmin, session } from '../lib/session'
import { displayValue } from '../lib/fields'
import { fmtBytes, fmtDay } from '../lib/format'
import { onLedgerEvent } from '../lib/realtime'
import { ask, copyText, saveBlob, toast } from '../lib/ui'
import { COMPANY_ID, type ErpRecord, type Field, type Usage } from '../lib/types'
import EmptyState from '../components/EmptyState.vue'
import FieldValue from '../components/FieldValue.vue'
import Icon from '../components/Icon.vue'
import MetaForm from './MetaForm.vue'

const props = defineProps<{ tab: string }>()
const router = useRouter()

const TITLES: Record<string, string> = { company: '회사 정보', members: '구성원', usage: '사용량', backup: '백업', access: '접속·보안' }
const title = computed(() => TITLES[props.tab])

/* Members */
const memberDoc = computed(() => catalogOf('member'))
const members = ref<ErpRecord[]>([])
const membersLoading = ref(false)
const membersError = ref('')
const adminUser = computed(() => isAdmin())
const canManageMembers = computed(() => adminUser.value && !writeBlock.value)

async function loadMembers() {
  membersLoading.value = true
  membersError.value = ''
  try {
    if (timeView.at) {
      const past = await rpc<{ rows: ErpRecord[] }>('erp_records_at', { p_type: 'member', p_at: timeView.at, p_limit: 500, p_offset: 0 })
      members.value = past.rows
      return
    }
    const { data, error, status } = await db().from('erp_records').select('*').eq('type', 'member').order('active', { ascending: false }).order('name')
    if (error) throw toApiError(error, status)
    members.value = (data ?? []) as ErpRecord[]
  } catch (e) {
    membersError.value = messageOf(e)
    if (timeView.at) members.value = []
  } finally {
    membersLoading.value = false
  }
}

const rolesField = computed<Field | undefined>(() => memberDoc.value?.fields.find((f) => f.name === 'roles'))

async function addMember() {
  const fields = (memberDoc.value?.fields ?? []).map((f): Field => {
    if (f.name === 'password') return { ...f, required: true, help: '8자 이상. 메일이 발송되지 않으니 직원에게 직접 전달하세요.' }
    if (f.name === 'roles') return { ...f, help: '쓸 수 있는 범위를 역할이 정합니다. 일부 유형은 읽기도 역할로 제한됩니다.' }
    return f
  })
  let values: Record<string, any> = { roles: ['viewer'] }
  let error = ''
  for (;;) {
    const answer = await ask({ title: '직원 추가', message: '추가하면 이 이메일과 비밀번호로 바로 로그인할 수 있습니다.', error, fields, values, confirmLabel: '추가', wide: true })
    if (!answer) return
    values = answer.values
    try {
      await sendCommand({ type: 'member', command: 'create', payload: values })
      toast(`${values.name} 님을 추가했습니다.`)
      await loadMembers()
      return
    } catch (e) {
      error = messageOf(e)
    }
  }
}

async function setActive(m: ErpRecord, active: boolean) {
  const command = active ? 'unarchive' : 'archive'
  const label = active ? '다시 활성화' : '비활성화'
  const answer = await ask({
    title: `${m.state.name} 님 ${label}`,
    message: active ? '다시 로그인하고 일할 수 있게 됩니다.' : '이 계정은 더 이상 데이터를 읽거나 쓸 수 없습니다. 지난 이력은 그대로 남습니다.',
    danger: !active,
    reason: !active,
    confirmLabel: label,
  })
  if (!answer) return
  try {
    await sendCommand({ type: 'member', id: m.id, command, reason: answer.reason || null, expectedVersion: m.version })
    toast(`${m.state.name} 님을 ${label}했습니다.`)
    await loadMembers()
  } catch (e) {
    toast(messageOf(e), 'error')
    await loadMembers()
  }
}

let memberTimer: ReturnType<typeof setTimeout> | undefined
onLedgerEvent((ev) => {
  if (ev.stream_type !== 'member' || props.tab !== 'members') return
  clearTimeout(memberTimer)
  memberTimer = setTimeout(loadMembers, 300)
})

/* Usage */
const usage = ref<Usage | null>(null)
const usageError = ref('')
async function loadUsage() {
  usageError.value = ''
  try { usage.value = await rpc<Usage>('erp_usage') } catch (e) { usageError.value = messageOf(e) }
}
const percent = computed(() => (usage.value ? (usage.value.db_bytes / usage.value.limit_bytes) * 100 : 0))

/* Backup */
const backingUp = ref(false)
const backupCount = ref(0)
const backupResult = ref('')
const backupError = ref('')

async function backup() {
  backingUp.value = true
  backupCount.value = 0
  backupResult.value = ''
  backupError.value = ''
  try {
    const { blob, count, gz } = await exportLedger((n) => { backupCount.value = n })
    const company = String(session.company?.state?.name ?? 'company').replace(/[\\/:*?"<>|\s]+/g, '_')
    saveBlob(blob, `uengine-erp_${company}_${fmtDay(new Date().toISOString())}.ndjson${gz ? '.gz' : ''}`)
    backupResult.value = `이벤트 ${count.toLocaleString('ko-KR')}건을 ${fmtBytes(blob.size)} 파일로 받았습니다.`
  } catch (e) {
    backupError.value = messageOf(e)
  } finally {
    backingUp.value = false
  }
}

/* Access */
const invite = computed(() => (conn.value ? inviteLink(conn.value) : ''))
// The link is meant to be sent, not read: the key stays out of the box so it stays out of screen shares.
const invitePreview = computed(() => invite.value.replace(/([?&]k=).*$/, '$1••••••'))
const projectName = computed(() => projectRef(conn.value?.url) ?? conn.value?.url ?? '')
async function copyInvite() {
  const ok = await copyText(invite.value)
  toast(ok ? '초대 링크를 복사했습니다.' : '복사하지 못했습니다.', ok ? 'ok' : 'error')
}
async function leave() {
  const answer = await ask({
    title: '접속 해제',
    message: '이 브라우저에 저장된 접속 정보와 로그인 토큰을 지웁니다. 회사 데이터는 Supabase 프로젝트에 그대로 남습니다.',
    danger: true,
    confirmLabel: '접속 해제',
  })
  if (!answer) return
  await disconnect()
  await router.replace({ name: 'setup' })
}

const newPassword = ref('')
const newPassword2 = ref('')
const passwordBusy = ref(false)
const passwordError = ref('')
async function changePassword() {
  passwordError.value = ''
  if (newPassword.value.length < 8) { passwordError.value = '비밀번호는 8자 이상이어야 합니다.'; return }
  if (newPassword.value !== newPassword2.value) { passwordError.value = '비밀번호 확인이 일치하지 않습니다.'; return }
  passwordBusy.value = true
  try {
    const { error } = await db().auth.updateUser({ password: newPassword.value })
    if (error) throw error
    newPassword.value = ''
    newPassword2.value = ''
    toast('비밀번호를 바꿨습니다.')
  } catch (e) {
    passwordError.value = (e as ApiError).message?.includes('different') ? '지금 비밀번호와 다른 비밀번호를 넣으세요.' : '비밀번호를 바꾸지 못했습니다.'
  } finally {
    passwordBusy.value = false
  }
}

watch(() => timeView.at, () => { if (props.tab === 'members') void loadMembers() })
watch(() => props.tab, (tab) => {
  if (tab === 'members') void loadMembers()
  if (tab === 'usage') void loadUsage()
}, { immediate: true })
onBeforeUnmount(() => clearTimeout(memberTimer))
</script>

<template>
  <MetaForm v-if="tab === 'company'" type="company" :id="COMPANY_ID" embedded />

  <div v-else-if="title" class="page">
    <div class="page-head">
      <h1>{{ title }}<span v-if="tab === 'members'" class="page-count">{{ members.length }}명</span></h1>
      <div class="grow"></div>
      <button v-if="tab === 'members' && canManageMembers" type="button" class="btn btn-primary" data-testid="member-add" @click="addMember"><Icon name="plus" :size="13" />직원 추가</button>
    </div>

    <!-- Members -->
    <div v-if="tab === 'members'" class="page-body" style="background: var(--surface)">
      <div v-if="membersError" class="banner banner-error banner-flush" role="alert"><Icon name="alert" /><span class="grow">{{ membersError }}</span><button type="button" class="btn btn-sm" @click="loadMembers">다시 시도</button></div>
      <table v-if="members.length" class="tbl" data-testid="members-table">
        <thead>
          <tr><th>이름</th><th>이메일</th><th>역할</th><th style="width: 90px">상태</th><th v-if="canManageMembers" style="width: 110px"></th></tr>
        </thead>
        <tbody>
          <tr v-for="m in members" :key="m.id" class="clickable" :class="{ 'is-archived': !m.active }" data-testid="member-row" :data-email="m.state.email" tabindex="0"
              @click="router.push({ name: 'record', params: { type: 'member', id: m.id } })" @keydown.enter="router.push({ name: 'record', params: { type: 'member', id: m.id } })">
            <td>{{ m.state.name }}<span v-if="m.state.user_id === session.me?.user_id" class="muted small"> (나)</span></td>
            <td>{{ m.state.email }}</td>
            <td><FieldValue v-if="rolesField" :field="rolesField" :value="m.state.roles" /></td>
            <td><span class="pill" :class="m.active ? 'pill-green' : 'pill-gray'">{{ m.active ? '활성' : '비활성' }}</span></td>
            <td v-if="canManageMembers" class="num">
              <template v-if="m.state.user_id !== session.me?.user_id">
                <button v-if="m.active" type="button" class="btn btn-sm" data-testid="member-deactivate" @click.stop="setActive(m, false)">비활성화</button>
                <button v-else type="button" class="btn btn-sm" data-testid="member-activate" @click.stop="setActive(m, true)">다시 활성화</button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-else-if="!membersLoading && !membersError" title="표시할 구성원이 없습니다" />
    </div>

    <!-- Usage -->
    <div v-else-if="tab === 'usage'" class="page-body page-pad">
      <div class="settings-col">
        <div v-if="usageError" class="banner banner-error" role="alert"><Icon name="alert" /><span class="grow">{{ usageError }}</span><button type="button" class="btn btn-sm" @click="loadUsage">다시 시도</button></div>
        <section v-if="usage" class="section" data-testid="usage">
          <div class="row" style="justify-content: space-between; margin-bottom: 6px">
            <h2>데이터베이스</h2>
            <span data-testid="usage-text">{{ fmtBytes(usage.db_bytes) }} / {{ fmtBytes(usage.limit_bytes) }} ({{ percent.toFixed(1) }}%)</span>
          </div>
          <div class="meter" style="height: 12px; border-radius: 6px" :class="{ warn: usage.level === 'near', bad: usage.level === 'full' }" role="progressbar" :aria-valuenow="Math.round(percent)" aria-valuemin="0" aria-valuemax="100"><i :style="{ width: `${Math.min(100, percent)}%` }"></i></div>
          <p v-if="usage.level === 'near' || usage.level === 'full'" class="err-text small" style="margin-top: 6px" data-testid="usage-warning">{{ usage.level === 'full' ? '한도가 거의 찼습니다. 곧 쓰기가 막힐 수 있으니 지금 백업을 받고 대시보드에서 플랜을 확인하세요.' : '한도에 가까워지고 있습니다. 넘으면 무료 플랜 프로젝트는 읽기 전용이 될 수 있으니 백업을 받고 대시보드에서 플랜을 확인하세요.' }}</p>
          <dl class="kv" style="margin-top: 12px">
            <dt>이벤트</dt><dd>{{ usage.events.toLocaleString('ko-KR') }}건 · {{ fmtBytes(usage.events_bytes) }}</dd>
            <dt>문서(현재 상태)</dt><dd>{{ usage.records.toLocaleString('ko-KR') }}건 · {{ fmtBytes(usage.records_bytes) }}</dd>
          </dl>
        </section>
        <section class="section">
          <h2 class="section-title">무료 플랜에서 알아 둘 것</h2>
          <ul class="note-list" data-testid="free-plan-notes">
            <li>데이터베이스 용량은 500MB 까지입니다.</li>
            <li>자동 백업이 없습니다. 자동 일일 백업은 유료 플랜부터이므로 정기적으로 <router-link to="/settings/backup">백업</router-link>을 받아 두세요.</li>
            <li>7일 동안 활동이 없으면 프로젝트가 일시 중지됩니다. 데이터는 남아 있고, 대시보드에서 재개하면 다시 쓸 수 있습니다.</li>
          </ul>
        </section>
      </div>
    </div>

    <!-- Backup -->
    <div v-else-if="tab === 'backup'" class="page-body page-pad">
      <div class="settings-col">
        <section class="section">
          <h2 class="section-title">이벤트 원장 내려받기</h2>
          <p class="dim" style="margin-bottom: 10px">모든 데이터의 원본인 이벤트를 파일 하나(NDJSON, gzip 압축)로 받습니다. 파일은 이 브라우저에서 만들어져 이 컴퓨터로 바로 저장되며, 어디로도 전송되지 않습니다.</p>
          <div class="row">
            <button type="button" class="btn btn-primary" :disabled="backingUp || !adminUser" data-testid="backup" @click="backup"><Icon name="download" :size="13" />{{ backingUp ? '받는 중…' : '백업 받기' }}</button>
            <span v-if="backingUp" class="dim" data-testid="backup-progress">{{ backupCount.toLocaleString('ko-KR') }}건 받는 중…</span>
            <span v-if="!adminUser" class="muted">관리자만 받을 수 있습니다.</span>
          </div>
          <div v-if="backupResult" class="banner banner-ok" style="margin-top: 10px" data-testid="backup-done"><Icon name="check" /><span>{{ backupResult }}</span></div>
          <div v-if="backupError" class="banner banner-error" style="margin-top: 10px" role="alert"><Icon name="alert" /><span>{{ backupError }}</span></div>
        </section>
        <section class="section">
          <h2 class="section-title">무료 플랜에는 자동 백업이 없습니다</h2>
          <ul class="note-list">
            <li>자동 일일 백업은 유료 플랜부터입니다. 무료 플랜이라면 이 파일을 정기적으로 받아 안전한 곳에 보관하세요.</li>
            <li>파일에는 회사의 모든 업무 데이터가 들어 있습니다. 비밀번호는 들어 있지 않습니다.</li>
            <li>앱에는 아직 이 파일로 되돌리는 기능이 없습니다. 파일은 원본 기록 보관과 외부 분석에 쓸 수 있습니다.</li>
          </ul>
        </section>
      </div>
    </div>

    <!-- Access and security -->
    <div v-else-if="tab === 'access'" class="page-body page-pad">
      <div class="settings-col">
        <section class="section">
          <h2 class="section-title">동료 초대 링크</h2>
          <p class="dim" style="margin-bottom: 8px">동료는 이 링크로 접속 정보를 입력 없이 넘겨받습니다. 공개 키만 들어 있어 이 링크만으로는 아무것도 볼 수 없고, 관리자가 만든 계정으로 로그인해야 합니다.</p>
          <div class="row">
            <input class="input mono grow" readonly :value="invitePreview" aria-label="초대 링크 미리 보기" data-testid="invite-link" />
            <button type="button" class="btn" data-testid="invite-copy" @click="copyInvite"><Icon name="copy" :size="13" />복사</button>
          </div>
        </section>

        <section class="section" data-testid="security-notes">
          <h2 class="section-title">보안 안내</h2>
          <ul class="note-list">
            <li>이 앱은 정적 파일입니다. 브라우저가 이 회사의 Supabase 프로젝트로 바로 연결하며, 키와 데이터는 우리 서버로 오지 않습니다. 우리에게는 그런 서버가 없습니다.</li>
            <li>공개 키가 노출돼도 권한 없는 사용자는 업무 데이터를 하나도 읽지 못합니다. 로그인 전에 알 수 있는 것은 설치 여부와 스키마 버전뿐입니다.</li>
            <li>설치 SQL 이 auth.users 트리거로 자가 가입을 막으므로 대시보드에서 따로 설정할 것이 없습니다. 계정은 관리자만 만듭니다. (설치 때 SQL 결과에 <code>erp_guard_signup not installed</code> 알림이 나왔다면 대시보드에서 가입을 꺼 주세요.)</li>
            <li>모든 쓰기는 데이터베이스 안의 함수 하나를 거치고, 거기서 역할을 검사합니다. 브라우저 코드를 고쳐도 권한을 넘을 수 없습니다.</li>
            <li>로그인 토큰과 접속 정보는 이 브라우저의 저장소에 남습니다. 함께 쓰는 컴퓨터에서는 다 쓴 뒤 접속 해제를 누르세요.</li>
            <li>비밀 키(<code>sb_secret_</code>, service_role)는 이 앱에 넣지 마세요. 넣어도 저장하지 않고 거부합니다.</li>
            <li>외부 스크립트, 분석 도구, 외부 글꼴을 쓰지 않습니다. 콘텐츠 보안 정책이 Supabase 외의 연결을 막습니다.</li>
          </ul>
        </section>

        <section class="section">
          <h2 class="section-title">내 비밀번호 변경</h2>
          <form class="row-wrap" @submit.prevent="changePassword">
            <input v-model="newPassword" class="input" style="width: 180px" type="password" placeholder="새 비밀번호 (8자 이상)" aria-label="새 비밀번호" autocomplete="new-password" data-testid="new-password" />
            <input v-model="newPassword2" class="input" style="width: 180px" type="password" placeholder="새 비밀번호 확인" aria-label="새 비밀번호 확인" autocomplete="new-password" data-testid="new-password2" />
            <button type="submit" class="btn" :disabled="passwordBusy || !newPassword" data-testid="change-password">변경</button>
            <span v-if="passwordError" class="err-text small" role="alert">{{ passwordError }}</span>
          </form>
        </section>

        <section class="section">
          <h2 class="section-title">접속 정보</h2>
          <dl class="kv" style="margin-bottom: 10px">
            <dt>프로젝트</dt><dd><code data-testid="access-project">{{ projectName }}</code></dd>
            <dt>앱 / 스키마 버전</dt><dd>v{{ APP_VERSION }} / v{{ session.status?.version ?? '?' }}</dd>
          </dl>
          <button type="button" class="btn btn-danger" data-testid="disconnect" @click="leave"><Icon name="logout" :size="13" />접속 해제</button>
        </section>
      </div>
    </div>
  </div>

  <div v-else class="page"><div class="page-body"><EmptyState title="없는 설정 화면입니다"><router-link class="btn" to="/settings/company">설정으로</router-link></EmptyState></div></div>
</template>

<style scoped>
.settings-col { max-width: 760px; }
</style>

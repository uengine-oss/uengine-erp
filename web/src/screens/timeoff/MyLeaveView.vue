<script setup lang="ts">
// A member's own leave: what they have, what they asked for, and asking. It gets its own screen because the kernel's read is
// per type and requests are closed to everyone but people staff; this reads erp_my_leave, which hands a person their own rows.
import { computed, onMounted, ref } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { onDataChanged, sendCommand } from '../../lib/commands'
import { db } from '../../lib/conn'
import { writeBlock } from '../../lib/mode'
import { ask, toast } from '../../lib/ui'
import Icon from '../../components/Icon.vue'
import LawNotice from '../docs/LawNotice.vue'
import { ATTENDANCE_LABEL, HALF_LABEL, KIND_LABEL, STATUS_COLOR, STATUS_LABEL, dateRange, fmtDays } from './fmt'

interface Balance { leave_type_id: string; name: string; tracks_balance: boolean; granted: number; used: number; pending: number; remaining: number; shortfall: number; lapsed: number; expires: string | null }
interface Request { id: string; number: string; status: string; leave_type_name: string; date_from: string; date_to: string; half_day: string | null; days: number; shortfall: number; has_reason: boolean; decided_by_name: string | null; reason: string | null; reject_reason: string | null; can_cancel: boolean }
interface Grant { id: string; kind: string; days: number; used_before: number; granted_on: string; valid_from: string; valid_to: string; rule: string; attendance_status: string; attendance_rate: number | null; flag: string | null; status: string }
interface Mine { linked: boolean; today?: string; name?: string; hire_date?: string; department_name?: string; approver?: string | null; approver_route?: string; statutory?: boolean; auto_grant?: boolean; balances?: Balance[]; grants?: Grant[]; requests?: Request[] }
interface LeaveType { id: string; name: string; allow_half_day: boolean; tracks_balance: boolean }

const data = ref<Mine | null>(null)
const types = ref<LeaveType[]>([])
const error = ref('')
const formError = ref('')
const busy = ref(false)
const form = ref({ leave_type_id: '', date_from: '', date_to: '', half_day: '', reason: '' })

const chosen = computed(() => types.value.find((t) => t.id === form.value.leave_type_id))
const canHalf = computed(() => !!chosen.value?.allow_half_day && (!form.value.date_to || form.value.date_to === form.value.date_from))
const tracked = computed(() => (data.value?.balances ?? []).filter((b) => b.tracks_balance))
const unverified = computed(() => (data.value?.grants ?? []).some((g) => g.attendance_status === 'unverified' && g.status === 'active'))

async function load() {
  error.value = ''
  try {
    data.value = await rpc<Mine>('erp_my_leave')
    const { data: rows, error: err } = await db().from('erp_records').select('id,name,state').eq('type', 'leave_type').eq('active', true).order('name')
    if (err) throw err
    types.value = (rows ?? []).map((r) => ({ id: r.id, name: r.name, allow_half_day: !!r.state.allow_half_day, tracks_balance: !!r.state.tracks_balance }))
    if (!form.value.leave_type_id) form.value.leave_type_id = types.value.find((t) => t.tracks_balance)?.id ?? types.value[0]?.id ?? ''
  } catch (e) {
    error.value = messageOf(e)
  }
}
onMounted(load)
onDataChanged(load)

async function submit() {
  if (busy.value) return
  busy.value = true
  formError.value = ''
  try {
    const payload: Record<string, unknown> = { leave_type_id: form.value.leave_type_id, date_from: form.value.date_from, date_to: form.value.date_to || form.value.date_from }
    if (canHalf.value && form.value.half_day) payload.half_day = form.value.half_day
    if (form.value.reason.trim()) payload.reason = form.value.reason.trim()
    const r = await sendCommand<{ state: { days: number } }>({ type: 'leave_request', command: 'create', payload })
    toast(`${fmtDays(r.state.days)}을 신청했습니다.`)
    form.value = { ...form.value, date_from: '', date_to: '', half_day: '', reason: '' }
    await load()
  } catch (e) {
    formError.value = messageOf(e)
  } finally {
    busy.value = false
  }
}

async function cancel(r: Request) {
  const answer = await ask({ title: '휴가 취소', message: `${r.number} (${dateRange(r.date_from, r.date_to)}) 신청을 취소할까요? 일수가 돌아옵니다.`, danger: true, confirmLabel: '휴가 취소' })
  if (!answer) return
  try {
    await sendCommand({ type: 'leave_request', id: r.id, command: 'cancel', payload: {} })
    toast('신청을 취소했습니다.')
    await load()
  } catch (e) {
    error.value = messageOf(e)
  }
}

async function eraseReason(r: Request) {
  const answer = await ask({
    title: '사유 지우기',
    message: '이 신청의 사유를 지웁니다. 되돌릴 수 없습니다.\n원장에는 지웠다는 사실과 지운 까닭만 남습니다. 까닭도 원장에 남으니 사유의 내용을 적지 마세요.',
    danger: true, reason: true, reasonRequired: true, confirmLabel: '지우기',
  })
  if (!answer) return
  try {
    await sendCommand({ type: 'leave_request', id: r.id, command: 'erase_private', payload: {}, reason: answer.reason })
    toast('사유를 지웠습니다.')
    await load()
  } catch (e) {
    error.value = messageOf(e)
  }
}
</script>

<template>
  <div class="page" data-testid="my-leave">
    <div class="page-head"><h1>내 휴가</h1></div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert" data-testid="my-leave-error"><Icon name="alert" /><span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" @click="load">다시 시도</button></div>
    <div class="page-body page-pad">
      <LawNotice kind="leave" />
      <section v-if="data && !data.linked" class="panel" data-testid="my-leave-unlinked">
        <p>이 계정에 연결된 직원이 없습니다. 인사 담당자에게 직원 정보에 ERP 구성원을 연결해 달라고 요청하세요.</p>
      </section>
      <template v-else-if="data">
        <p class="small dim" data-testid="my-leave-who">{{ data.name }} · {{ data.department_name }} · 입사 {{ data.hire_date }} · 승인: {{ data.approver ?? '인사 담당자' }}</p>
        <p v-if="data.statutory === false" class="small dim" data-testid="my-leave-off">회사가 근로기준법 제60조 적용을 껐습니다. 자동으로 부여되는 연차가 없습니다.</p>
        <section class="cards">
          <article v-for="b in tracked" :key="b.leave_type_id" class="panel card" data-testid="balance-card" :data-name="b.name">
            <h2>{{ b.name }}</h2>
            <strong class="big" data-testid="balance-remaining">{{ fmtDays(b.remaining) }}</strong>
            <dl class="small">
              <dt>부여</dt><dd data-testid="balance-granted">{{ fmtDays(b.granted) }}</dd>
              <dt>사용</dt><dd data-testid="balance-used">{{ fmtDays(b.used) }}</dd>
              <dt>승인 대기</dt><dd data-testid="balance-pending">{{ fmtDays(b.pending) }}</dd>
              <template v-if="b.expires"><dt>소멸</dt><dd data-testid="balance-expires">{{ b.expires }}</dd></template>
            </dl>
          </article>
        </section>
        <p v-if="unverified" class="small dim" data-testid="balance-unverified">출근율을 확인하지 못한 일수가 있습니다. 근태 기록이 없어 법이 정한 일수를 그대로 부여했으며, 마감된 근태가 들어오면 달라질 수 있습니다.</p>

        <section class="panel" data-testid="leave-form">
          <h2>휴가 신청</h2>
          <form @submit.prevent="submit">
            <div class="field-grid">
              <div class="field"><label class="field-label" for="lv-type">유형</label>
                <select id="lv-type" v-model="form.leave_type_id" class="input" data-testid="leave-type"><option v-for="t in types" :key="t.id" :value="t.id">{{ t.name }}</option></select></div>
              <div class="field"><label class="field-label" for="lv-from">시작일</label><input id="lv-from" v-model="form.date_from" class="input" type="date" required data-testid="leave-from" /></div>
              <div class="field"><label class="field-label" for="lv-to">끝일</label><input id="lv-to" v-model="form.date_to" class="input" type="date" :min="form.date_from" data-testid="leave-to" /></div>
              <div v-if="canHalf" class="field"><label class="field-label" for="lv-half">반차</label>
                <select id="lv-half" v-model="form.half_day" class="input" data-testid="leave-half"><option value="">하루</option><option value="am">오전 반차</option><option value="pm">오후 반차</option></select></div>
            </div>
            <div class="field"><label class="field-label" for="lv-reason">사유 <span class="muted">(적지 않아도 됩니다)</span></label>
              <textarea id="lv-reason" v-model="form.reason" class="input" rows="2" maxlength="500" data-testid="leave-reason"></textarea>
              <p class="small dim" data-testid="leave-reason-note">사유는 원장 밖에 따로 저장합니다. 나와 상사, 인사 담당자만 볼 수 있고 나중에 지울 수 있습니다. 팀 달력에는 이름과 날짜만 나옵니다. 주말과 공휴일은 일수에서 뺍니다.</p>
            </div>
            <p v-if="formError" class="err-text small" role="alert" data-testid="leave-form-error">{{ formError }}</p>
            <button type="submit" class="btn btn-primary" :disabled="busy || !!writeBlock || !form.date_from || !form.leave_type_id" data-testid="leave-submit">{{ busy ? '신청 중…' : '신청' }}</button>
          </form>
        </section>

        <section class="panel" data-testid="my-requests">
          <h2>내 신청</h2>
          <table v-if="data.requests?.length" class="tbl">
            <thead><tr><th>번호</th><th>유형</th><th>날짜</th><th class="num">일수</th><th>상태</th><th>사유</th><th></th></tr></thead>
            <tbody>
              <tr v-for="r in data.requests" :key="r.id" data-testid="my-request" :data-number="r.number">
                <td>{{ r.number }}</td>
                <td>{{ r.leave_type_name }}<span v-if="r.half_day" class="muted small"> {{ HALF_LABEL[r.half_day] }}</span></td>
                <td>{{ dateRange(r.date_from, r.date_to) }}</td>
                <td class="num" data-testid="my-request-days">{{ fmtDays(r.days) }}</td>
                <td><span class="pill" :class="`pill-${STATUS_COLOR[r.status]}`" data-testid="my-request-status">{{ STATUS_LABEL[r.status] }}</span><span v-if="r.decided_by_name" class="muted small"> {{ r.decided_by_name }}</span></td>
                <td class="small"><span v-if="r.reason" data-testid="my-request-reason">{{ r.reason }}</span><div v-if="r.reject_reason" data-testid="my-request-reject">반려: {{ r.reject_reason }}</div></td>
                <td class="acts">
                  <button v-if="r.can_cancel" type="button" class="btn btn-sm" :disabled="!!writeBlock" data-testid="my-request-cancel" @click="cancel(r)">취소</button>
                  <button v-if="r.reason || r.reject_reason" type="button" class="btn btn-sm" :disabled="!!writeBlock" data-testid="my-request-erase" @click="eraseReason(r)">사유 지우기</button>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else class="muted" data-testid="my-requests-empty">아직 신청이 없습니다.</p>
        </section>

        <section class="panel" data-testid="my-grants">
          <h2>부여 내역</h2>
          <table v-if="data.grants?.length" class="tbl">
            <thead><tr><th>부여일</th><th>종류</th><th class="num">일수</th><th>소멸일</th><th>근거</th><th>출근율</th></tr></thead>
            <tbody>
              <tr v-for="g in data.grants" :key="g.id" data-testid="my-grant">
                <td>{{ g.granted_on }}</td><td>{{ KIND_LABEL[g.kind] ?? g.kind }}</td><td class="num">{{ fmtDays(g.days) }}</td><td>{{ g.valid_to }}</td>
                <td class="small">{{ g.rule }}<div v-if="g.flag" class="err-text">{{ g.flag }}</div></td>
                <td class="small" data-testid="my-grant-attendance">{{ ATTENDANCE_LABEL[g.attendance_status] }}<template v-if="g.attendance_rate !== null && g.attendance_rate !== undefined"> ({{ Math.round(g.attendance_rate * 1000) / 10 }}%)</template></td>
              </tr>
            </tbody>
          </table>
          <p v-else class="muted">아직 부여된 일수가 없습니다.</p>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.panel { padding: 12px 14px; margin-bottom: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); max-width: 900px; }
.panel h2 { margin-bottom: 8px; }
.cards { display: flex; flex-wrap: wrap; gap: 12px; margin: 10px 0; }
.card { min-width: 190px; margin-bottom: 0; }
.big { display: block; font-size: 26px; font-weight: 650; font-variant-numeric: tabular-nums; margin-bottom: 6px; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 0; }
dt { color: var(--ink-2, #5c6370); }
dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.acts { white-space: nowrap; text-align: right; }
.acts .btn + .btn { margin-left: 4px; }
form .field { margin-bottom: 8px; }
textarea.input { width: 100%; }
</style>

<script setup lang="ts">
// A month across everyone, what stops it from closing, and closing it. Stamps go through "correct" with a reason, so the old values stay in the ledger.
import { computed, onMounted, ref, watch } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { onDataChanged, sendCommand } from '../../lib/commands'
import { writeBlock } from '../../lib/mode'
import type { Field } from '../../lib/types'
import { ask, toast } from '../../lib/ui'
import Icon from '../../components/Icon.vue'
import LawNotice from '../docs/LawNotice.vue'
import { clockTime, fmtMinutes } from './fmt'

interface Person { employee_id: string; employee_no: string; name: string; department_name: string; from: string; to: string; scheduled_days: number; worked_days: number; leave_days: number; absent_days: number; not_attended_dates: string[]; worked_minutes: number; overtime_minutes: number; weeks_over_limit: number }
interface Data { period: string; from: string; to: string; closed: boolean; closed_at: string | null; month_over: boolean; covered: boolean; people: Person[]; open_days: { id: string; name: string; date: string; check_in: string }[]; late_leave_changes: number }

const now = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())
const lastMonth = () => { const d = new Date(`${now.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7) }
const period = ref(lastMonth())
const data = ref<Data | null>(null)
const error = ref('')
const busy = ref(false)
const CORRECT_FIELDS: Field[] = [
  { name: 'check_in', label: '출근 시각', type: 'datetime' },
  { name: 'check_out', label: '퇴근 시각', type: 'datetime' },
  { name: 'break_minutes', label: '휴게(분)', type: 'integer', help: '비우면 근태 기준대로 계산합니다.' },
]
const canClose = computed(() => !!data.value && !data.value.closed && data.value.month_over && data.value.covered && data.value.open_days.length === 0)

async function load() {
  error.value = ''
  try {
    data.value = await rpc<Data>('erp_attendance_month', { p_period: period.value })
  } catch (e) {
    error.value = messageOf(e)
  }
}
onMounted(load)
onDataChanged(load)
watch(period, load)

const cleaned = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && v !== undefined && v !== ''))

async function fix(day: { id: string; name: string; date: string }) {
  const answer = await ask({ title: `${day.name} ${day.date} 정정`, message: '고친 값과 사유, 원래 값이 원장에 남습니다. 민감한 내용은 적지 마세요.', fields: CORRECT_FIELDS, reason: true, reasonRequired: true, confirmLabel: '정정' })
  if (!answer) return
  try {
    await sendCommand({ type: 'attendance_day', id: day.id, command: 'correct', payload: cleaned(answer.values), reason: answer.reason })
    toast('기록을 정정했습니다.')
    await load()
  } catch (e) {
    error.value = messageOf(e)
  }
}

async function enter(p: Person, date: string) {
  const answer = await ask({ title: `${p.name} ${date} 입력`, message: '빠진 날의 기록을 넣습니다. 사유가 원장에 남습니다. 민감한 내용은 적지 마세요.', fields: CORRECT_FIELDS, reason: true, reasonRequired: true, confirmLabel: '입력' })
  if (!answer) return
  try {
    await sendCommand({ type: 'attendance_day', command: 'correct', payload: { employee_id: p.employee_id, date, ...cleaned(answer.values) }, reason: answer.reason })
    toast('기록을 넣었습니다.')
    await load()
  } catch (e) {
    error.value = messageOf(e)
  }
}

async function close() {
  const answer = await ask({ title: `${period.value} 근태 마감`, message: '마감하면 이 달의 기록을 고칠 수 없습니다. 휴가와 급여 같은 다른 모듈이 이 결과를 받습니다. 풀려면 관리자가 되돌려야 합니다.', confirmLabel: '마감', danger: true })
  if (!answer) return
  busy.value = true
  error.value = ''
  try {
    await sendCommand({ type: 'attendance_month', command: 'close', payload: { period: period.value } })
    toast(`${period.value} 근태를 마감했습니다.`)
    await load()
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page" data-testid="attendance-month">
    <div class="page-head"><h1>월 마감</h1></div>
    <div class="toolbar">
      <input v-model="period" class="input" type="month" style="width: 160px" aria-label="달" data-testid="close-period" />
      <span v-if="data?.closed" class="pill pill-green" data-testid="close-state">마감됨 {{ clockTime(data.closed_at) }}</span>
      <button v-else type="button" class="btn btn-primary" :disabled="busy || !!writeBlock || !canClose" data-testid="close-month" @click="close">월 마감</button>
      <span v-if="data && !data.closed && !data.month_over" class="small dim" data-testid="close-too-early">달이 끝난 뒤에 마감할 수 있습니다.</span>
      <span v-else-if="data && !data.closed && !data.covered" class="small dim" data-testid="close-uncovered">근태 모듈을 켜기 전의 달은 마감할 수 없습니다.</span>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert" data-testid="close-error"><Icon name="alert" /><span class="grow">{{ error }}</span></div>
    <div class="page-body page-pad">
      <LawNotice kind="attendance" />
      <p v-if="data?.late_leave_changes" class="banner banner-warn" role="status" data-testid="close-late"><Icon name="alert" /><span class="grow">마감 뒤에 이 달의 휴가가 {{ data.late_leave_changes }}건 바뀌었습니다. 마감한 값은 그대로입니다. 고치려면 마감을 되돌리세요.</span></p>
      <section v-if="data?.open_days.length" class="panel" data-testid="close-open">
        <h2>퇴근이 빠진 기록 <span class="muted small">고쳐야 마감할 수 있습니다</span></h2>
        <ul class="plain"><li v-for="d in data.open_days" :key="d.id" data-testid="close-open-row">{{ d.name }} {{ d.date }} · 출근 {{ clockTime(d.check_in) }} <button type="button" class="btn btn-sm" :disabled="!!writeBlock" data-testid="close-fix" @click="fix(d)">정정</button></li></ul>
      </section>
      <table v-if="data?.people.length" class="tbl" data-testid="close-table">
        <thead><tr><th>사번</th><th>이름</th><th>부서</th><th>기간</th><th class="num">소정</th><th class="num">근무</th><th class="num">휴가</th><th class="num">결근</th><th class="num">근무 시간</th><th class="num">초과</th><th class="num">52시간 초과 주</th><th>빠진 날</th></tr></thead>
        <tbody>
          <tr v-for="p in data.people" :key="p.employee_id" data-testid="close-row" :data-name="p.name">
            <td>{{ p.employee_no }}</td><td>{{ p.name }}</td><td>{{ p.department_name }}</td><td class="small">{{ p.from.slice(5) }}~{{ p.to.slice(5) }}</td>
            <td class="num">{{ p.scheduled_days }}</td><td class="num">{{ p.worked_days }}</td><td class="num">{{ p.leave_days }}</td><td class="num" data-testid="close-row-absent">{{ p.absent_days }}</td>
            <td class="num">{{ fmtMinutes(p.worked_minutes) }}</td><td class="num">{{ fmtMinutes(p.overtime_minutes || '') }}</td><td class="num">{{ p.weeks_over_limit || '' }}</td>
            <td class="small missing"><button v-for="date in p.not_attended_dates.slice(0, 6)" :key="date" type="button" class="link" :disabled="!!writeBlock || !!data.closed" data-testid="close-enter" @click="enter(p, date)">{{ date.slice(5) }}</button><span v-if="p.not_attended_dates.length > 6" class="muted"> 외 {{ p.not_attended_dates.length - 6 }}일</span></td>
          </tr>
        </tbody>
      </table>
      <p v-else-if="data" class="muted">이 달에 근태 대상이 없습니다.</p>
    </div>
  </div>
</template>

<style scoped>
.panel { padding: 12px 14px; margin-bottom: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); max-width: 900px; }
.panel h2 { margin-bottom: 8px; }
.plain { margin: 0; padding: 0; list-style: none; }
.plain li { padding: 3px 0; }
.missing button { margin-right: 4px; background: none; border: 0; padding: 0; color: var(--navy-600, #24527a); cursor: pointer; text-decoration: underline; font: inherit; }
.missing button:disabled { color: inherit; text-decoration: none; cursor: default; }
</style>

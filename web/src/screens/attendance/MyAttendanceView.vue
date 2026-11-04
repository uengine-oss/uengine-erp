<script setup lang="ts">
// A member's own clock: in, out, this week against the line, this month by day. The time is the server's, so there is nothing to
// type, and days are closed to everyone but people staff at the type level, which is why this reads erp_my_attendance.
import { computed, onMounted, ref, watch } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { onDataChanged, sendCommand } from '../../lib/commands'
import { timeView, writeBlock } from '../../lib/mode'
import { toast } from '../../lib/ui'
import Icon from '../../components/Icon.vue'
import LawNotice from '../docs/LawNotice.vue'
import { DAY_COLOR, DAY_STATUS, WEEK_COLOR, WEEK_STATUS, clockTime, fmtMinutes } from './fmt'

interface Day { date: string; is_workday: boolean; check_in: string | null; check_out: string | null; worked_minutes: number | null; break_minutes: number | null; overtime_minutes: number | null; corrected: boolean | null; leave: boolean; half_day: string | null; status: string }
interface Week { week_start: string; week_end: string; worked_minutes: number; over_40_minutes: number; overtime_minutes: number; limit_minutes: number; remaining_days: number; projected_minutes: number; status: string }
interface Mine { linked: boolean; today?: string; name?: string; department_name?: string; period?: string; closed?: boolean; checked_in_today?: boolean; open_day?: { date: string; check_in: string } | null; week?: Week; days?: Day[]; totals?: { worked_minutes: number; overtime_minutes: number; absent_days: number; leave_days: number } }

const data = ref<Mine | null>(null)
const month = ref('')
const error = ref('')
const busy = ref(false)

const canIn = computed(() => !!data.value?.linked && !data.value.checked_in_today)
const canOut = computed(() => !!data.value?.open_day)

async function load() {
  error.value = ''
  try {
    data.value = await rpc<Mine>('erp_my_attendance', { p_month: month.value || null })
    if (!month.value && data.value.period) month.value = data.value.period
  } catch (e) {
    error.value = messageOf(e)
  }
}
onMounted(load)
onDataChanged(load)
watch(month, (next, prev) => { if (prev && next) void load() })

async function stamp(command: 'check_in' | 'check_out') {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await sendCommand({ type: 'attendance_day', command, payload: {} })
    toast(command === 'check_in' ? '출근을 찍었습니다.' : '퇴근을 찍었습니다.')
    await load()
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page" data-testid="my-attendance">
    <div class="page-head"><h1>내 근태</h1></div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert" data-testid="my-attendance-error"><Icon name="alert" /><span class="grow">{{ error }}</span></div>
    <div class="page-body page-pad">
      <p v-if="timeView.at" class="small dim" data-testid="now-only">지난 시점을 보는 중이어도 이 화면은 지금 기준입니다.</p>
      <LawNotice kind="attendance" />
      <section v-if="data && !data.linked" class="panel" data-testid="my-attendance-unlinked"><p>이 계정에 연결된 재직 직원이 없습니다. 인사 담당자에게 직원 정보에 ERP 구성원을 연결해 달라고 요청하세요.</p></section>
      <template v-else-if="data">
        <section class="panel stamp" data-testid="stamp-panel">
          <div>
            <p class="small dim">{{ data.name }} · {{ data.department_name }} · 오늘 {{ data.today }}</p>
            <p v-if="data.open_day" data-testid="stamp-open">{{ clockTime(data.open_day.check_in) }}에 출근을 찍었습니다.</p>
            <p v-else-if="data.checked_in_today" data-testid="stamp-done">오늘 근무를 마쳤습니다.</p>
            <p v-else data-testid="stamp-none">오늘 아직 출근을 찍지 않았습니다.</p>
          </div>
          <div class="stamp-btns">
            <button type="button" class="btn btn-primary" :disabled="busy || !!writeBlock || !canIn" data-testid="stamp-in" @click="stamp('check_in')">출근</button>
            <button type="button" class="btn btn-primary" :disabled="busy || !!writeBlock || !canOut" data-testid="stamp-out" @click="stamp('check_out')">퇴근</button>
          </div>
        </section>

        <section v-if="data.week" class="panel" data-testid="week-panel">
          <h2>이번 주 <span class="muted small">{{ data.week.week_start }} ~ {{ data.week.week_end }}</span>
            <span class="pill" :class="`pill-${WEEK_COLOR[data.week.status]}`" data-testid="week-status">{{ WEEK_STATUS[data.week.status] }}</span></h2>
          <p data-testid="week-worked">근무 {{ fmtMinutes(data.week.worked_minutes) || '0분' }}<span class="dim small"> · 40시간 초과 {{ fmtMinutes(data.week.over_40_minutes) || '0분' }} · 한도 {{ fmtMinutes(data.week.limit_minutes) }}</span></p>
          <p v-if="data.week.status === 'risk'" class="small" data-testid="week-warning">이대로면 이번 주 {{ fmtMinutes(data.week.projected_minutes) }}이 되어 한도를 넘습니다. 남은 근무일 {{ data.week.remaining_days }}일 안에 조정하세요.</p>
          <p class="small dim">휴게 시간은 찍히지 않아 제54조의 최소 시간으로 추정합니다. 다르면 인사 담당자가 정정합니다.</p>
        </section>

        <section class="panel" data-testid="month-panel">
          <h2>월별 기록</h2>
          <div class="toolbar">
            <input v-model="month" class="input" type="month" style="width: 160px" aria-label="달" data-testid="month-input" />
            <span v-if="data.closed" class="pill pill-green" data-testid="month-closed">마감됨</span>
            <span v-if="data.totals" class="small dim" data-testid="month-totals">근무 {{ fmtMinutes(data.totals.worked_minutes) || '0분' }} · 8시간 초과 {{ fmtMinutes(data.totals.overtime_minutes) || '0분' }} · 휴가 {{ data.totals.leave_days }}일 · 결근 {{ data.totals.absent_days }}일</span>
          </div>
          <table class="tbl" data-testid="month-table">
            <thead><tr><th>날짜</th><th>상태</th><th>출근</th><th>퇴근</th><th class="num">근무</th><th class="num">초과</th><th></th></tr></thead>
            <tbody>
              <tr v-for="d in data.days" :key="d.date" :class="{ off: !d.is_workday }" data-testid="month-day" :data-date="d.date" :data-status="d.status">
                <td>{{ d.date }}</td>
                <td><span v-if="DAY_STATUS[d.status]" class="pill" :class="`pill-${DAY_COLOR[d.status]}`" data-testid="month-day-status">{{ DAY_STATUS[d.status] }}</span></td>
                <td>{{ clockTime(d.check_in) }}</td><td>{{ clockTime(d.check_out) }}</td>
                <td class="num">{{ fmtMinutes(d.worked_minutes) }}</td><td class="num">{{ fmtMinutes(d.overtime_minutes || '') }}</td>
                <td class="small dim">{{ d.corrected ? '정정함' : '' }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.panel { padding: 12px 14px; margin-bottom: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); max-width: 900px; }
.panel h2 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.stamp { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.stamp-btns { display: flex; gap: 8px; }
tr.off td { background: var(--navy-50); }
</style>

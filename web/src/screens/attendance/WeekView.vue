<script setup lang="ts">
// The week across everyone, with whoever is near the line first. This is the module's own view of today; the analysis screen answers the same question from the ledger.
import { onMounted, ref, watch } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { onDataChanged } from '../../lib/commands'
import { timeView } from '../../lib/mode'
import Icon from '../../components/Icon.vue'
import LawNotice from '../docs/LawNotice.vue'
import { WEEK_COLOR, WEEK_STATUS, fmtMinutes } from './fmt'

interface Person { employee_id: string; employee_no: string; name: string; department_name: string; worked_minutes: number; over_40_minutes: number; overtime_minutes: number; projected_minutes: number; remaining_days: number; limit_minutes: number; status: string; days: { date: string; status: string; worked_minutes: number | null }[] }
interface Data { week_start: string; week_end: string; applies_limit: boolean; people: Person[] }

const on = ref(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date()))
const data = ref<Data | null>(null)
const error = ref('')

async function load() {
  error.value = ''
  try {
    data.value = await rpc<Data>('erp_attendance_week', { p_on: on.value, p_department: null })
  } catch (e) {
    error.value = messageOf(e)
  }
}
onMounted(load)
onDataChanged(load)
watch(on, load)
</script>

<template>
  <div class="page" data-testid="attendance-week">
    <div class="page-head"><h1>주간 현황</h1></div>
    <div class="toolbar">
      <label class="small dim" for="week-on">이 날이 든 주</label>
      <input id="week-on" v-model="on" class="input" type="date" style="width: 140px" data-testid="week-on" />
      <span v-if="data" class="small dim" data-testid="week-range">{{ data.week_start }} ~ {{ data.week_end }}</span>
      <router-link class="small" :to="{ name: 'attendance-overtime' }">초과근무 추이</router-link>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert"><Icon name="alert" /><span class="grow">{{ error }}</span></div>
    <div class="page-body page-pad">
      <p v-if="timeView.at" class="small dim" data-testid="now-only">지난 시점을 보는 중이어도 이 화면은 지금 기준입니다.</p>
      <LawNotice kind="attendance" />
      <p class="small dim">주 52시간은 그 주 전체 근로시간으로 봅니다(대법원 2020도15393). 하루 8시간 초과분을 합한 값은 연장근로 수당을 볼 때 쓰며 이 한도와 다릅니다.</p>
      <p v-if="data && !data.applies_limit" class="small dim" data-testid="week-off">회사가 주 52시간 확인을 껐습니다.</p>
      <table v-if="data?.people.length" class="tbl" data-testid="week-table">
        <thead><tr><th>이름</th><th>부서</th><th v-for="d in data.people[0].days" :key="d.date" class="num">{{ d.date.slice(5) }}</th><th class="num">합계</th><th class="num">40시간 초과</th><th class="num">예상</th><th>상태</th></tr></thead>
        <tbody>
          <tr v-for="p in data.people" :key="p.employee_id" data-testid="week-row" :data-name="p.name">
            <td>{{ p.name }}</td><td>{{ p.department_name }}</td>
            <td v-for="d in p.days" :key="d.date" class="num small" :class="{ absent: d.status === 'absent', leave: d.status === 'leave' }">{{ d.status === 'leave' ? '휴가' : d.status === 'absent' ? '결근' : d.status === 'missing_out' ? '누락' : fmtMinutes(d.worked_minutes) }}</td>
            <td class="num" data-testid="week-row-total">{{ fmtMinutes(p.worked_minutes) }}</td>
            <td class="num">{{ fmtMinutes(p.over_40_minutes || '') }}</td>
            <td class="num">{{ fmtMinutes(p.projected_minutes) }}</td>
            <td><span class="pill" :class="`pill-${WEEK_COLOR[p.status]}`" data-testid="week-row-status">{{ WEEK_STATUS[p.status] }}</span></td>
          </tr>
        </tbody>
      </table>
      <p v-else-if="data" class="muted">이 주에 재직 중인 직원이 없습니다.</p>
    </div>
  </div>
</template>

<style scoped>
td.absent { color: var(--red-700, #b42318); }
td.leave { color: var(--ink-2, #5c6370); }
</style>

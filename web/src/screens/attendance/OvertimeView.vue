<script setup lang="ts">
// Who may pass the line this week and how overtime has run by department. Both read only the ledger, so history survives the module being off.
import { onMounted, ref } from 'vue'
import { fetchModels, type ModelRow } from '../../lib/analytics'
import { messageOf, rpc } from '../../lib/api'
import { timeView } from '../../lib/mode'
import Icon from '../../components/Icon.vue'
import { STATE_COLOR, STATE_LABEL } from '../analytics/fmt'
import LawNotice from '../docs/LawNotice.vue'
import { WEEK_COLOR, WEEK_STATUS, fmtMinutes } from './fmt'

interface Risk { week_start: string; week_end: string; limit_minutes: number; applies_limit: boolean; totals: { over: number; risk: number; people: number }; people: { employee_id: string; name: string; department_name: string; worked_minutes: number; remaining_days: number; projected_low: number; projected_high: number; history_days: number; status: string }[] }
interface Trend { limit_minutes: number; rows: { period: string; department_id: string; department_name: string; worked_minutes: number; overtime_minutes: number; people: number; weeks_over_limit: number }[] }

const riskModel = ref<ModelRow | null>(null)
const trendModel = ref<ModelRow | null>(null)
const risk = ref<Risk | null>(null)
const trend = ref<Trend | null>(null)
const error = ref('')

async function load() {
  error.value = ''
  try {
    const models = await fetchModels()
    riskModel.value = models.find((m) => m.id === 'overtime_risk') ?? null
    trendModel.value = models.find((m) => m.id === 'stat_overtime') ?? null
    const asOf = timeView.at || null
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())
    const from = `${Number(today.slice(0, 4)) - 1}${today.slice(4, 7)}-01`
    if (riskModel.value && !['locked'].includes(riskModel.value.state)) risk.value = await rpc<Risk>('erp_overtime_risk', { p_on: null, p_as_of: asOf })
    if (trendModel.value && trendModel.value.state !== 'locked') trend.value = await rpc<Trend>('erp_overtime_trend', { p_from: from, p_to: today, p_as_of: asOf })
  } catch (e) {
    error.value = messageOf(e)
  }
}
onMounted(load)
</script>

<template>
  <div class="page" data-testid="overtime">
    <div class="page-head">
      <div class="crumbs">
        <router-link to="/analytics/models">예측·what-if</router-link><Icon class="muted" name="chevron-right" :size="12" />
        <h1>초과근무</h1>
        <span v-if="riskModel" class="pill" :class="`pill-${STATE_COLOR[riskModel.state]}`" data-testid="overtime-state">{{ STATE_LABEL[riskModel.state] }}</span>
      </div>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert"><Icon name="alert" /><span class="grow">{{ error }}</span></div>
    <div class="page-body page-pad">
      <LawNotice kind="attendance" />
      <section v-if="riskModel?.state === 'locked' && trendModel?.state === 'locked'" class="panel" data-testid="overtime-locked"><p>{{ riskModel.evidence.message }}</p></section>
      <section v-if="risk" class="panel" data-testid="overtime-risk">
        <h2>이번 주 {{ risk.week_start }} ~ {{ risk.week_end }} <span class="muted small">한도 {{ fmtMinutes(risk.limit_minutes) }}</span></h2>
        <p v-if="riskModel?.state === 'insufficient'" class="small dim" data-testid="overtime-short">{{ riskModel.evidence.message }}. 근거가 모자라 하루 8시간으로 가정한 범위만 믿을 수 있습니다.</p>
        <p data-testid="overtime-counts">넘긴 사람 {{ risk.totals.over }}명, 넘길 위험 {{ risk.totals.risk }}명 / {{ risk.totals.people }}명</p>
        <table v-if="risk.people.length" class="tbl" data-testid="overtime-risk-table">
          <thead><tr><th>이름</th><th>부서</th><th class="num">지금까지</th><th class="num">남은 근무일</th><th>주말까지 예상(80% 구간)</th><th class="num">근거(일)</th><th>상태</th></tr></thead>
          <tbody><tr v-for="p in risk.people" :key="p.employee_id" data-testid="overtime-risk-row" :data-name="p.name"><td>{{ p.name }}</td><td>{{ p.department_name }}</td><td class="num">{{ fmtMinutes(p.worked_minutes) }}</td><td class="num">{{ p.remaining_days }}</td><td>{{ fmtMinutes(p.projected_low) }} ~ {{ fmtMinutes(p.projected_high) }}</td><td class="num">{{ p.history_days }}</td><td><span class="pill" :class="`pill-${WEEK_COLOR[p.status]}`" data-testid="overtime-risk-status">{{ WEEK_STATUS[p.status] }}</span></td></tr></tbody>
        </table>
      </section>
      <section v-if="trend" class="panel" data-testid="overtime-trend">
        <h2>부서별 초과근무 추이 <span class="muted small">최근 1년. 하루 8시간을 넘긴 시간</span></h2>
        <p v-if="trendModel?.state === 'insufficient'" class="small dim" data-testid="overtime-trend-short">{{ trendModel.evidence.message }}. 추이를 말하기에 아직 짧습니다.</p>
        <p v-if="trendModel?.stale_modules?.length" class="small dim">{{ trendModel.evidence.message }}</p>
        <table v-if="trend.rows.length" class="tbl" data-testid="overtime-trend-table">
          <thead><tr><th>달</th><th>부서</th><th class="num">인원</th><th class="num">근무</th><th class="num">초과</th><th class="num">52시간 초과 주</th></tr></thead>
          <tbody><tr v-for="r in trend.rows" :key="`${r.period}-${r.department_id}`" data-testid="overtime-trend-row"><td>{{ r.period }}</td><td>{{ r.department_name }}</td><td class="num">{{ r.people }}</td><td class="num">{{ fmtMinutes(r.worked_minutes) }}</td><td class="num">{{ fmtMinutes(r.overtime_minutes) }}</td><td class="num">{{ r.weeks_over_limit || '' }}</td></tr></tbody>
        </table>
      </section>
    </div>
  </div>
</template>

<style scoped>
.crumbs { display: flex; align-items: center; gap: 6px; }
.panel { padding: 12px 14px; margin-bottom: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); max-width: 980px; }
.panel h2 { margin-bottom: 8px; }
</style>

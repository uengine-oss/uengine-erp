<script setup lang="ts">
// How long tasks really take, which projects are running out of time, and hours against attendance when there are attendance events.
// All from the ledger (M8). What it cannot know it says, rather than a number.
import { onMounted, ref, watch } from 'vue'
import { fetchModels, type ModelRow } from '../../lib/analytics'
import { messageOf, rpc } from '../../lib/api'
import { fmtDay, fmtNumber } from '../../lib/format'
import { timeView } from '../../lib/mode'
import Icon from '../../components/Icon.vue'
import { STATE_COLOR, STATE_LABEL } from '../analytics/fmt'

interface Effort { tasks: number; done: number; measured: number; need: number; median_ratio: number | null; p10_ratio: number | null; p90_ratio: number | null; planned: number; logged: number; median_days: number | null; by_project: { project_id: string; name: string; tasks: number; planned: number; logged: number; ratio: number | null }[] }
interface Risk { ready: boolean; measured: number; need: number; rows: { id: string; number: string; name: string; due: string | null; days_left: number | null; open_tasks: number; planned_left: number; unplanned: number; per_day: number | null; days_mid: number | null; days_hi: number | null; risk: string }[] }
interface Compare { available: boolean; days?: number; matched?: number; rows: { employee_id: string; name: string; date: string; logged: number; worked: number | null; problem: string }[] }

const RISK: Record<string, { label: string; color: string }> = {
  overdue: { label: '납기 지남', color: 'red' }, late: { label: '늦을 것', color: 'red' }, at_risk: { label: '늦을 수 있음', color: 'orange' }, ok: { label: '맞출 것', color: 'green' },
  unknown: { label: '모름', color: 'gray' }, no_date: { label: '납기 없음', color: 'gray' },
}
const effort = ref<Effort | null>(null)
const risk = ref<Risk | null>(null)
const compare = ref<Compare | null>(null)
const models = ref<ModelRow[]>([])
const error = ref('')
let seq = 0
const model = (id: string) => models.value.find((m) => m.id === id) ?? null
const ratio = (v: number | null | undefined) => (v === null || v === undefined ? '' : `${Math.round(v * 100)}%`)

async function load() {
  const my = ++seq
  error.value = ''
  try {
    const asOf = timeView.at || null
    const end = timeView.date || fmtDay(new Date().toISOString())
    const start = `${end.slice(0, 7)}-01`
    const [e, r, c, m] = await Promise.all([
      rpc<Effort>('erp_project_effort', { p_as_of: asOf }),
      rpc<Risk>('erp_project_risk', { p_on: null, p_as_of: asOf }),
      rpc<Compare>('erp_time_vs_attendance', { p_from: start, p_to: end, p_as_of: asOf }),
      fetchModels(),
    ])
    if (my !== seq) return
    effort.value = e
    risk.value = r
    compare.value = c
    models.value = m
  } catch (e) {
    if (my === seq) error.value = messageOf(e)
  }
}
onMounted(load)
watch(() => timeView.at, load)
</script>

<template>
  <div class="page" data-testid="project-analysis">
    <div class="page-head">
      <div class="crumbs">
        <router-link to="/analytics/models">예측·what-if</router-link><Icon class="muted" name="chevron-right" :size="12" />
        <h1>프로젝트 분석</h1>
      </div>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert"><Icon name="alert" /><span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" @click="load">다시 시도</button></div>
    <div class="page-body page-pad">
      <section v-if="effort" class="panel" data-testid="project-effort">
        <h2>작업 소요 실측 <span v-if="model('project_effort')" class="pill" :class="`pill-${STATE_COLOR[model('project_effort')!.state]}`" data-testid="project-effort-state">{{ STATE_LABEL[model('project_effort')!.state] }}</span></h2>
        <p class="muted small">전체 작업 {{ effort.tasks }}건, 완료 {{ effort.done }}건, 그중 계획과 기록이 모두 있는 작업 {{ effort.measured }}건</p>
        <p v-if="effort.measured >= effort.need" class="headline" data-testid="project-effort-ratio"><strong>계획의 {{ ratio(effort.median_ratio) }}</strong> <span class="muted small">중앙값. 80% 구간 {{ ratio(effort.p10_ratio) }} ~ {{ ratio(effort.p90_ratio) }}<template v-if="effort.median_days !== null">. 시작부터 완료까지 중앙값 {{ effort.median_days }}일</template></span></p>
        <p v-else class="small dim" data-testid="project-effort-short">{{ model('project_effort')?.evidence.message }}. 비율을 말하기에 아직 적습니다.</p>
        <table v-if="effort.by_project.length" class="tbl" data-testid="project-effort-table">
          <thead><tr><th>프로젝트</th><th class="num">완료 작업</th><th class="num">계획</th><th class="num">기록</th><th class="num">기록 / 계획</th></tr></thead>
          <tbody><tr v-for="p in effort.by_project" :key="p.project_id" data-testid="project-effort-row"><td>{{ p.name }}</td><td class="num">{{ p.tasks }}</td><td class="num">{{ fmtNumber(p.planned) }}</td><td class="num">{{ fmtNumber(p.logged) }}</td><td class="num">{{ ratio(p.ratio) }}</td></tr></tbody>
        </table>
      </section>

      <section v-if="risk" class="panel" data-testid="project-risk">
        <h2>납기 지연 위험 <span v-if="model('project_risk')" class="pill" :class="`pill-${STATE_COLOR[model('project_risk')!.state]}`" data-testid="project-risk-state">{{ STATE_LABEL[model('project_risk')!.state] }}</span></h2>
        <p v-if="!risk.ready" class="small dim" data-testid="project-risk-short">실측이 {{ risk.need }}건은 있어야 남은 시간을 말할 수 있습니다(지금 {{ risk.measured }}건). 지금은 지난 납기만 말하고 나머지는 모른다고 합니다.</p>
        <table v-if="risk.rows.length" class="tbl" data-testid="project-risk-table">
          <thead><tr><th>프로젝트</th><th>납기</th><th class="num">남은 날</th><th class="num">남은 작업</th><th class="num">최근 하루 시간</th><th class="num">완료까지(중앙값~나쁠 때)</th><th>판단</th></tr></thead>
          <tbody>
            <tr v-for="r in risk.rows" :key="r.id" data-testid="project-risk-row" :data-risk="r.risk">
              <td><router-link :to="{ name: 'record', params: { type: 'project', id: r.id } }">{{ r.name }}</router-link></td><td>{{ r.due }}</td><td class="num">{{ r.days_left }}</td><td class="num">{{ r.open_tasks }}<template v-if="r.unplanned"> (계획 없음 {{ r.unplanned }})</template></td><td class="num">{{ r.per_day ?? '' }}</td>
              <td class="num"><template v-if="r.days_mid !== null">{{ r.days_mid }}~{{ r.days_hi }}일</template></td>
              <td><span class="pill" :class="`pill-${RISK[r.risk]?.color ?? 'gray'}`" data-testid="project-risk-label">{{ RISK[r.risk]?.label ?? r.risk }}</span></td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted" data-testid="project-risk-empty">진행 중인 프로젝트가 없습니다.</p>
      </section>

      <section v-if="compare" class="panel" data-testid="project-attendance">
        <h2>근태와 대조 <span class="muted small">이번 달</span></h2>
        <p v-if="!compare.available" class="muted small" data-testid="project-attendance-off">근태 이벤트가 없어 대조하지 않습니다. 근태 모듈을 쓰고, 볼 권한(인사, 관리자)이 있어야 합니다.</p>
        <template v-else>
          <p class="muted small" data-testid="project-attendance-summary">시간을 기록한 {{ compare.days }}일 중 {{ compare.matched }}일이 근태 안에 있습니다. 나머지만 아래에 있습니다.</p>
          <table v-if="compare.rows.length" class="tbl" data-testid="project-attendance-table">
            <thead><tr><th>날짜</th><th>사람</th><th class="num">기록</th><th class="num">근무</th><th>내용</th></tr></thead>
            <tbody><tr v-for="c in compare.rows" :key="`${c.employee_id}${c.date}`" data-testid="project-attendance-row"><td>{{ c.date }}</td><td>{{ c.name }}</td><td class="num">{{ fmtNumber(c.logged) }}</td><td class="num">{{ c.worked === null ? '' : fmtNumber(c.worked) }}</td><td>{{ c.problem === 'over' ? '근무보다 많음' : '근태 기록 없음' }}</td></tr></tbody>
          </table>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.crumbs { display: flex; align-items: center; gap: 6px; }
.panel { padding: 12px 14px; margin-bottom: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); max-width: 960px; }
.panel h2 { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.headline { margin: 8px 0; }
.headline strong { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; }
</style>

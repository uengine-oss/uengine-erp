<script setup lang="ts">
// Every model and whether it can answer today. Each says plainly what it is waiting for.
import { computed, onMounted, ref, watch } from 'vue'
import { fetchModels, type ModelRow } from '../../lib/analytics'
import { messageOf } from '../../lib/api'
import { timeView } from '../../lib/mode'
import { onLedgerEvent } from '../../lib/realtime'
import { isAdmin } from '../../lib/session'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'
import { STATE_COLOR, STATE_LABEL, haveOfNeed } from './fmt'

const models = ref<ModelRow[]>([])
const loading = ref(true)
const error = ref('')
let seq = 0

async function load() {
  const my = ++seq
  error.value = ''
  try {
    const rows = await fetchModels()
    if (my === seq) models.value = rows
  } catch (e) {
    if (my !== seq) return
    error.value = messageOf(e)
    models.value = []
  } finally {
    if (my === seq) loading.value = false
  }
}
onMounted(load)
watch(() => timeView.at, load)

let timer: ReturnType<typeof setTimeout> | undefined
onLedgerEvent(() => { clearTimeout(timer); timer = setTimeout(load, 500) })

const GROUPS = [
  { kind: 'stat', title: '통계', note: '있는 그대로의 기록입니다.' },
  { kind: 'forecast', title: '예측', note: '결과와 80% 구간, 근거를 함께 보여 줍니다.' },
  { kind: 'whatif', title: 'what-if', note: '바꾸기 전에 시험해 봅니다. 원장을 바꾸지 않습니다.' },
]
const grouped = computed(() => GROUPS.map((g) => ({ ...g, rows: models.value.filter((m) => m.kind === g.kind) })))
const counts = computed(() => ['ready', 'insufficient', 'locked'].map((s) => ({ state: s, n: models.value.filter((m) => m.state === s).length })))

const routeOf = (m: ModelRow) => (m.id === 'stat_sales' ? { name: 'stats' } : m.id === 'quote_conversion' ? { name: 'quotes' } : m.id === 'stat_headcount' ? { name: 'hr-headcount' } : m.id === 'payroll_cost' || m.id === 'whatif_headcount' ? { name: 'payroll-outlook' } : { name: 'model', params: { id: m.id } })
const percent = (m: ModelRow) => (m.evidence.need > 0 ? Math.min(100, Math.round((m.evidence.have / m.evidence.need) * 100)) : 0)
</script>

<template>
  <div class="page" data-testid="analytics-home">
    <div class="page-head">
      <h1>예측·what-if</h1>
      <span class="muted small head-note">모듈이 늘고 이벤트가 쌓일수록 열립니다. 근거가 모자라면 숫자를 내지 않습니다.</span>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert" data-testid="models-error">
      <Icon name="alert" /><span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" data-testid="models-retry" @click="load">다시 시도</button>
    </div>
    <div class="page-body page-pad">
      <EmptyState v-if="!loading && !error && !models.length" title="표시할 모델이 없습니다" text="이 회사의 구성원만 볼 수 있습니다." />
      <p v-if="models.length" class="summary small dim" data-testid="models-summary">
        <template v-for="c in counts" :key="c.state"><span class="pill" :class="`pill-${STATE_COLOR[c.state]}`">{{ STATE_LABEL[c.state] }} {{ c.n }}</span>{{ ' ' }}</template>
      </p>
      <section v-for="g in grouped" v-show="g.rows.length" :key="g.kind" class="group" :data-kind="g.kind">
        <h2>{{ g.title }} <span class="muted small note">{{ g.note }}</span></h2>
        <div class="models">
          <article v-for="m in g.rows" :key="m.id" class="model" :class="`state-${m.state}`" data-testid="model-card" :data-id="m.id" :data-state="m.state">
            <header><strong>{{ m.label }}</strong><span class="pill" :class="`pill-${STATE_COLOR[m.state]}`" data-testid="model-state">{{ STATE_LABEL[m.state] }}</span></header>
            <p class="small dim" data-testid="model-message">{{ m.evidence.message }}</p>
            <div v-if="m.state === 'insufficient' && m.evidence.need > 0" class="row">
              <div class="meter grow" role="progressbar" :aria-valuenow="percent(m)" aria-valuemin="0" aria-valuemax="100" :aria-label="`${m.label} 근거`"><i :style="{ width: `${percent(m)}%` }"></i></div>
              <span class="small muted nowrap">{{ haveOfNeed(m.evidence.have, m.evidence.need, m.evidence.unit) }}</span>
            </div>
            <footer>
              <template v-if="m.state === 'locked'">
                <span v-if="m.forbidden" class="small muted"><Icon name="lock" :size="12" /> 필요한 역할이 없습니다</span>
                <router-link v-else-if="isAdmin()" class="btn btn-sm" to="/settings/modules" data-testid="model-open-modules"><Icon name="lock" :size="12" />모듈 화면으로</router-link>
                <span v-else class="small muted"><Icon name="lock" :size="12" /> 관리자에게 모듈을 켜 달라고 요청하세요</span>
              </template>
              <router-link v-else-if="m.state === 'insufficient'" class="btn btn-sm" :to="routeOf(m)" data-testid="model-open">무엇이 더 필요한지 보기</router-link>
              <router-link v-else class="btn btn-sm btn-primary" :to="routeOf(m)" data-testid="model-open">열기</router-link>
            </footer>
          </article>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.summary { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 12px; }
.group { margin-bottom: 18px; }
.group h2 { margin-bottom: 8px; }
.note { font-weight: 450; margin-left: 4px; }
.models { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; align-items: stretch; }
.model { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
.model header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.model p { flex: 1 1 auto; }
.model footer { display: flex; align-items: center; gap: 6px; min-height: 24px; }
.state-locked strong { color: var(--text-2); }
@media (max-width: 720px) {
  .models { grid-template-columns: minmax(0, 1fr); }
  .head-note { display: none; }
}
</style>

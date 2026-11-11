<script setup lang="ts">
// How long each machine runs between failures, how long it takes to bring back, when the next failure is due at that pace, and the
// hours it stood still each month. All from the ledger (M8): nothing here is kept between visits. Below three failures the next one is
// not guessed. The button asks the preventive plans now instead of waiting for the night's run.
import { computed, onMounted, ref, watch } from 'vue'
import { fetchModels, type ModelRow } from '../../lib/analytics'
import { messageOf, rpc } from '../../lib/api'
import { onDataChanged } from '../../lib/commands'
import { fmtDateTime, fmtNumber } from '../../lib/format'
import { timeView, writeBlock } from '../../lib/mode'
import { hasRole } from '../../lib/session'
import { toast } from '../../lib/ui'
import Icon from '../../components/Icon.vue'
import { STATE_COLOR, STATE_LABEL } from '../analytics/fmt'

interface Machine {
  id: string; number: string; name: string; state: string; failures: number; repairs: number; open: number; preventive_done: number
  run_hours: number; downtime_hours: number; mtbf_hours: number | null; mttr_hours: number | null; work_hours: number | null
  availability: number | null; last_failure_at: string | null; next_failure_at: string | null; down_now: boolean; ready: boolean
}
interface Month { equipment_id: string; month: string; hours: number }
interface Reliability { as_of: string; need: number; equipment: Machine[]; months: Month[] }

const data = ref<Reliability | null>(null)
const models = ref<ModelRow[]>([])
const error = ref('')
const running = ref(false)
let seq = 0

const card = computed(() => models.value.find((m) => m.id === 'maintenance_reliability') ?? null)
const canRun = computed(() => !writeBlock.value && hasRole(['maintenance']))
const hours = (v: number | null | undefined) => (v === null || v === undefined ? '-' : `${fmtNumber(v)}시간`)
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '-' : `${(v * 100).toFixed(1)}%`)

// The last twelve months that had any standing still, oldest first, and each machine's hours in them.
const months = computed(() => [...new Set((data.value?.months ?? []).map((m) => m.month))].sort().slice(-12))
const peak = computed(() => Math.max(1, ...(data.value?.months ?? []).map((m) => Number(m.hours))))
const hoursIn = (id: string, month: string) => Number((data.value?.months ?? []).find((m) => m.equipment_id === id && m.month === month)?.hours ?? 0)

async function load() {
  const my = ++seq
  error.value = ''
  try {
    const asOf = timeView.at || null
    const [r, m] = await Promise.all([rpc<Reliability>('erp_maintenance_reliability', { p_equipment_id: null, p_as_of: asOf }), fetchModels()])
    if (my !== seq) return
    data.value = r
    models.value = m
  } catch (e) {
    if (my === seq) error.value = messageOf(e)
  }
}
onMounted(load)
watch(() => timeView.at, load)
onDataChanged(() => { void load() })

async function runPlans() {
  running.value = true
  error.value = ''
  try {
    const r = await rpc<{ created: number; requests: { number: string }[] }>('erp_maintenance_run', {})
    toast(r.created ? `예방 보전 요청 ${r.created}건을 만들었습니다: ${r.requests.map((x) => x.number).join(', ')}` : '지금 만들 예방 보전 요청이 없습니다.')
    await load()
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    running.value = false
  }
}
</script>

<template>
  <div class="page" data-testid="maintenance-reliability">
    <div class="page-head">
      <div class="crumbs">
        <router-link to="/analytics/models">예측·what-if</router-link><Icon class="muted" name="chevron-right" :size="12" />
        <h1>설비 신뢰도</h1>
      </div>
      <button v-if="canRun" type="button" class="btn" :disabled="running" data-testid="maintenance-run" @click="runPlans">{{ running ? '확인 중…' : '예방 보전 계획 지금 확인' }}</button>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert"><Icon name="alert" /><span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" @click="load">다시 시도</button></div>
    <div class="page-body page-pad">
      <section v-if="data" class="panel" data-testid="reliability-table">
        <h2>고장 간격과 수리 시간 <span v-if="card" class="pill" :class="`pill-${STATE_COLOR[card.state]}`" data-testid="reliability-state">{{ STATE_LABEL[card.state] }}</span></h2>
        <p class="muted small">고장 간격(MTBF)은 멈추지 않고 돈 시간을 고장 수로 나눈 값, 수리 시간(MTTR)은 고장부터 다시 돌기까지의 평균입니다. 원장에 남은 보전 요청으로 셉니다. 고장이 {{ data.need }}번은 있어야 다음 고장을 짐작합니다.</p>
        <p v-if="card && card.state !== 'ready'" class="small dim" data-testid="reliability-short">{{ card.evidence.message }}</p>
        <table v-if="data.equipment.length" class="tbl">
          <thead><tr><th>설비</th><th class="num">고장</th><th class="num">고장 간격</th><th class="num">수리 시간</th><th class="num">작업 시간</th><th class="num">가동률</th><th>마지막 고장</th><th>다음 고장 예상</th></tr></thead>
          <tbody>
            <tr v-for="m in data.equipment" :key="m.id" data-testid="reliability-row" :data-number="m.number">
              <td><router-link :to="{ name: 'record', params: { type: 'equipment', id: m.id } }">{{ m.name }}</router-link> <span class="muted small">{{ m.number }}</span>
                <span v-if="m.down_now" class="pill pill-amber" data-testid="reliability-down">보전 중</span><span v-if="m.state === 'scrapped'" class="pill pill-gray">폐기</span></td>
              <td class="num">{{ m.failures }}</td>
              <td class="num" data-testid="reliability-mtbf">{{ hours(m.mtbf_hours) }}</td>
              <td class="num" data-testid="reliability-mttr">{{ hours(m.mttr_hours) }}</td>
              <td class="num">{{ hours(m.work_hours) }}</td>
              <td class="num">{{ pct(m.availability) }}</td>
              <td>{{ m.last_failure_at ? fmtDateTime(m.last_failure_at).slice(0, 16) : '-' }}</td>
              <td data-testid="reliability-next">
                <template v-if="m.next_failure_at">{{ fmtDateTime(m.next_failure_at).slice(0, 10) }}</template>
                <span v-else-if="m.down_now" class="muted small">수리 중</span>
                <span v-else-if="!m.ready" class="muted small">고장 {{ data.need }}번부터</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted" data-testid="reliability-empty">등록한 설비가 없습니다.</p>
      </section>

      <section v-if="data && months.length" class="panel" data-testid="downtime-months">
        <h2>달마다 멈춘 시간</h2>
        <p class="muted small">고장 수리와 예방 점검으로 설비가 멈춰 있던 시간입니다. 두 요청이 겹친 시간은 한 번만 셉니다. 달을 넘긴 정지는 달마다 나눕니다.</p>
        <table class="tbl">
          <thead><tr><th>설비</th><th v-for="mo in months" :key="mo" class="num">{{ mo }}</th></tr></thead>
          <tbody>
            <tr v-for="m in data.equipment.filter((x) => months.some((mo) => hoursIn(x.id, mo) > 0))" :key="m.id" data-testid="downtime-row">
              <td>{{ m.name }}</td>
              <td v-for="mo in months" :key="mo" class="num">
                <div class="cell"><span class="bar" :style="{ width: `${Math.round((hoursIn(m.id, mo) / peak) * 100)}%` }" /><span>{{ hoursIn(m.id, mo) ? fmtNumber(hoursIn(m.id, mo)) : '' }}</span></div>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  </div>
</template>

<style scoped>
.crumbs { display: flex; align-items: center; gap: 6px; }
.page-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.panel { padding: 12px 14px; margin-bottom: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); max-width: 1080px; }
.panel h2 { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.pill { margin-left: 4px; }
.cell { position: relative; display: flex; justify-content: flex-end; min-width: 56px; }
.cell .bar { position: absolute; left: 0; top: 2px; bottom: 2px; background: var(--amber-100, #fde7c2); border-radius: 2px; }
.cell span:last-child { position: relative; }
</style>

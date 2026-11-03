<script setup lang="ts">
// Approved claims by month and department. Everything comes from the ledger (M8), so this still answers after the module is off.
import { computed, onMounted, ref, watch } from 'vue'
import { fetchModels, type ModelRow } from '../../lib/analytics'
import { messageOf, rpc } from '../../lib/api'
import { fmtDay, fmtMoney } from '../../lib/format'
import { timeView } from '../../lib/mode'
import Icon from '../../components/Icon.vue'
import { STATE_COLOR, STATE_LABEL } from '../analytics/fmt'

interface Row { period: string; department_id: string | null; department_name: string; amount: number; claims: number }
interface Trend { rows: Row[]; total: number; claims: number }

const end = () => timeView.date || fmtDay(new Date().toISOString())
const from = ref(`${Number(end().slice(0, 4)) - 1}${end().slice(4, 7)}-01`)
const to = ref(end())
const data = ref<Trend | null>(null)
const model = ref<ModelRow | null>(null)
const error = ref('')
let seq = 0

async function load() {
  if (!from.value || !to.value) return
  const my = ++seq
  error.value = ''
  try {
    const [trend, models] = await Promise.all([
      rpc<Trend>('erp_expense_trend', { p_from: from.value, p_to: to.value, p_as_of: timeView.at || null }),
      fetchModels(),
    ])
    if (my !== seq) return
    data.value = trend
    model.value = models.find((m) => m.id === 'stat_expense') ?? null
  } catch (e) {
    if (my !== seq) return
    data.value = null
    error.value = messageOf(e)
  }
}
onMounted(load)
watch([from, to], load)
watch(() => timeView.at, () => { to.value = end(); void load() })

const ready = computed(() => model.value?.state === 'ready')
const locked = computed(() => model.value?.state === 'locked')
const departments = computed(() => [...new Set((data.value?.rows ?? []).map((r) => r.department_name))].sort())
const months = computed(() => [...new Set((data.value?.rows ?? []).map((r) => r.period))].sort().reverse())
const cell = (period: string, dept: string) => (data.value?.rows ?? []).filter((r) => r.period === period && r.department_name === dept).reduce((n, r) => n + Number(r.amount), 0)
const monthSum = (period: string) => (data.value?.rows ?? []).filter((r) => r.period === period).reduce((n, r) => n + Number(r.amount), 0)
const deptSum = (dept: string) => (data.value?.rows ?? []).filter((r) => r.department_name === dept).reduce((n, r) => n + Number(r.amount), 0)
</script>

<template>
  <div class="page" data-testid="expense-trend">
    <div class="page-head">
      <div class="crumbs">
        <router-link to="/analytics/models">예측·what-if</router-link><Icon class="muted" name="chevron-right" :size="12" />
        <h1>부서별 경비 추이</h1>
        <span v-if="model" class="pill" :class="`pill-${STATE_COLOR[model.state]}`" data-testid="expense-trend-state">{{ STATE_LABEL[model.state] }}</span>
      </div>
    </div>
    <div class="toolbar">
      <label class="small dim" for="trend-from">지출일</label>
      <input id="trend-from" v-model="from" class="input" type="date" style="width: 140px" data-testid="expense-trend-from" />
      <span class="muted">~</span>
      <input v-model="to" class="input" type="date" style="width: 140px" aria-label="끝 날짜" data-testid="expense-trend-to" />
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert"><Icon name="alert" /><span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" @click="load">다시 시도</button></div>
    <div class="page-body page-pad">
      <section v-if="locked" class="panel" data-testid="expense-trend-locked"><p>{{ model?.evidence.message }}</p></section>
      <template v-else-if="data">
        <p v-if="model?.stale_modules?.length" class="small dim" data-testid="expense-trend-stale">{{ model.evidence.message }}</p>
        <section class="panel">
          <div class="headline"><strong data-testid="expense-trend-total">{{ fmtMoney(data.total) }}</strong><span class="muted small">승인한 경비 {{ data.claims }}건. 취소한 경비는 빼고 셉니다. 부서는 승인할 때의 부서입니다.</span></div>
          <p v-if="!ready" class="muted small" data-testid="expense-trend-short">{{ model?.evidence.message }}. 금액은 사실이지만 추이를 말하기에는 아직 짧습니다.</p>
          <table v-if="months.length" class="tbl" data-testid="expense-trend-table">
            <thead><tr><th>달</th><th v-for="d in departments" :key="d" class="num">{{ d }}</th><th class="num">합계</th></tr></thead>
            <tbody>
              <tr v-for="m in months" :key="m" data-testid="expense-trend-month"><td>{{ m }}</td><td v-for="d in departments" :key="d" class="num">{{ cell(m, d) ? fmtMoney(cell(m, d)) : '' }}</td><td class="num">{{ fmtMoney(monthSum(m)) }}</td></tr>
            </tbody>
            <tfoot><tr><th>합계</th><th v-for="d in departments" :key="d" class="num">{{ fmtMoney(deptSum(d)) }}</th><th class="num">{{ fmtMoney(data.total) }}</th></tr></tfoot>
          </table>
          <p v-else class="muted" data-testid="expense-trend-empty">이 기간에 승인한 경비가 없습니다.</p>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.crumbs { display: flex; align-items: center; gap: 6px; }
.panel { padding: 12px 14px; margin-bottom: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); max-width: 960px; }
.headline { display: flex; align-items: baseline; flex-wrap: wrap; gap: 10px; margin-bottom: 10px; }
.headline strong { font-size: 26px; font-weight: 650; font-variant-numeric: tabular-nums; }
</style>

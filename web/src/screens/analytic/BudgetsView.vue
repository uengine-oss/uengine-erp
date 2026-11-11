<script setup lang="ts">
// Every confirmed budget with plan against actuals, and one opened line by line. Budgets are written on their own form.
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { messageOf, rpc } from '../../lib/api'
import { onDataChanged } from '../../lib/commands'
import { fmtMoney } from '../../lib/format'
import { timeView } from '../../lib/mode'
import Icon from '../../components/Icon.vue'
import BudgetTable, { type BudgetRow } from './BudgetTable.vue'

interface Side { planned: number; actual: number }
interface Summary { id: string; number: string; name: string; date_from: string; date_to: string; state: string; revision: number; income: Side; expense: Side; over_lines: number }
interface Report extends Summary { rows: BudgetRow[] }

const route = useRoute()
const router = useRouter()
const list = ref<Summary[]>([])
const picked = ref(String(route.query.budget ?? ''))
const detail = ref<Report | null>(null)
const error = ref('')
let seq = 0

const current = computed(() => list.value.find((b) => b.id === picked.value) ?? null)

async function load() {
  const my = ++seq
  error.value = ''
  try {
    const at = timeView.at || null
    const l = await rpc<Summary[]>('erp_budget_overview', { p_at: at })
    if (!picked.value && l.length) picked.value = l[0].id
    const d = picked.value ? await rpc<Report>('erp_budget_report', { p_budget: picked.value, p_at: at }) : null
    if (my !== seq) return
    list.value = l
    detail.value = d
  } catch (e) {
    if (my === seq) error.value = messageOf(e)
  }
}
watch(picked, () => { void router.replace({ query: picked.value ? { budget: picked.value } : {} }); void load() })
onMounted(load)
watch(() => timeView.at, load)
onDataChanged(() => { void load() })
</script>

<template>
  <div class="page" data-testid="budget-overview">
    <div class="page-head">
      <h1>예산 대비 실적</h1>
      <router-link class="btn btn-sm" :to="{ name: 'list', params: { type: 'budget' } }">예산 목록</router-link>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert"><Icon name="alert" /><span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" @click="load">다시 시도</button></div>
    <div class="page-body page-pad">
      <p class="muted small">확정했거나 마감한 예산입니다. 실적은 게시한 문서가 분석 계정에 나눈 금액이고, 비용이 계획을 넘으면 초과로 표시합니다.</p>
      <table class="tbl" data-testid="budget-list">
        <thead><tr><th>예산</th><th>기간</th><th class="num">변경</th><th class="num">매출 계획</th><th class="num">매출 실적</th><th class="num">비용 계획</th><th class="num">비용 실적</th><th class="num">초과 줄</th></tr></thead>
        <tbody>
          <tr v-for="b in list" :key="b.id" class="clickable" :class="{ picked: b.id === picked }" data-testid="budget-list-row" tabindex="0" @click="picked = b.id" @keydown.enter="picked = b.id">
            <td>{{ b.name }} <span class="muted small">{{ b.number }}</span></td><td class="small">{{ b.date_from }} ~ {{ b.date_to }}</td><td class="num">{{ b.revision }}차</td>
            <td class="num">{{ fmtMoney(b.income.planned) }}</td><td class="num">{{ fmtMoney(b.income.actual) }}</td>
            <td class="num">{{ fmtMoney(b.expense.planned) }}</td><td class="num">{{ fmtMoney(b.expense.actual) }}</td>
            <td class="num" :class="{ 'err-text': b.over_lines > 0 }">{{ b.over_lines }}</td>
          </tr>
          <tr v-if="!list.length"><td colspan="8" class="muted">확정한 예산이 없습니다. 예산을 만들고 확정하세요.</td></tr>
        </tbody>
      </table>
      <section v-if="detail && current" class="panel" data-testid="budget-detail">
        <h2>{{ current.name }} <router-link class="small" :to="{ name: 'record', params: { type: 'budget', id: current.id } }">예산 열기</router-link></h2>
        <BudgetTable :rows="detail.rows" />
      </section>
    </div>
  </div>
</template>

<style scoped>
.clickable { cursor: pointer; }
.clickable:hover td { background: var(--ink-50); }
tr.picked td { background: var(--navy-50, #eef3fb); }
.panel { padding: 12px 14px; margin-top: 14px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
.panel h2 { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; }
</style>

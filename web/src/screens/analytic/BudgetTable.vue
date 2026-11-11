<script setup lang="ts">
// Plan against actuals, one budget line per row. The figures are the database's; this only lays them out.
import { fmtMoney } from '../../lib/format'
import NumberInput from '../../components/NumberInput.vue'

export interface BudgetRow {
  line_id: string; analytic_account_id: string; analytic_account_name: string | null; analytic_account_code: string | null
  side: 'income' | 'expense'; month: string | null; account_code_from: string | null; account_code_to: string | null
  from: string; to: string; planned: number; actual: number; remaining: number; achieved: number | null; over: boolean; note: string | null
}

defineProps<{ rows: BudgetRow[]; edit?: Record<string, number | null> | null }>()
const emit = defineEmits<{ planned: [lineId: string, value: number | null] }>()
const bar = (r: BudgetRow) => `${Math.min(100, Math.max(0, r.achieved ?? (r.actual > 0 ? 100 : 0)))}%`
</script>

<template>
  <table class="tbl budget-tbl" data-testid="budget-table">
    <thead>
      <tr><th>분석 계정</th><th>구분</th><th>기간</th><th class="num">계획</th><th class="num">실적</th><th class="num">남은 금액</th><th style="width: 180px">달성률</th></tr>
    </thead>
    <tbody>
      <tr v-for="r in rows" :key="r.line_id" data-testid="budget-row" :data-account="r.analytic_account_name" :data-side="r.side" :class="{ over: r.over }">
        <td>{{ r.analytic_account_name }}<span v-if="r.account_code_from" class="muted small"> · 계정 {{ r.account_code_from }}~{{ r.account_code_to }}</span></td>
        <td>{{ r.side === 'income' ? '매출' : '비용' }}</td>
        <td class="small">{{ r.month ?? `${r.from} ~ ${r.to}` }}</td>
        <td class="num">
          <NumberInput v-if="edit" :model-value="edit[r.line_id]" kind="money" aria-label="계획 금액" data-testid="budget-planned-input" @update:model-value="emit('planned', r.line_id, $event)" />
          <template v-else>{{ fmtMoney(r.planned) }}</template>
        </td>
        <td class="num" data-testid="budget-actual">{{ fmtMoney(r.actual) }}</td>
        <td class="num" :class="{ 'err-text': r.over }" data-testid="budget-remaining">{{ fmtMoney(r.remaining) }}</td>
        <td>
          <div class="meter" :class="{ over: r.over, income: r.side === 'income' }"><span :style="{ width: bar(r) }" /></div>
          <span class="small" data-testid="budget-achieved">{{ r.achieved === null ? '계획 없음' : `${r.achieved}%` }}</span>
          <span v-if="r.over" class="pill pill-red small" data-testid="budget-over">초과</span>
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.budget-tbl td { vertical-align: middle; }
.budget-tbl tr.over td { background: var(--red-bg, #fff1f1); }
.meter { display: inline-block; width: 90px; height: 8px; margin-right: 6px; vertical-align: middle; border-radius: 4px; background: var(--ink-100); overflow: hidden; }
.meter span { display: block; height: 100%; background: var(--navy-600); }
.meter.income span { background: var(--green, #2f9e6b); }
.meter.over span { background: var(--red, #d64545); }
</style>

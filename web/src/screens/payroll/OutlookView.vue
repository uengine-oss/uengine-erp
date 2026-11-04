<script setup lang="ts">
// Labour cost ahead and what a change of headcount might do, read from the ledger's company totals (M8). No one person is in it.
import { computed, ref, watch } from 'vue'
import { rpc } from '../../lib/api'
import { fmtMoney, fmtNumber } from '../../lib/format'
import { useLoad } from '../../lib/load'
import { timeView } from '../../lib/mode'
import Icon from '../../components/Icon.vue'
import LoadError from '../../components/LoadError.vue'
import { STATE_COLOR, STATE_LABEL } from '../analytics/fmt'

interface Answer {
  state: 'locked' | 'insufficient' | 'ready'
  evidence: { have: number; need: number; unit: string; message: string }
  stale_modules: string[]
  months: { period: string; cost: number; people: number }[]
  note: string
  per_head: { mid: number; low: number; high: number } | null
  heads: number | null
  outlook: { period: string; estimate: number; low: number; high: number }[] | null
  range: { low: number; high: number } | null
  whatif: { delta: number; estimate: number; low: number; high: number; message: string } | null
}
const delta = ref(1)
const answer = useLoad(() => rpc<Answer>('erp_payroll_outlook', { p_delta: delta.value, p_months: 3, p_as_of: timeView.at || null }))
watch([delta, () => timeView.at], () => { void answer.load() }, { immediate: true })
const a = computed(() => answer.data.value)
</script>

<template>
  <div class="page" data-testid="payroll-outlook">
    <div class="page-head">
      <h1>인건비 전망</h1>
      <span v-if="a" class="pill" :class="`pill-${STATE_COLOR[a.state]}`" data-testid="outlook-state">{{ STATE_LABEL[a.state] }}</span>
    </div>
    <LoadError v-if="answer.error.value" :message="answer.error.value" @retry="answer.load" />
    <div v-if="a" class="page-body page-pad">
      <p class="small dim" data-testid="outlook-evidence">{{ a.evidence.message }}</p>
      <p class="small dim" data-testid="outlook-note"><Icon name="alert" :size="12" /> {{ a.note }}</p>
      <section v-if="a.range" class="panel" data-testid="outlook-range">
        <h2>지금 말할 수 있는 범위</h2>
        <p>한 달 {{ fmtMoney(a.range.low) }} ~ {{ fmtMoney(a.range.high) }}. 근거가 더 쌓이면 전망을 냅니다.</p>
      </section>
      <section v-if="a.outlook" class="panel" data-testid="outlook-forecast">
        <h2>다음 3개월 <span class="muted small">지금 인원 {{ fmtNumber(a.heads) }}명, 80% 구간</span></h2>
        <table class="tbl">
          <thead><tr><th>달</th><th class="num">예상</th><th class="num">낮으면</th><th class="num">높으면</th></tr></thead>
          <tbody><tr v-for="r in a.outlook" :key="r.period" data-testid="outlook-row"><td>{{ r.period }}</td><td class="num" data-col="estimate">{{ fmtMoney(r.estimate) }}</td><td class="num">{{ fmtMoney(r.low) }}</td><td class="num">{{ fmtMoney(r.high) }}</td></tr></tbody>
        </table>
      </section>
      <section v-if="a.whatif" class="panel" data-testid="outlook-whatif">
        <h2>인원이 달라지면</h2>
        <label class="field-inline">인원 증감 <input v-model.number="delta" class="input" type="number" style="width: 90px" data-testid="outlook-delta" /> 명</label>
        <p class="result" data-testid="outlook-whatif-range">한 달 {{ fmtMoney(a.whatif.low) }} ~ {{ fmtMoney(a.whatif.high) }}</p>
        <p class="small dim" data-testid="outlook-whatif-message">{{ a.whatif.message }}. 원장을 바꾸지 않습니다.</p>
      </section>
      <section v-if="a.months.length" class="panel" data-testid="outlook-months">
        <h2>근거 <span class="muted small">확정한 대장, 귀속 월 기준</span></h2>
        <table class="tbl">
          <thead><tr><th>달</th><th class="num">인원</th><th class="num">지급 합계</th></tr></thead>
          <tbody><tr v-for="m in a.months" :key="m.period" data-testid="outlook-month"><td>{{ m.period }}</td><td class="num">{{ fmtNumber(m.people) }}</td><td class="num">{{ fmtMoney(m.cost) }}</td></tr></tbody>
        </table>
      </section>
    </div>
  </div>
</template>

<style scoped>
.panel { padding: 12px 14px; margin-bottom: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); max-width: 760px; }
.panel h2 { margin-bottom: 8px; }
.result { margin: 8px 0 4px; font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
</style>

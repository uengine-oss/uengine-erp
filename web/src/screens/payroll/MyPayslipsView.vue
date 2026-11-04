<script setup lang="ts">
// A person's own confirmed payslips, whatever their role. The database answers with theirs and nobody else's.
// Lists what the Labor Standards Act decree art. 27-2 asks of a wage statement: who, the day, the total, each item, how hours were counted, each deduction.
import { computed, onMounted, ref } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { fmtMoney } from '../../lib/format'
import type { State } from '../../lib/types'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'
import LoadError from '../../components/LoadError.vue'
import { CELL_LABEL, kindLabel } from './payroll'

const slips = ref<State[]>([])
const loading = ref(true)
const error = ref('')
const pickedId = ref('')
const picked = computed(() => slips.value.find((s) => s.run_id === pickedId.value) ?? slips.value[0] ?? null)
const CELLS = ['income_tax', 'local_tax', 'pension', 'health', 'ltc', 'employment']

async function load() {
  loading.value = true
  error.value = ''
  try {
    slips.value = await rpc<State[]>('erp_my_payslips')
    pickedId.value = slips.value[0]?.run_id ?? ''
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    loading.value = false
  }
}
onMounted(load)
const print = () => window.print()
</script>

<template>
  <div class="page" data-testid="my-payslips">
    <div class="page-head no-print"><h1>내 명세서</h1><span class="muted small">본인의 확정된 명세서만 보입니다.</span></div>
    <LoadError v-if="error" :message="error" @retry="load" />
    <div class="page-body page-pad">
      <EmptyState v-if="!loading && !error && !slips.length" title="확정된 명세서가 없습니다" text="대장이 확정되면 여기에 나타납니다. ERP 계정이 직원과 연결되어 있어야 합니다." />
      <template v-else-if="picked">
        <div class="toolbar no-print">
          <label class="small dim" for="payslip-pick">명세서</label>
          <select id="payslip-pick" v-model="pickedId" class="select" style="width: 260px" data-testid="payslip-pick">
            <option v-for="s in slips" :key="s.run_id" :value="s.run_id">{{ s.period_month }} {{ kindLabel(s.kind) }} ({{ s.number }})</option>
          </select>
          <button type="button" class="btn" data-testid="payslip-print" @click="print"><Icon name="printer" :size="13" /> 인쇄</button>
        </div>
        <section class="slip" data-testid="payslip">
          <h2>{{ picked.period_month }} 임금명세서 <span v-if="picked.kind === 'reversal'" class="pill pill-amber">취소분</span></h2>
          <dl class="kv small">
            <dt>사번</dt><dd data-testid="payslip-no">{{ picked.employee_no }}</dd>
            <dt>이름</dt><dd data-testid="payslip-name">{{ picked.name }}</dd>
            <dt>부서</dt><dd>{{ picked.department_name }}</dd>
            <dt>지급일</dt><dd data-testid="payslip-date">{{ picked.pay_date }}</dd>
            <template v-if="picked.worked_hours !== null"><dt>근무 시간</dt><dd>{{ picked.worked_hours }}시간</dd></template>
            <template v-if="picked.overtime_hours !== null"><dt>초과근무 시간</dt><dd>{{ picked.overtime_hours }}시간</dd></template>
          </dl>
          <div class="grid">
            <table class="tbl" data-testid="payslip-earnings">
              <thead><tr><th>지급 항목</th><th class="num">금액</th></tr></thead>
              <tbody>
                <tr v-for="e in picked.earnings" :key="e.item_id" data-testid="payslip-earning"><td>{{ e.name }}<span v-if="e.calc === 'overtime_hours'" class="small dim"> ({{ picked.overtime_hours ?? 0 }}시간 × {{ fmtMoney(e.unit) }})</span><span v-if="e.taxable === false" class="small dim"> 비과세</span></td><td class="num">{{ fmtMoney(e.amount) }}</td></tr>
              </tbody>
              <tfoot><tr><th>임금 총액</th><td class="num" data-testid="payslip-gross">{{ fmtMoney(picked.gross) }}</td></tr></tfoot>
            </table>
            <table class="tbl" data-testid="payslip-deductions">
              <thead><tr><th>공제 항목</th><th class="num">금액</th></tr></thead>
              <tbody>
                <tr v-for="c in CELLS" :key="c" data-testid="payslip-deduction" :data-cell="c"><td>{{ CELL_LABEL[c] }}</td><td class="num">{{ fmtMoney(picked[c]) }}</td></tr>
                <tr v-for="e in picked.other_deductions" :key="e.item_id" data-testid="payslip-deduction"><td>{{ e.name }}</td><td class="num">{{ fmtMoney(e.amount) }}</td></tr>
              </tbody>
              <tfoot><tr><th>공제 합계</th><td class="num" data-testid="payslip-deductions-total">{{ fmtMoney(picked.deductions) }}</td></tr></tfoot>
            </table>
          </div>
          <p class="net"><span>차인지급액</span><strong data-testid="payslip-net">{{ fmtMoney(picked.net) }}</strong></p>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.slip { max-width: 760px; padding: 14px 16px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
.slip h2 { margin-bottom: 8px; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 10px; align-items: start; }
.net { display: flex; justify-content: flex-end; align-items: baseline; gap: 12px; margin-top: 12px; }
.net strong { font-size: 20px; font-variant-numeric: tabular-nums; }
@media (max-width: 640px) { .grid { grid-template-columns: minmax(0, 1fr); } }
</style>

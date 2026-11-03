<script setup lang="ts">
// What goes on the tax return. The rhythm, the due dates and every figure come from the database.
import { computed, ref, watch } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { loadCompany, isAdmin } from '../../lib/session'
import { sendCommand } from '../../lib/commands'
import { fmtDay, fmtMoney, fmtNumber } from '../../lib/format'
import { useLoad } from '../../lib/load'
import { writeBlock } from '../../lib/mode'
import { COMPANY_ID } from '../../lib/types'
import { ask, csvBlob, saveBlob, toast } from '../../lib/ui'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'
import LoadError from '../../components/LoadError.vue'

interface Period { from: string; to: string; due: string; remind_on: string; state: 'closed' | 'overdue' | 'due_soon' | 'to_file' | 'open' }
interface Periods { year: number; periodicity: string; periods: Period[] }
interface Report {
  rows: { tax_id: string; name: string; scope: string; amount_type: string; rate: number; base: number; tax: number; base_refund: number; tax_refund: number; discount_tax: number }[]
  grids: { grid: string; base: number; tax: number }[]
  totals: { output_tax: number; input_tax: number; payable: number }
}
const STATE: Record<string, { label: string; color: string }> = { closed: { label: '닫힘', color: 'gray' }, overdue: { label: '기한 지남', color: 'red' }, due_soon: { label: '기한 임박', color: 'amber' }, to_file: { label: '신고 대기', color: 'blue' }, open: { label: '진행 중', color: 'green' } }
const SCOPE: Record<string, string> = { sale: '매출', purchase: '매입', none: '없음' }

const year = ref(Number(fmtDay(new Date().toISOString()).slice(0, 4)))
const picked = ref<Period | null>(null)
const periods = useLoad(() => rpc<Periods>('erp_tax_periods', { p_year: year.value }))
const report = useLoad(() => rpc<Report>('erp_tax_report', { p_from: picked.value?.from, p_to: picked.value?.to }))
watch(year, async () => {
  await periods.load()
  const list = periods.data.value?.periods ?? []
  const today = fmtDay(new Date().toISOString())
  picked.value = list.find((p) => p.from <= today && today <= p.to) ?? list[list.length - 1] ?? null
}, { immediate: true })
watch(picked, (p) => { if (p) void report.load() })
const closing = ref(false)
const canClose = computed(() => isAdmin() && !writeBlock.value && !!picked.value && picked.value.state !== 'closed')

async function closePeriod() {
  if (!picked.value) return
  const answer = await ask({ title: '이 기간 닫기', message: `세금 잠금일을 ${picked.value.to} 로 정합니다. 세금이 있는 문서는 이 날짜까지 게시하거나 되돌릴 수 없게 됩니다.`, confirmLabel: '닫기', cancelLabel: '취소', danger: true })
  if (!answer) return
  closing.value = true
  try {
    await sendCommand({ type: 'company', id: COMPANY_ID, command: 'update', payload: { lock_date_tax: picked.value.to } })
    await loadCompany()
    toast('기간을 닫았습니다.')
    const at = picked.value.from
    await periods.load()
    picked.value = periods.data.value?.periods.find((p) => p.from === at) ?? null
  } catch (e) {
    toast(messageOf(e), 'error')
  } finally {
    closing.value = false
  }
}
function exportCsv() {
  const rows = report.data.value?.rows ?? []
  saveBlob(csvBlob(['세금', '범위', '과세 표준', '세액', '환불 기준', '환불 세액', '조기 할인 세액'], rows.map((r) => [
    { value: r.name, numeric: false }, { value: SCOPE[r.scope] ?? r.scope, numeric: false }, { value: r.base, numeric: true }, { value: r.tax, numeric: true }, { value: r.base_refund, numeric: true }, { value: r.tax_refund, numeric: true }, { value: r.discount_tax, numeric: true },
  ])), `세금신고_${picked.value?.from}_${picked.value?.to}.csv`)
}
</script>

<template>
  <div class="page" data-testid="tax">
    <div class="page-head">
      <h1>세금 신고</h1>
      <div class="grow"></div>
      <button type="button" class="btn" :disabled="!report.data.value?.rows.length" data-testid="tax-csv" @click="exportCsv"><Icon name="download" :size="13" />CSV</button>
      <button v-if="canClose" type="button" class="btn" :disabled="closing" data-testid="tax-close" @click="closePeriod"><Icon name="lock" :size="13" />이 기간 닫기</button>
    </div>
    <div class="toolbar chip-row">
      <label class="field-inline">연도 <input v-model.number="year" class="input" type="number" style="width: 84px" data-testid="tax-year" /></label>
      <button v-for="p in periods.data.value?.periods ?? []" :key="p.from" type="button" class="toggle" :class="{ on: picked?.from === p.from }" :aria-pressed="picked?.from === p.from" data-testid="tax-period" :data-from="p.from" @click="picked = p">{{ p.from.slice(5) }} ~ {{ p.to.slice(5) }} <span class="small">· {{ STATE[p.state]?.label }}</span></button>
    </div>
    <LoadError :message="periods.error.value || report.error.value" @retry="report.load" />
    <div class="page-body report-pad">
      <template v-if="picked && report.data.value">
        <p class="small dim" data-testid="tax-due">신고 기한 {{ picked.due }} <span class="pill" :class="`pill-${STATE[picked.state]?.color}`" data-testid="tax-state">{{ STATE[picked.state]?.label }}</span></p>
        <div class="stat-row" style="margin-top: 8px">
          <div class="stat"><span class="stat-label">매출 세액</span><span class="stat-value" data-testid="tax-output">{{ fmtMoney(report.data.value.totals.output_tax) }}</span></div>
          <div class="stat"><span class="stat-label">매입 세액</span><span class="stat-value" data-testid="tax-input">{{ fmtMoney(report.data.value.totals.input_tax) }}</span></div>
          <div class="stat"><span class="stat-label">낼 세액</span><span class="stat-value" data-testid="tax-payable">{{ fmtMoney(report.data.value.totals.payable) }}</span></div>
        </div>
        <section class="report-section" style="margin-top: 14px">
          <h2>세금별</h2>
          <div class="scroll-x">
            <table v-if="report.data.value.rows.length" class="tbl" data-testid="tax-table">
              <thead><tr><th>세금</th><th>범위</th><th class="num">세율</th><th class="num">과세 표준</th><th class="num">세액</th><th class="num">환불 기준</th><th class="num">환불 세액</th><th class="num">조기 할인 세액</th></tr></thead>
              <tbody><tr v-for="r in report.data.value.rows" :key="r.tax_id" data-testid="tax-row"><td>{{ r.name }}</td><td>{{ SCOPE[r.scope] ?? r.scope }}</td><td class="num">{{ fmtNumber(r.rate) }}</td><td class="num">{{ fmtMoney(r.base) }}</td><td class="num">{{ fmtMoney(r.tax) }}</td><td class="num">{{ fmtMoney(r.base_refund) }}</td><td class="num">{{ fmtMoney(r.tax_refund) }}</td><td class="num">{{ fmtMoney(r.discount_tax) }}</td></tr></tbody>
            </table>
            <EmptyState v-else title="이 기간에 세금이 있는 게시 문서가 없습니다" />
          </div>
        </section>
        <section v-if="report.data.value.grids.length" class="report-section">
          <h2>신고 그리드</h2>
          <table class="tbl" data-testid="tax-grids">
            <thead><tr><th>그리드</th><th class="num">기준</th><th class="num">세액</th></tr></thead>
            <tbody><tr v-for="g in report.data.value.grids" :key="g.grid"><td>{{ g.grid }}</td><td class="num">{{ fmtMoney(g.base) }}</td><td class="num">{{ fmtMoney(g.tax) }}</td></tr></tbody>
          </table>
        </section>
      </template>
    </div>
  </div>
</template>

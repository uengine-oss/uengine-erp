<script setup lang="ts">
// Forecasts: each shows its result, its 80% interval and what it rests on. The model decides whether it may answer.
import { computed, ref, watch } from 'vue'
import { ledger, runOnLedger, useModelRun } from '../../lib/analytics'
import type { DepreciationOutcome } from '../../lib/forecast/assets.ts'
import type { CashOutcome } from '../../lib/forecast/cash.ts'
import type { DemandOutcome } from '../../lib/forecast/forecast.ts'
import type { LeadOutcome } from '../../lib/forecast/lead.ts'
import type { PnlOutcome } from '../../lib/forecast/pnl.ts'
import type { QuarterOutcome } from '../../lib/forecast/quarters.ts'
import type { ModelId } from '../../lib/forecast/types.ts'
import type { ReorderRow, StockoutRow } from '../../lib/forecast/whatif.ts'
import { timeView } from '../../lib/mode'
import { ensureNames, refLabel } from '../../lib/refs'
import BandBar from './BandBar.vue'
import ColumnChart from './ColumnChart.vue'
import ResultFrame from './ResultFrame.vue'
import { bandText, fmtChance, fmtDays, fmtMoneyPlain, fmtPercent, fmtQty, moneyWithUnit } from './fmt'

const props = defineProps<{ id: ModelId }>()

const { result, running, seconds, error, run, clear } = useModelRun<any>(() => props.id)

const days = ref(props.id === 'stockout_risk' ? 30 : props.id === 'reorder_plan' ? 60 : 92)
const months = ref(props.id === 'depreciation_outlook' ? 12 : 3)
const cover = ref(30)
const DAYS = computed(() => (props.id === 'stockout_risk' ? [14, 30, 60] : props.id === 'reorder_plan' ? [30, 60, 92] : [30, 60, 92, 180]))

function input(): object {
  switch (props.id) {
    case 'pnl_outlook': return { months: months.value }
    case 'depreciation_outlook': return { months: months.value }
    case 'lead_time': return {}
    case 'quarter_outlook': return {}
    case 'reorder_plan': return { days: days.value, cover_days: cover.value }
    default: return { days: days.value }
  }
}
const go = () => { void run(input()) }
runOnLedger(go)
// An answer about another date must not stay up while this date's ledger is read.
watch(() => timeView.at, clear)
watch([days, months, cover], go)

const hasDays = computed(() => !['lead_time', 'pnl_outlook', 'depreciation_outlook', 'quarter_outlook'].includes(props.id))
const hasMonths = computed(() => ['pnl_outlook', 'depreciation_outlook'].includes(props.id))
const MONTHS = computed(() => (props.id === 'depreciation_outlook' ? [6, 12, 24] : [1, 3, 6]))
const warehouseName = (id: string | null) => ledger.meta?.warehouses.find((w) => w.id === id)?.name ?? id ?? '-'

// Vendors are known here by id only.
watch(result, (r) => {
  const out = r?.result as LeadOutcome | null | undefined
  if (props.id === 'lead_time' && out?.by_vendor) void ensureNames(out.by_vendor.map((v) => v.vendor_id)).catch(() => {})
})

const demand = computed(() => (props.id === 'demand_sales' || props.id === 'demand_true' ? (result.value?.result as DemandOutcome | null) : null))
const demandMax = computed(() => (demand.value ? demand.value.by_variant.reduce((m, v) => Math.max(m, v.units.p90), 1) : 1))
const quarters = computed(() => (props.id === 'quarter_outlook' ? (result.value?.result as QuarterOutcome | null) : null))
const stockouts = computed(() => (props.id === 'stockout_risk' ? (result.value?.result as { rows: StockoutRow[]; days: number } | null) : null))
const lead = computed(() => (props.id === 'lead_time' ? (result.value?.result as LeadOutcome | null) : null))
const reorder = computed(() => (props.id === 'reorder_plan' ? (result.value?.result as { rows: ReorderRow[] } | null) : null))
const cash = computed(() => (props.id === 'cash_in' ? (result.value?.result as CashOutcome | null) : null))
const pnl = computed(() => (props.id === 'pnl_outlook' ? (result.value?.result as PnlOutcome | null) : null))
const outlook = computed(() => (props.id === 'depreciation_outlook' ? (result.value?.result as DepreciationOutcome | null) : null))
const outlookColumns = computed(() => (outlook.value?.months ?? []).map((m) => ({ key: m.month, label: m.month.slice(2), band: m.band })))
const cashColumns = computed(() => (cash.value?.weekly ?? []).map((b, i) => ({ key: String(i), label: `${i + 1}주`, band: b })))
const pnlColumns = computed(() => (pnl.value?.months ?? []).map((m) => ({ key: m.month, label: m.month, band: m.profit })))
const onTime = (v: number | null) => (v === null ? '-' : fmtPercent(v))
</script>

<template>
  <div class="panel-stack" data-testid="forecast-panel">
    <div v-if="hasDays || hasMonths" class="controls">
      <label v-if="hasDays" class="field-inline">앞으로
        <select v-model.number="days" class="select" data-testid="forecast-days"><option v-for="d in DAYS" :key="d" :value="d">{{ d }}일</option></select>
      </label>
      <label v-if="id === 'reorder_plan'" class="field-inline">확보할 기간
        <select v-model.number="cover" class="select" data-testid="forecast-cover"><option v-for="d in [14, 30, 60]" :key="d" :value="d">{{ d }}일</option></select>
      </label>
      <label v-if="hasMonths" class="field-inline">앞으로
        <select v-model.number="months" class="select" data-testid="forecast-months"><option v-for="m in MONTHS" :key="m" :value="m">{{ m }}개월</option></select>
      </label>
    </div>

    <ResultFrame :result="result" :running="running" :seconds="seconds" :error="error" @retry="go">
      <!-- Demand -->
      <template v-if="demand">
        <dl class="tiles" data-testid="demand-totals">
          <div><dt>앞으로 {{ demand.days }}일 수량 (80% 구간)</dt><dd>{{ bandText(demand.total_units) }}</dd><small>중앙값 {{ fmtQty(demand.total_units.p50) }}</small></div>
          <div><dt>매출 (80% 구간)</dt><dd>{{ bandText(demand.total_revenue, fmtMoneyPlain) }}</dd><small>중앙값 {{ moneyWithUnit(demand.total_revenue.p50) }}</small></div>
        </dl>
        <div class="tbl-wrap">
          <table class="tbl" data-testid="demand-by-variant">
            <thead><tr><th>제품</th><th class="num">P10</th><th class="num">P50</th><th class="num">P90</th><th style="min-width: 130px">80% 구간</th></tr></thead>
            <tbody><tr v-for="v in demand.by_variant" :key="v.variant_id"><td>{{ v.name }}</td><td class="num">{{ fmtQty(v.units.p10) }}</td><td class="num">{{ fmtQty(v.units.p50) }}</td><td class="num">{{ fmtQty(v.units.p90) }}</td><td><BandBar :band="v.units" :min="0" :max="demandMax" :aria-label="`${v.name} 수요의 80% 구간`" /></td></tr></tbody>
          </table>
        </div>
        <details class="more">
          <summary>제품·지역별로 보기</summary>
          <div class="tbl-wrap">
            <table class="tbl" data-testid="demand-by-region">
              <thead><tr><th>제품</th><th>지역</th><th class="num">수량 P10</th><th class="num">P50</th><th class="num">P90</th><th class="num">매출 P50</th></tr></thead>
              <tbody><tr v-for="r in demand.rows" :key="`${r.variant_id}|${r.region}`"><td>{{ r.name }}</td><td>{{ r.region || '지역 없음' }}</td><td class="num">{{ fmtQty(r.units.p10) }}</td><td class="num">{{ fmtQty(r.units.p50) }}</td><td class="num">{{ fmtQty(r.units.p90) }}</td><td class="num">{{ fmtMoneyPlain(r.revenue.p50) }}</td></tr></tbody>
            </table>
          </div>
        </details>
      </template>

      <!-- Next year, a quarter at a time -->
      <template v-else-if="quarters">
        <dl class="tiles" data-testid="quarter-totals">
          <div v-if="quarters.best"><dt>가장 많이 팔릴 때</dt><dd>{{ quarters.best.quarter }} {{ quarters.best.name }}</dd><small>{{ bandText(quarters.best.units) }}개. 그 분기 1위일 가능성 {{ fmtChance(quarters.best.p_top) }}</small></div>
          <div><dt>{{ quarters.year }}년 매출 (80% 구간)</dt><dd>{{ bandText(quarters.revenue, fmtMoneyPlain) }}</dd><small>공급이 지금과 같을 때. 중앙값 {{ moneyWithUnit(quarters.revenue.p50) }}</small></div>
          <div><dt>수요를 다 채우면</dt><dd>{{ bandText(quarters.revenue_if_supplied, fmtMoneyPlain) }}</dd><small>중앙값 {{ moneyWithUnit(quarters.revenue_if_supplied.p50) }}</small></div>
        </dl>
        <div class="tbl-wrap">
          <table class="tbl" data-testid="quarter-table">
            <thead><tr><th>분기</th><th>1위 제품</th><th class="num">1위 수량 (80% 구간)</th><th class="num">1위일 가능성</th><th class="num">매출 (80% 구간)</th></tr></thead>
            <tbody>
              <tr v-for="q in quarters.quarters" :key="q.quarter" :data-quarter="q.quarter">
                <td>{{ q.quarter }}</td>
                <td>{{ q.top[0]?.name ?? '-' }}</td>
                <td class="num">{{ q.top[0] ? bandText(q.top[0].units) : '-' }}</td>
                <td class="num">{{ q.top[0] ? fmtChance(q.top[0].p_top) : '-' }}</td>
                <td class="num">{{ bandText(q.revenue, fmtMoneyPlain) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <details class="more" v-if="quarters.stockout_gaps.length">
          <summary>품절 때문에 낮게 읽히는 제품</summary>
          <div class="tbl-wrap">
            <table class="tbl" data-testid="quarter-gaps">
              <thead><tr><th>제품</th><th>분기</th><th class="num">판매 기록만 볼 때</th><th class="num">품절을 보정하면</th><th class="num">지난 1년 품절일</th></tr></thead>
              <tbody><tr v-for="g in quarters.stockout_gaps" :key="g.variant_id"><td>{{ g.name }}</td><td>{{ g.quarter }}</td><td class="num">{{ fmtQty(g.sales_only) }}</td><td class="num">{{ fmtQty(g.corrected) }}</td><td class="num">{{ fmtQty(g.stockout_days) }}</td></tr></tbody>
            </table>
          </div>
        </details>
      </template>

      <!-- Stockouts -->
      <div v-else-if="stockouts" class="tbl-wrap">
        <p class="small dim cap">지금 있는 재고와 발주 중인 것만으로, 새로 주문하지 않을 때 언제 떨어지는지입니다.</p>
        <table class="tbl" data-testid="stockout-table">
          <thead><tr><th>제품</th><th>창고</th><th class="num">현재고</th><th class="num">{{ stockouts.days }}일 안에 품절될 확률</th><th>예상일</th><th class="num">남은 날 (P10~P90)</th></tr></thead>
          <tbody>
            <tr v-for="r in stockouts.rows" :key="`${r.variant_id}|${r.warehouse_id}`"><td>{{ r.name }}</td><td>{{ warehouseName(r.warehouse_id) }}</td><td class="num">{{ fmtQty(r.stock) }}</td><td class="num">{{ fmtPercent(r.prob_out) }}</td><td>{{ r.out_on ?? '이 기간 안에는 아님' }}</td><td class="num">{{ r.out_in_days ? bandText(r.out_in_days) : '-' }}</td></tr>
            <tr v-if="!stockouts.rows.length"><td colspan="6" class="muted">재고 이력이 있는 제품이 없습니다.</td></tr>
          </tbody>
        </table>
      </div>

      <!-- Lead time -->
      <template v-else-if="lead">
        <dl class="tiles" data-testid="lead-all">
          <div><dt>주문부터 첫 입고까지 (중앙값)</dt><dd>{{ fmtDays(lead.all.median_days) }}</dd><small>P90 {{ fmtDays(lead.all.p90_days) }}</small></div>
          <div><dt>평균 (80% 구간)</dt><dd>{{ bandText(lead.all.mean_days, fmtDays) }}</dd><small>입고 {{ lead.all.received }}건, 미입고 {{ lead.all.open }}건</small></div>
          <div><dt>약속일 안에 도착</dt><dd>{{ onTime(lead.all.on_time) }}</dd></div>
        </dl>
        <div class="tbl-wrap">
          <table class="tbl" data-testid="lead-by-vendor">
            <thead><tr><th>공급사</th><th class="num">입고</th><th class="num">미입고</th><th class="num">중앙값</th><th class="num">P90</th><th class="num">평균 (80% 구간)</th><th class="num">약속일 안</th></tr></thead>
            <tbody><tr v-for="v in lead.by_vendor" :key="v.vendor_id ?? ''"><td>{{ v.vendor_id ? refLabel(v.vendor_id) : '공급사 없음' }}</td><td class="num">{{ v.received }}</td><td class="num">{{ v.open }}</td><td class="num">{{ fmtDays(v.median_days) }}</td><td class="num">{{ fmtDays(v.p90_days) }}</td><td class="num">{{ bandText(v.mean_days, fmtDays) }}</td><td class="num">{{ onTime(v.on_time) }}</td></tr></tbody>
          </table>
        </div>
      </template>

      <!-- Reorder -->
      <div v-else-if="reorder" class="tbl-wrap">
        <p class="small dim cap">이 날까지 주문하면 도착 전에 품절될 가능성이 약 10% 입니다. 제안은 계산일 뿐, 주문은 사람이 합니다.</p>
        <table class="tbl" data-testid="reorder-table">
          <thead><tr><th>제품</th><th>창고</th><th class="num">현재고</th><th class="num">발주 중</th><th>주문 기한</th><th class="num">납기 P90</th><th class="num">제안 수량</th></tr></thead>
          <tbody>
            <tr v-for="r in reorder.rows" :key="`${r.variant_id}|${r.warehouse_id}`"><td>{{ r.name }}</td><td>{{ warehouseName(r.warehouse_id) }}</td><td class="num">{{ fmtQty(r.stock) }}</td><td class="num">{{ fmtQty(r.on_order) }}</td><td>{{ r.order_by }} <span v-if="r.need_now" class="pill pill-red">지금 필요</span></td><td class="num">{{ fmtDays(r.lead_p90) }}</td><td class="num">{{ fmtQty(r.suggest_qty) }}</td></tr>
            <tr v-if="!reorder.rows.length"><td colspan="7" class="muted">재고 이력이 있는 제품이 없습니다.</td></tr>
          </tbody>
        </table>
      </div>

      <!-- Cash -->
      <template v-else-if="cash">
        <dl class="tiles" data-testid="cash-totals">
          <div><dt>앞으로 {{ cash.days }}일 입금 (80% 구간)</dt><dd>{{ bandText(cash.total, fmtMoneyPlain) }}</dd><small>중앙값 {{ moneyWithUnit(cash.total.p50) }}</small></div>
          <div><dt>이미 나간 청구서에서</dt><dd>{{ bandText(cash.from_open, fmtMoneyPlain) }}</dd></div>
          <div><dt>앞으로 나갈 청구서에서</dt><dd>{{ bandText(cash.from_new, fmtMoneyPlain) }}</dd></div>
          <div><dt>미수금</dt><dd>{{ moneyWithUnit(cash.open_total) }}</dd><small>기한 지남 {{ moneyWithUnit(cash.overdue_total) }}</small></div>
        </dl>
        <section class="chart-box">
          <h2>주별 입금 (막대는 80% 구간, 가로선은 중앙값)</h2>
          <ColumnChart :rows="cashColumns" :format="fmtMoneyPlain" description="주별 입금 예측의 80% 구간" />
        </section>
      </template>

      <!-- Depreciation -->
      <template v-else-if="outlook">
        <dl class="tiles" data-testid="outlook-totals">
          <div><dt>앞으로 {{ outlook.months.length }}개월 감가상각비 (80% 구간)</dt><dd>{{ bandText(outlook.total, fmtMoneyPlain) }}</dd><small>새로 살 자산까지 넣은 값</small></div>
          <div><dt>지금 있는 자산만</dt><dd data-testid="outlook-scheduled">{{ moneyWithUnit(outlook.scheduled_total) }}</dd><small>처분하지 않으면 이대로입니다</small></div>
          <div><dt>자산 이력</dt><dd>{{ outlook.history_months }}개월</dd><small>등록 {{ outlook.assets }}건, 그중 새로 산 것 {{ outlook.purchases }}건</small></div>
        </dl>
        <section class="chart-box">
          <h2>월별 감가상각비 (막대는 80% 구간, 가로선은 중앙값)</h2>
          <ColumnChart :rows="outlookColumns" :format="fmtMoneyPlain" description="월별 감가상각비 전망의 80% 구간" />
        </section>
        <div class="tbl-wrap">
          <table class="tbl" data-testid="outlook-months">
            <thead><tr><th>월</th><th class="num">지금 있는 자산</th><th class="num">P10</th><th class="num">P50</th><th class="num">P90</th></tr></thead>
            <tbody><tr v-for="m in outlook.months" :key="m.month" data-testid="outlook-month"><td>{{ m.month }}</td><td class="num">{{ fmtMoneyPlain(m.scheduled) }}</td><td class="num">{{ fmtMoneyPlain(m.band.p10) }}</td><td class="num">{{ fmtMoneyPlain(m.band.p50) }}</td><td class="num">{{ fmtMoneyPlain(m.band.p90) }}</td></tr></tbody>
          </table>
        </div>
        <div class="tbl-wrap">
          <p class="small dim cap">이 기간 안에 상각이 끝나는 자산입니다. 교체를 검토할 때 보세요. 언제 바꿀지는 계산하지 않습니다.</p>
          <table class="tbl" data-testid="outlook-ending">
            <thead><tr><th>자산</th><th>번호</th><th>상각 끝나는 달</th><th class="num">취득가액</th></tr></thead>
            <tbody>
              <tr v-for="a in outlook.ending" :key="a.asset_id" data-testid="outlook-ending-row"><td>{{ a.name }}</td><td>{{ a.number }}</td><td>{{ a.last_month }}</td><td class="num">{{ fmtMoneyPlain(a.cost) }}</td></tr>
              <tr v-if="!outlook.ending.length"><td colspan="4" class="muted">이 기간 안에 상각이 끝나는 자산이 없습니다.</td></tr>
            </tbody>
          </table>
        </div>
      </template>

      <!-- Profit -->
      <template v-else-if="pnl">
        <dl class="tiles" data-testid="pnl-totals">
          <div><dt>앞으로 {{ pnl.months.length }}개월 이익 (80% 구간)</dt><dd>{{ bandText(pnl.profit, fmtMoneyPlain) }}</dd><small>중앙값 {{ moneyWithUnit(pnl.profit.p50) }}</small></div>
          <div><dt>매출</dt><dd>{{ bandText(pnl.revenue, fmtMoneyPlain) }}</dd></div>
          <div><dt>매출원가</dt><dd>{{ bandText(pnl.cogs, fmtMoneyPlain) }}</dd><small>매출총이익률 {{ fmtPercent(pnl.gross_margin_rate, 1) }}</small></div>
          <div><dt>그 밖의 비용</dt><dd>{{ bandText(pnl.opex, fmtMoneyPlain) }}</dd><small>전표 {{ pnl.history_months }}개월 기준</small></div>
        </dl>
        <section class="chart-box">
          <h2>월별 이익 (막대는 80% 구간, 가로선은 중앙값)</h2>
          <ColumnChart :rows="pnlColumns" :format="fmtMoneyPlain" description="월별 이익 전망의 80% 구간" />
        </section>
        <div class="tbl-wrap">
          <table class="tbl" data-testid="pnl-months">
            <thead><tr><th>월</th><th class="num">매출 P50</th><th class="num">이익 P10</th><th class="num">이익 P50</th><th class="num">이익 P90</th></tr></thead>
            <tbody><tr v-for="m in pnl.months" :key="m.month"><td>{{ m.month }}</td><td class="num">{{ fmtMoneyPlain(m.revenue.p50) }}</td><td class="num">{{ fmtMoneyPlain(m.profit.p10) }}</td><td class="num">{{ fmtMoneyPlain(m.profit.p50) }}</td><td class="num">{{ fmtMoneyPlain(m.profit.p90) }}</td></tr></tbody>
          </table>
        </div>
      </template>
    </ResultFrame>
  </div>
</template>

<style scoped>
.panel-stack { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.controls { display: flex; flex-wrap: wrap; gap: 12px; }
.field-inline { display: inline-flex; align-items: center; gap: 6px; color: var(--text-2); }
.field-inline .select { width: 96px; }
.tiles { display: flex; flex-wrap: wrap; gap: 10px 28px; margin: 0; }
.tiles dt { color: var(--text-2); font-size: 12px; }
.tiles dd { margin: 0; font-size: 16px; font-weight: 650; font-variant-numeric: tabular-nums; }
.tiles small { color: var(--text-3); font-size: 12px; }
.tbl-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.tbl-wrap .tbl th { position: static; }
.cap { padding: 6px 10px; border-bottom: 1px solid var(--line); }
.chart-box { padding: 10px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
.chart-box h2 { margin-bottom: 8px; font-size: 13px; }
.more > summary { margin: 2px 0 6px; }
</style>

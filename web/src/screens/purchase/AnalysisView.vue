<script setup lang="ts">
// What was bought, from whom and at what price. All sums come from the database; this screen chooses and arranges.
import { computed, ref, watch } from 'vue'
import { rpc } from '../../lib/api'
import { fmtDay, fmtMoney, fmtNumber } from '../../lib/format'
import { thisMonth, useLoad } from '../../lib/load'
import { ensureNames, refLabel } from '../../lib/refs'
import { catalogOf, hasRole } from '../../lib/session'
import type { State } from '../../lib/types'
import { csvBlob, saveBlob } from '../../lib/ui'
import ColumnChart from '../analytics/ColumnChart.vue'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'
import LoadError from '../../components/LoadError.vue'
import RefSelect from '../../components/RefSelect.vue'
import SavedSearchBar from '../../components/SavedSearchBar.vue'

const GROUPS = [{ value: 'partner_id', label: '공급사' }, { value: 'product_id', label: '제품' }, { value: 'category_id', label: '제품 분류' }, { value: 'buyer_id', label: '담당자' }, { value: 'state', label: '상태' }, { value: 'month', label: '월' }, { value: 'quarter', label: '분기' }, { value: 'year', label: '연도' }]
const ID_GROUPS = new Set(['partner_id', 'product_id', 'category_id', 'buyer_id'])
const STATE_LABEL = computed<Record<string, string>>(() => Object.fromEntries((catalogOf('purchase_order')?.states ?? []).map((s) => [s.value, s.label])))

const start = thisMonth(fmtDay(new Date().toISOString()))
const tab = ref<'analysis' | 'cost' | 'spend' | 'prices'>('analysis')
const from = ref(start.from)
const to = ref(start.to)
const groupBy = ref<string[]>(['partner_id'])
const kind = ref('po')
const dateField = ref('date_order')
const compare = ref('')
const partner = ref<string | null>(null)
const product = ref<string | null>(null)
const spendBy = ref<'partner' | 'category'>('partner')
const canPrices = computed(() => hasRole(['purchase']))

const filters = computed<State>(() => {
  const f: State = { kind: kind.value, date_field: dateField.value }
  if (partner.value) f.partner_id = partner.value
  if (product.value) f.product_id = product.value
  return f
})
async function named(rows: State[]) {
  await ensureNames(rows.flatMap((r) => [r.partner_id, r.product_id, r.category_id, r.buyer_id]))
  return rows
}
const report = useLoad(async (): Promise<State[]> => {
  if (tab.value === 'analysis') return named((await rpc<{ rows: State[] }>('erp_purchase_analysis', { p_from: from.value, p_to: to.value, p_group_by: groupBy.value, p_filters: filters.value, p_compare: compare.value || null })).rows)
  if (tab.value === 'cost') return named((await rpc<{ rows: State[] }>('erp_vendor_cost_report', { p_from: from.value, p_to: to.value, p_partner_id: partner.value })).rows)
  if (tab.value === 'spend') return named((await rpc<{ rows: State[] }>('erp_purchase_spend', { p_from: from.value, p_to: to.value, p_by: spendBy.value })).rows)
  return named(await rpc<State[]>('erp_vendor_prices', { p_partner_id: partner.value }))
})
watch([tab, from, to, groupBy, kind, dateField, compare, partner, product, spendBy], report.load, { immediate: true, deep: true })

const rows = computed(() => report.data.value ?? [])
const groupLabel = (g: string) => GROUPS.find((x) => x.value === g)?.label ?? g
function groupCell(r: State, g: string): string {
  const v = r[g]
  if (g === 'state') return STATE_LABEL.value[v] ?? v ?? ''
  if (ID_GROUPS.has(g)) return v ? refLabel(v) : '(없음)'
  return v ?? ''
}
function toggleGroup(g: string) { groupBy.value = groupBy.value.includes(g) ? groupBy.value.filter((x) => x !== g) : [...groupBy.value, g] }
function applySaved(f: State, g: string[]) {
  kind.value = f.kind ?? 'po'
  dateField.value = f.date_field ?? 'date_order'
  partner.value = f.partner_id ?? null
  product.value = f.product_id ?? null
  if (g.length) groupBy.value = g
}
const totalSpend = computed(() => rows.value.reduce((n, r) => n + Number(r.total ?? 0), 0))
const chartRows = computed(() => rows.value.slice(0, 12).map((r, i) => ({ key: String(i), label: groupBy.value.length ? groupCell(r, groupBy.value[0]) : '합계', value: Number(r.total ?? 0) })))
const change = (r: State) => { const v = r.change_percent?.total; return v === null || v === undefined ? '' : `${v > 0 ? '+' : ''}${fmtNumber(v)}%` }

function exportCsv() {
  let headers: string[]
  let body: { value: unknown; numeric: boolean }[][]
  if (tab.value === 'prices') {
    // The column names are what the file needs when it comes back in through 표 파일 가져오기.
    headers = ['id', 'product', 'partner', 'min_qty', 'price', 'discount', 'delay_days', 'vendor_code', 'date_start', 'date_end']
    body = rows.value.map((r) => headers.map((h) => ({ value: r[h] ?? '', numeric: !['id', 'product', 'partner', 'vendor_code', 'date_start', 'date_end'].includes(h) })))
  } else if (tab.value === 'analysis') {
    headers = [...groupBy.value.map(groupLabel), '주문 수', '수량', '공급가액', '합계', '평균 단가']
    body = rows.value.map((r) => [...groupBy.value.map((g) => ({ value: groupCell(r, g), numeric: false })), ...['orders', 'qty', 'subtotal', 'total', 'avg_cost'].map((k) => ({ value: r[k], numeric: true }))])
  } else {
    headers = ['공급사', '제품', '월', '수량', '합계', '평균 단가']
    body = rows.value.map((r) => [{ value: r.partner_id ? refLabel(r.partner_id) : '', numeric: false }, { value: r.product_id ? refLabel(r.product_id) : '', numeric: false }, { value: r.month ?? '', numeric: false }, { value: r.qty, numeric: true }, { value: r.total, numeric: true }, { value: r.avg_cost, numeric: true }])
  }
  saveBlob(csvBlob(headers, body), `구매_${tab.value}_${from.value}.csv`)
}
</script>

<template>
  <div class="page" data-testid="purchase-analysis">
    <div class="page-head">
      <h1>구매 분석</h1>
      <div class="grow"></div>
      <router-link v-if="tab === 'prices' && canPrices" class="btn" :to="{ name: 'import', query: { type: 'vendor_price' } }" data-testid="prices-import">가져오기</router-link>
      <button type="button" class="btn" :disabled="!rows.length" data-testid="analysis-csv" @click="exportCsv"><Icon name="download" :size="13" />CSV</button>
    </div>
    <div class="toolbar row-wrap">
      <div class="seg" role="group" aria-label="보고서">
        <button type="button" :class="{ on: tab === 'analysis' }" :aria-pressed="tab === 'analysis'" data-testid="tab-analysis" @click="tab = 'analysis'">분석</button>
        <button type="button" :class="{ on: tab === 'cost' }" :aria-pressed="tab === 'cost'" data-testid="tab-cost" @click="tab = 'cost'">단가 변천</button>
        <button type="button" :class="{ on: tab === 'spend' }" :aria-pressed="tab === 'spend'" data-testid="tab-spend" @click="tab = 'spend'">지출</button>
        <button v-if="canPrices" type="button" :class="{ on: tab === 'prices' }" :aria-pressed="tab === 'prices'" data-testid="tab-prices" @click="tab = 'prices'">공급사 가격표</button>
      </div>
      <template v-if="tab !== 'prices'">
        <label class="field-inline">부터 <input v-model="from" class="input" type="date" data-testid="analysis-from" /></label>
        <label class="field-inline">까지 <input v-model="to" class="input" type="date" data-testid="analysis-to" /></label>
      </template>
      <span v-if="tab !== 'spend'" style="width: 170px"><RefSelect v-model="partner" ref-type="partner" placeholder="공급사" aria-label="공급사" /></span>
      <select v-if="tab === 'spend'" v-model="spendBy" class="select" style="width: 130px" aria-label="기준" data-testid="spend-by"><option value="partner">공급사별</option><option value="category">제품 분류별</option></select>
    </div>
    <div v-if="tab === 'analysis'" class="toolbar row-wrap">
      <span style="width: 170px"><RefSelect v-model="product" ref-type="product" placeholder="제품" aria-label="제품" /></span>
      <select v-model="kind" class="select" style="width: 120px" aria-label="구분" data-testid="analysis-kind"><option value="po">확정 주문</option><option value="rfq">견적 요청</option><option value="all">전체</option></select>
      <select v-model="dateField" class="select" style="width: 120px" aria-label="날짜 기준" data-testid="analysis-date-field"><option value="date_order">주문 마감일</option><option value="date_confirmed">확정일</option></select>
      <select v-model="compare" class="select" style="width: 130px" aria-label="비교" data-testid="analysis-compare"><option value="">비교 안 함</option><option value="previous_period">앞 기간과</option><option value="previous_year">전년 같은 기간과</option></select>
      <SavedSearchBar report="purchase_analysis" :filters="filters" :group-by="groupBy" @apply="applySaved" />
    </div>
    <div v-if="tab === 'analysis'" class="toolbar chip-row">
      <span class="muted small">묶을 항목</span>
      <button v-for="g in GROUPS" :key="g.value" type="button" class="toggle" :class="{ on: groupBy.includes(g.value) }" :aria-pressed="groupBy.includes(g.value)" :data-testid="`group-${g.value}`" @click="toggleGroup(g.value)">{{ g.label }}</button>
    </div>
    <LoadError :message="report.error.value" @retry="report.load" />
    <div class="page-body" style="background: var(--surface)">
      <EmptyState v-if="!rows.length && !report.loading.value && !report.error.value" title="조건에 맞는 구매가 없습니다" text="기간이나 조건을 바꾸어 보세요." />
      <template v-else-if="tab === 'analysis'">
        <div v-if="chartRows.length > 1" class="chart-box"><ColumnChart :rows="chartRows" :format="fmtMoney" :description="`${groupBy.length ? groupLabel(groupBy[0]) : '전체'}별 합계`" :height="150" /></div>
        <div class="scroll-x">
          <table class="tbl" data-testid="analysis-table">
            <thead><tr><th v-for="g in groupBy" :key="g">{{ groupLabel(g) }}</th><th class="num">주문 수</th><th class="num">수량</th><th class="num">입고</th><th class="num">공급가액</th><th class="num">합계</th><th class="num">평균 단가</th><th class="num">확정까지(일)</th><th class="num">입고까지(일)</th><th v-if="compare" class="num">비교 기간 합계</th><th v-if="compare" class="num">변화</th></tr></thead>
            <tbody>
              <tr v-for="(r, i) in rows" :key="i" data-testid="analysis-row">
                <td v-for="g in groupBy" :key="g">{{ groupCell(r, g) }}</td>
                <td class="num">{{ fmtNumber(r.orders) }}</td><td class="num" data-testid="analysis-qty">{{ fmtNumber(r.qty) }}</td><td class="num">{{ fmtNumber(r.qty_received) }}</td><td class="num">{{ fmtMoney(r.subtotal) }}</td><td class="num" data-testid="analysis-total">{{ fmtMoney(r.total) }}</td><td class="num">{{ fmtMoney(r.avg_cost) }}</td>
                <td class="num">{{ r.days_to_confirm === null ? '' : fmtNumber(Math.round(r.days_to_confirm * 10) / 10) }}</td><td class="num">{{ r.days_to_receive === null ? '' : fmtNumber(Math.round(r.days_to_receive * 10) / 10) }}</td>
                <td v-if="compare" class="num">{{ fmtMoney(r.previous?.total) }}</td><td v-if="compare" class="num" data-testid="analysis-change">{{ change(r) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <div v-else-if="tab === 'cost'" class="scroll-x">
        <table class="tbl" data-testid="cost-table">
          <thead><tr><th>공급사</th><th>제품</th><th>월</th><th class="num">수량</th><th class="num">평균 단가</th></tr></thead>
          <tbody><tr v-for="(r, i) in rows" :key="i" data-testid="cost-row"><td>{{ refLabel(r.partner_id) }}</td><td>{{ refLabel(r.product_id) }}</td><td>{{ r.month }}</td><td class="num">{{ fmtNumber(r.qty) }}</td><td class="num">{{ fmtMoney(r.avg_cost) }}</td></tr></tbody>
        </table>
      </div>
      <div v-else-if="tab === 'spend'" class="scroll-x">
        <table class="tbl" data-testid="spend-table">
          <thead><tr><th>{{ spendBy === 'partner' ? '공급사' : '제품 분류' }}</th><th class="num">합계</th><th style="width: 160px">비중</th></tr></thead>
          <tbody><tr v-for="(r, i) in rows" :key="i" data-testid="spend-row"><td>{{ spendBy === 'partner' ? refLabel(r.partner_id) : (r.category_id ? refLabel(r.category_id) : '(없음)') }}</td><td class="num" data-testid="spend-total">{{ fmtMoney(r.total) }}</td><td><div class="meter"><i :style="{ width: `${totalSpend ? (Number(r.total) / totalSpend) * 100 : 0}%` }"></i></div></td></tr></tbody>
        </table>
      </div>
      <div v-else class="scroll-x">
        <table class="tbl" data-testid="prices-table">
          <thead><tr><th>제품</th><th>내부 참조</th><th>공급사</th><th class="num">최소 수량</th><th class="num">단가</th><th class="num">할인(%)</th><th class="num">납기(일)</th><th>공급사 코드</th><th>시작일</th><th>종료일</th></tr></thead>
          <tbody><tr v-for="r in rows" :key="r.id" data-testid="price-row"><td><router-link :to="{ name: 'record', params: { type: 'product', id: r.product_id } }">{{ r.product }}</router-link></td><td>{{ r.internal_ref }}</td><td>{{ r.partner }}</td><td class="num">{{ fmtNumber(r.min_qty) }}</td><td class="num">{{ fmtMoney(r.price) }}</td><td class="num">{{ fmtNumber(r.discount) }}</td><td class="num">{{ fmtNumber(r.delay_days) }}</td><td>{{ r.vendor_code }}</td><td>{{ r.date_start }}</td><td>{{ r.date_end }}</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chart-box { padding: 12px 16px 0; }
</style>

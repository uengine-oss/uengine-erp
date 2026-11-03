<script setup lang="ts">
// Sales by region, product and period: what was sold, read straight from the ledger. No model, so no interval.
import { computed, onMounted, ref, watch } from 'vue'
import { fetchModels, type ModelRow } from '../../lib/analytics'
import { messageOf, rpc } from '../../lib/api'
import { fmtDay } from '../../lib/format'
import { timeView } from '../../lib/mode'
import { ensureNames, refLabel } from '../../lib/refs'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'
import ColumnChart from './ColumnChart.vue'
import ValueBar from './ValueBar.vue'
import { fmtMoneyPlain, fmtQty, moneyWithUnit } from './fmt'

interface Row { period: string; region: string | null; product_id: string; qty: number; revenue: number; margin: number; orders: number }

const today = () => timeView.date || fmtDay(new Date().toISOString())
const monthsBack = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() - n)
  return d.toISOString().slice(0, 10)
}
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)

const to = ref(today())
const from = ref(monthsBack(to.value, 12))
const grain = ref('month')
const region = ref('')
const product = ref('')
const rows = ref<Row[]>([])
const model = ref<ModelRow | null>(null)
const loading = ref(true)
const error = ref('')
let seq = 0

async function load() {
  // A date being retyped is briefly empty; the last answer stays until it is whole again.
  if (!from.value || !to.value) return
  const my = ++seq
  loading.value = true
  error.value = ''
  try {
    const [stats, models] = await Promise.all([
      rpc<{ rows: Row[] }>('erp_flow_stats', { p_from: from.value, p_to: nextDay(to.value), p_as_of: timeView.at || null, p_grain: grain.value }),
      fetchModels(),
    ])
    await ensureNames(stats.rows.map((r) => r.product_id))
    if (my !== seq) return
    rows.value = stats.rows
    model.value = models.find((m) => m.id === 'stat_sales') ?? null
  } catch (e) {
    if (my !== seq) return
    error.value = messageOf(e)
    rows.value = []
  } finally {
    if (my === seq) loading.value = false
  }
}
onMounted(load)
watch([from, to, grain], load)
watch(() => timeView.at, () => { to.value = today(); from.value = monthsBack(to.value, 12) })

const GRAINS = [{ value: 'week', label: '주' }, { value: 'month', label: '월' }, { value: 'quarter', label: '분기' }, { value: 'year', label: '연' }]
const regionName = (r: string | null) => r || '지역 없음'
const shown = computed(() => rows.value.filter((r) => (!region.value || regionName(r.region) === region.value) && (!product.value || r.product_id === product.value)))
const regions = computed(() => [...new Set(rows.value.map((r) => regionName(r.region)))].sort())
const products = computed(() => [...new Set(rows.value.map((r) => r.product_id))].sort((a, b) => refLabel(a).localeCompare(refLabel(b), 'ko')))

function totalBy(key: (r: Row) => string) {
  const m = new Map<string, { key: string; qty: number; revenue: number; margin: number; orders: number }>()
  for (const r of shown.value) {
    const k = key(r)
    const x = m.get(k) ?? { key: k, qty: 0, revenue: 0, margin: 0, orders: 0 }
    x.qty += r.qty; x.revenue += r.revenue; x.margin += r.margin; x.orders += r.orders
    m.set(k, x)
  }
  return [...m.values()]
}
const periodLabel = (p: string) => (grain.value === 'year' ? p.slice(0, 4) : grain.value === 'week' ? p.slice(5, 10) : p.slice(0, 7))
const byPeriod = computed(() => totalBy((r) => r.period).sort((a, b) => a.key.localeCompare(b.key)))
const columns = computed(() => byPeriod.value.map((x) => ({ key: x.key, label: periodLabel(x.key), value: x.revenue, tip: `매출 ${moneyWithUnit(x.revenue)}, 수량 ${fmtQty(x.qty)}` })))
const byRegion = computed(() => totalBy((r) => regionName(r.region)).sort((a, b) => b.revenue - a.revenue))
const byProduct = computed(() => totalBy((r) => r.product_id).sort((a, b) => b.revenue - a.revenue))
const total = computed(() => shown.value.reduce((a, r) => ({ revenue: a.revenue + r.revenue, margin: a.margin + r.margin, qty: a.qty + r.qty }), { revenue: 0, margin: 0, qty: 0 }))
const maxOf = (list: { revenue: number }[]) => list.reduce((m, x) => Math.max(m, x.revenue), 0)
</script>

<template>
  <div class="page" data-testid="stats">
    <div class="page-head">
      <div class="crumbs"><router-link to="/analytics/models">예측·what-if</router-link><Icon class="muted" name="chevron-right" :size="12" /><h1>지역·제품·시즌 통계</h1></div>
    </div>
    <div class="toolbar">
      <input v-model="from" class="input" type="date" style="width: 130px" aria-label="시작일" data-testid="stats-from" />
      <span class="muted">~</span>
      <input v-model="to" class="input" type="date" style="width: 130px" aria-label="종료일" data-testid="stats-to" />
      <div class="seg" role="group" aria-label="묶는 단위">
        <button v-for="g in GRAINS" :key="g.value" type="button" :class="{ on: grain === g.value }" :aria-pressed="grain === g.value" :data-testid="`stats-grain-${g.value}`" @click="grain = g.value">{{ g.label }}</button>
      </div>
      <select v-model="region" class="select" style="width: 130px" aria-label="지역" data-testid="stats-region"><option value="">모든 지역</option><option v-for="r in regions" :key="r" :value="r">{{ r }}</option></select>
      <select v-model="product" class="select" style="width: 170px" aria-label="제품" data-testid="stats-product"><option value="">모든 제품</option><option v-for="p in products" :key="p" :value="p">{{ refLabel(p) }}</option></select>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert" data-testid="stats-error">
      <Icon name="alert" /><span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" @click="load">다시 시도</button>
    </div>
    <div class="page-body page-pad">
      <template v-if="shown.length">
        <dl class="tiles">
          <div><dt>매출</dt><dd data-testid="stats-revenue">{{ moneyWithUnit(total.revenue) }}</dd></div>
          <div><dt>마진</dt><dd>{{ moneyWithUnit(total.margin) }}</dd></div>
          <div><dt>수량</dt><dd>{{ fmtQty(total.qty) }}</dd></div>
        </dl>
        <section class="panel">
          <h2>기간별 매출</h2>
          <ColumnChart :rows="columns" :format="fmtMoneyPlain" description="기간별 매출 막대 그래프. 같은 값이 아래 표에 있습니다" />
        </section>
        <div class="two">
          <section class="panel">
            <h2>지역별</h2>
            <table class="tbl" data-testid="stats-by-region">
              <thead><tr><th>지역</th><th class="num">매출</th><th style="width: 30%"></th><th class="num">수량</th></tr></thead>
              <tbody><tr v-for="x in byRegion" :key="x.key"><td>{{ x.key }}</td><td class="num">{{ fmtMoneyPlain(x.revenue) }}</td><td><ValueBar :value="x.revenue" :max="maxOf(byRegion)" /></td><td class="num">{{ fmtQty(x.qty) }}</td></tr></tbody>
            </table>
          </section>
          <section class="panel">
            <h2>제품별</h2>
            <table class="tbl" data-testid="stats-by-product">
              <thead><tr><th>제품</th><th class="num">매출</th><th style="width: 30%"></th><th class="num">마진</th></tr></thead>
              <tbody><tr v-for="x in byProduct" :key="x.key"><td>{{ refLabel(x.key) }}</td><td class="num">{{ fmtMoneyPlain(x.revenue) }}</td><td><ValueBar :value="x.revenue" :max="maxOf(byProduct)" /></td><td class="num">{{ fmtMoneyPlain(x.margin) }}</td></tr></tbody>
            </table>
          </section>
        </div>
        <section class="panel">
          <h2>기간별 표</h2>
          <div class="scroll">
            <table class="tbl" data-testid="stats-by-period">
              <thead><tr><th>기간</th><th class="num">매출</th><th class="num">마진</th><th class="num">수량</th><th class="num">주문</th></tr></thead>
              <tbody><tr v-for="x in byPeriod" :key="x.key"><td>{{ periodLabel(x.key) }}</td><td class="num">{{ fmtMoneyPlain(x.revenue) }}</td><td class="num">{{ fmtMoneyPlain(x.margin) }}</td><td class="num">{{ fmtQty(x.qty) }}</td><td class="num">{{ fmtQty(x.orders) }}</td></tr></tbody>
            </table>
          </div>
        </section>
      </template>
      <EmptyState v-else-if="!loading && !error" title="이 기간의 판매 기록이 없습니다" :text="model?.state === 'locked' ? model.evidence.message : '주문이 확정되면 여기에 나타납니다. 기간을 넓혀 보세요.'">
        <router-link v-if="model?.state === 'locked'" class="btn" to="/settings/modules">모듈 화면으로</router-link>
      </EmptyState>
    </div>
  </div>
</template>

<style scoped>
.crumbs { display: flex; align-items: center; gap: 6px; }
.tiles { display: flex; flex-wrap: wrap; gap: 8px 28px; margin: 0 0 12px; }
.tiles dt { color: var(--text-2); font-size: 12px; }
.tiles dd { margin: 0; font-size: 18px; font-weight: 650; font-variant-numeric: tabular-nums; }
.panel { margin-bottom: 12px; padding: 10px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); min-width: 0; }
.panel h2 { margin-bottom: 8px; font-size: 13px; }
.panel .tbl th { position: static; }
.two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.scroll { overflow-x: auto; }
@media (max-width: 720px) { .two { grid-template-columns: minmax(0, 1fr); } .panel { overflow-x: auto; } }
</style>

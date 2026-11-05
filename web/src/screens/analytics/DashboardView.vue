<script setup lang="ts">
// 현황판: this month against last month, a year of revenue, what sells, stock on hand and whether the books balance.
// One call to the read models, not the ledger, so it opens at once; it reads again whenever they take in new events.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { messageOf } from '../../lib/api'
import { fmtNumber } from '../../lib/format'
import { timeView } from '../../lib/mode'
import { agoText, fetchDashboard, freshnessText, readModelStatus, signatureOf, tickReadModels, type Dashboard } from '../../lib/readModels'
import { onLedgerEvent } from '../../lib/realtime'
import EmptyState from '../../components/EmptyState.vue'
import LoadError from '../../components/LoadError.vue'
import ColumnChart from './ColumnChart.vue'
import ValueBar from './ValueBar.vue'
import { fmtMoneyPlain, fmtQty, moneyWithUnit } from './fmt'

const data = shallowRef<Dashboard | null>(null)
const error = ref('')
const loading = ref(true)
const nowMs = ref(Date.now())
let lastSig = ''
let seq = 0

async function load() {
  if (timeView.at) { loading.value = false; return }
  const my = ++seq
  try {
    const d = await fetchDashboard()
    if (my !== seq) return
    data.value = d
    lastSig = signatureOf(d.freshness)
    error.value = ''
  } catch (e) {
    if (my === seq) error.value = messageOf(e)
  } finally {
    if (my === seq) loading.value = false
  }
}

// New events: let the read models take them in, and read again only if they moved. Cron does the same every few seconds,
// so this also notices what someone else's work brought in.
let polling = false
async function poll() {
  if (polling || timeView.at || document.hidden) return
  polling = true
  try {
    await tickReadModels(1000).catch(() => null)
    const st = await readModelStatus()
    if (signatureOf(st.models) !== lastSig) await load()
  } catch { /* the next round tries again */ } finally { polling = false }
}

let every: ReturnType<typeof setInterval> | undefined
let clock: ReturnType<typeof setInterval> | undefined
let soon: ReturnType<typeof setTimeout> | undefined
onMounted(() => {
  void load()
  every = setInterval(poll, 4000)
  clock = setInterval(() => { nowMs.value = Date.now() }, 1000)
})
onBeforeUnmount(() => { clearInterval(every); clearInterval(clock); clearTimeout(soon) })
onLedgerEvent(() => { clearTimeout(soon); soon = setTimeout(poll, 300) })
watch(() => timeView.at, () => { void load() })

const fresh = computed(() => (data.value ? freshnessText(data.value.freshness, nowMs.value) : ''))
const s = computed(() => data.value?.sales)
const change = (now: number, before: number): string => {
  if (!before) return ''
  const p = Math.round(((now - before) / Math.abs(before)) * 100)
  return p > 0 ? `+${p}%` : `${p}%`
}
const dayOf = (iso: string) => Number(iso.slice(8, 10))
const months = computed(() => {
  const d = data.value
  if (!d?.sales) return []
  const by = new Map(d.sales.trend.map((m) => [m.month, m]))
  const [y, m] = d.on.split('-').map(Number)
  return Array.from({ length: 12 }, (_, i) => {
    const t = new Date(Date.UTC(y, m - 12 + i, 1))
    const key = t.toISOString().slice(0, 7)
    const row = by.get(key)
    return { key, label: `${t.getUTCMonth() + 1}월`, value: Number(row?.revenue ?? 0), tip: `${key} 매출 ${moneyWithUnit(Number(row?.revenue ?? 0))}, 수량 ${fmtQty(Number(row?.qty ?? 0))}` }
  })
})
const topMax = computed(() => Math.max(0, ...(s.value?.top ?? []).map((t) => Number(t.revenue))))
const whMax = computed(() => Math.max(0, ...(data.value?.stock?.by_warehouse ?? []).map((w) => Number(w.qty ?? 0))))
const nothing = computed(() => data.value && !data.value.sales && !data.value.stock && !data.value.books)
const lastRefreshed = computed(() => data.value?.freshness.filter((m) => m.readable).map((m) => m.refreshed_at).filter((x): x is string => !!x).sort().at(-1) ?? null)
</script>

<template>
  <div class="page" data-testid="dashboard">
    <div class="page-head">
      <h1>현황판</h1>
      <span v-if="data && !timeView.at" class="muted small head-note" data-testid="dash-freshness" :title="`읽기 모델에서 읽었습니다. 원장 전체를 다시 계산하지 않습니다.`">{{ fresh }}<template v-if="fresh"> · </template>읽는 데 {{ fmtNumber(data.read_ms) }} ms</span>
      <div class="grow"></div>
      <router-link class="btn" to="/analytics/stats">매출 통계</router-link>
    </div>
    <LoadError :message="error" @retry="load" />
    <div class="page-body report-pad">
      <EmptyState v-if="timeView.at" title="현황판은 지금 기준입니다" text="과거 시점의 숫자는 매출 통계와 예측 화면에서 보세요.">
        <router-link class="btn" to="/analytics/stats">매출 통계로</router-link>
      </EmptyState>
      <template v-else-if="data">
        <section v-if="s" class="report-section" data-testid="dash-sales">
          <h2>매출 <span class="muted small note">이번 달 {{ dayOf(s.this_month.from) }}~{{ dayOf(s.this_month.to) }}일, 지난달은 같은 날까지</span></h2>
          <div class="stat-row">
            <div class="stat"><span class="stat-label">이번 달 매출</span><span class="stat-value" data-testid="dash-revenue">{{ moneyWithUnit(Number(s.this_month.revenue)) }}</span>
              <span class="stat-sub small muted">지난달 {{ fmtMoneyPlain(Number(s.last_month_same.revenue)) }} <b v-if="change(Number(s.this_month.revenue), Number(s.last_month_same.revenue))">{{ change(Number(s.this_month.revenue), Number(s.last_month_same.revenue)) }}</b></span></div>
            <div class="stat"><span class="stat-label">이번 달 수량</span><span class="stat-value" data-testid="dash-qty">{{ fmtQty(Number(s.this_month.qty)) }}</span>
              <span class="stat-sub small muted">지난달 {{ fmtQty(Number(s.last_month_same.qty)) }} <b v-if="change(Number(s.this_month.qty), Number(s.last_month_same.qty))">{{ change(Number(s.this_month.qty), Number(s.last_month_same.qty)) }}</b></span></div>
            <div class="stat"><span class="stat-label">이번 달 주문</span><span class="stat-value" data-testid="dash-orders">{{ fmtQty(Number(s.this_month.orders)) }}건</span>
              <span class="stat-sub small muted">지난달 {{ fmtQty(Number(s.last_month_same.orders)) }}건</span></div>
            <div class="stat"><span class="stat-label">지난달 전체 매출</span><span class="stat-value" data-testid="dash-last-month">{{ moneyWithUnit(Number(s.last_month.revenue)) }}</span>
              <span class="stat-sub small muted">주문 {{ fmtQty(Number(s.last_month.orders)) }}건</span></div>
          </div>
          <div class="two">
            <section class="panel">
              <h3>최근 12개월 매출</h3>
              <ColumnChart :rows="months" :format="fmtMoneyPlain" description="최근 12개월 월별 매출 막대 그래프" />
            </section>
            <section class="panel">
              <h3>이번 달 많이 팔린 제품</h3>
              <table v-if="s.top.length" class="tbl" data-testid="dash-top">
                <thead><tr><th>제품</th><th class="num">매출</th><th style="width: 30%"></th><th class="num">수량</th></tr></thead>
                <tbody><tr v-for="t in s.top" :key="t.product_id"><td>{{ t.name }}</td><td class="num">{{ fmtMoneyPlain(Number(t.revenue)) }}</td><td><ValueBar :value="Number(t.revenue)" :max="topMax" /></td><td class="num">{{ fmtQty(Number(t.qty)) }}</td></tr></tbody>
              </table>
              <p v-else class="muted small">이번 달 확정된 주문이 아직 없습니다.</p>
            </section>
          </div>
        </section>

        <section v-if="data.stock" class="report-section" data-testid="dash-stock">
          <h2>재고</h2>
          <div class="stat-row">
            <div class="stat"><span class="stat-label">지금 있는 수량</span><span class="stat-value" data-testid="dash-stock-qty">{{ fmtQty(Number(data.stock.qty)) }}</span></div>
            <div class="stat"><span class="stat-label">재고 있는 품목</span><span class="stat-value">{{ fmtQty(data.stock.items) }}</span></div>
            <div class="stat" :class="{ 'stat-warn': data.stock.empty }"><span class="stat-label">재고 없는 품목</span><span class="stat-value" data-testid="dash-stock-empty">{{ fmtQty(data.stock.empty) }}</span></div>
          </div>
          <section v-if="data.stock.by_warehouse.length" class="panel">
            <h3>창고별</h3>
            <table class="tbl" data-testid="dash-warehouses">
              <thead><tr><th>창고</th><th class="num">수량</th><th style="width: 30%"></th><th class="num">품목</th></tr></thead>
              <tbody><tr v-for="w in data.stock.by_warehouse" :key="w.warehouse_id ?? ''"><td>{{ w.name }}</td><td class="num">{{ fmtQty(Number(w.qty ?? 0)) }}</td><td><ValueBar :value="Number(w.qty ?? 0)" :max="whMax" /></td><td class="num">{{ fmtQty(w.items) }}</td></tr></tbody>
            </table>
          </section>
        </section>

        <section v-if="data.books" class="report-section" data-testid="dash-books">
          <h2>장부</h2>
          <div class="stat-row">
            <div class="stat" :class="{ 'stat-bad': !data.books.balanced }"><span class="stat-label">차변 합계 = 대변 합계</span><span class="stat-value" data-testid="dash-balanced">{{ data.books.balanced ? '맞습니다' : '맞지 않습니다' }}</span>
              <span class="stat-sub small muted">{{ fmtMoneyPlain(Number(data.books.debit)) }} / {{ fmtMoneyPlain(Number(data.books.credit)) }}</span></div>
            <div class="stat" :class="{ 'stat-bad': Number(data.books.this_month.result) < 0 }"><span class="stat-label">이번 달 손익</span><span class="stat-value" data-testid="dash-result">{{ moneyWithUnit(Number(data.books.this_month.result)) }}</span>
              <span class="stat-sub small muted">수익 {{ fmtMoneyPlain(Number(data.books.this_month.income)) }} · 비용 {{ fmtMoneyPlain(Number(data.books.this_month.expense)) }}</span></div>
            <div class="stat" :class="{ 'stat-bad': Number(data.books.last_month.result) < 0 }"><span class="stat-label">지난달 손익</span><span class="stat-value">{{ moneyWithUnit(Number(data.books.last_month.result)) }}</span>
              <span class="stat-sub small muted">수익 {{ fmtMoneyPlain(Number(data.books.last_month.income)) }} · 비용 {{ fmtMoneyPlain(Number(data.books.last_month.expense)) }}</span></div>
          </div>
        </section>

        <EmptyState v-if="nothing" title="볼 수 있는 숫자가 없습니다" text="이 화면의 숫자는 주문, 재고, 장부에서 옵니다. 그 기록을 볼 권한이 있으면 여기에 나타납니다." />
        <p class="muted small foot" data-testid="dash-foot"><template v-if="lastRefreshed">마지막 반영 {{ agoText(lastRefreshed, nowMs) }} · </template>숫자는 이벤트가 들어오는 대로 몇 초 안에 따라옵니다.</p>
      </template>
      <EmptyState v-else-if="!loading && !error" title="현황판을 읽지 못했습니다" text="잠시 뒤 다시 시도하세요." />
    </div>
  </div>
</template>

<style scoped>
.note { font-weight: 450; margin-left: 4px; }
.stat-sub { display: block; margin-top: 2px; }
.stat-sub b { font-weight: 600; color: var(--text-2); }
.panel { margin-top: 8px; padding: 10px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); min-width: 0; }
.panel h3 { margin: 0 0 8px; font-size: 13px; }
.panel .tbl th { position: static; }
.two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.foot { margin-top: 16px; }
@media (max-width: 720px) {
  .two { grid-template-columns: minmax(0, 1fr); }
  .panel { overflow-x: auto; }
  .head-note { flex-basis: 100%; order: 3; }
}
</style>

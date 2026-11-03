<script setup lang="ts">
// What is where. Today it reads the stock view; at a past date it adds up the ledger, which knows nothing of reservations then.
import { computed, onMounted, ref, watch } from 'vue'
import { ensureLedger, ledger, stockAtDate } from '../../lib/analytics'
import { messageOf } from '../../lib/api'
import { db } from '../../lib/conn'
import { fmtMoney, fmtNumber } from '../../lib/format'
import { timeView } from '../../lib/mode'
import { onLedgerEvent } from '../../lib/realtime'
import { ensureNames, refLabel } from '../../lib/refs'
import { catalogOf, hasRole } from '../../lib/session'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'

interface Row { variant_id: string; location_id: string | null; warehouse_id: string | null; lot_id: string | null; on_hand: number; reserved: number; available: number; incoming: number; outgoing: number; forecast: number; unit_cost: number; value: number }
interface PastRow { variant_id: string; warehouse_id: string | null; qty: number }

const rows = ref<Row[]>([])
const past = ref<PastRow[]>([])
const loading = ref(true)
const error = ref('')
const search = ref('')
const warehouse = ref('')
let seq = 0

async function load() {
  const my = ++seq
  error.value = ''
  loading.value = true
  try {
    if (timeView.at) {
      await ensureLedger()
      if (ledger.phase === 'error') throw new Error(ledger.error)
      const list = await stockAtDate()
      await ensureNames(list.flatMap((r) => [r.variant_id, r.warehouse_id]))
      if (my === seq) { past.value = list; rows.value = [] }
    } else {
      const { data, error: err } = await db().from('erp_stock').select('*').limit(2000)
      if (err) throw err
      const list = (data ?? []) as Row[]
      await ensureNames(list.flatMap((r) => [r.variant_id, r.location_id, r.warehouse_id, r.lot_id]))
      if (my === seq) { rows.value = list; past.value = [] }
    }
  } catch (e) {
    if (my === seq) { rows.value = []; past.value = []; error.value = e instanceof Error && !('code' in e) ? e.message : messageOf(e) }
  } finally {
    if (my === seq) loading.value = false
  }
}
onMounted(load)
watch(() => timeView.at, load)
let timer: ReturnType<typeof setTimeout> | undefined
onLedgerEvent((ev) => { if (['picking', 'stock_adjustment', 'scrap'].includes(ev.stream_type)) { clearTimeout(timer); timer = setTimeout(load, 500) } })

const warehouses = computed(() => [...new Set([...rows.value, ...past.value].map((r) => r.warehouse_id).filter((x): x is string => !!x))])
const text = computed(() => search.value.trim().toLowerCase())
const hit = (r: { variant_id: string; warehouse_id: string | null }) => (!warehouse.value || r.warehouse_id === warehouse.value) && (!text.value || refLabel(r.variant_id).toLowerCase().includes(text.value))
const shown = computed(() => rows.value.filter(hit).sort((a, b) => refLabel(a.variant_id).localeCompare(refLabel(b.variant_id), 'ko')))
const shownPast = computed(() => past.value.filter(hit).sort((a, b) => refLabel(a.variant_id).localeCompare(refLabel(b.variant_id), 'ko')))
const totalValue = computed(() => shown.value.reduce((a, r) => a + Number(r.value ?? 0), 0))
const canAdjust = computed(() => !!catalogOf('stock_adjustment') && hasRole(catalogOf('stock_adjustment')?.write_roles) && !timeView.at)
</script>

<template>
  <div class="page" data-testid="stock">
    <div class="page-head">
      <h1>재고 현황<span v-if="!timeView.at" class="page-count">재고 금액 {{ fmtMoney(totalValue) }}</span></h1>
      <div class="grow"></div>
      <router-link v-if="canAdjust" class="btn" :to="{ name: 'new', params: { type: 'stock_adjustment' } }" data-testid="stock-adjust-new"><Icon name="plus" :size="13" />재고 조정</router-link>
    </div>
    <div class="toolbar">
      <label class="search"><Icon name="search" :size="13" /><span class="sr-only">제품 검색</span><input v-model="search" class="input" type="search" placeholder="제품 검색" data-testid="stock-search" /></label>
      <select v-model="warehouse" class="select" style="width: 160px" aria-label="창고" data-testid="stock-warehouse"><option value="">모든 창고</option><option v-for="w in warehouses" :key="w" :value="w">{{ refLabel(w) }}</option></select>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert" data-testid="stock-error"><Icon name="alert" /><span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" @click="load">다시 시도</button></div>
    <div class="page-body" style="background: var(--surface)">
      <p v-if="timeView.at" class="small dim note" data-testid="stock-past-note">{{ timeView.date }} 까지의 입출고를 더한 수량입니다. 그때의 예약과 금액은 이 화면에 없습니다.</p>
      <table v-if="timeView.at ? shownPast.length : shown.length" class="tbl" data-testid="stock-table">
        <thead v-if="timeView.at"><tr><th>제품</th><th>창고</th><th class="num">수량</th></tr></thead>
        <thead v-else><tr><th>제품</th><th>위치</th><th>로트</th><th class="num">재고</th><th class="num">예약</th><th class="num">가용</th><th class="num">입고 예정</th><th class="num">출고 예정</th><th class="num">예측</th><th class="num">단가</th><th class="num">금액</th><th v-if="canAdjust"></th></tr></thead>
        <tbody v-if="timeView.at">
          <tr v-for="r in shownPast" :key="`${r.variant_id}|${r.warehouse_id}`" data-testid="stock-row"><td>{{ refLabel(r.variant_id) }}</td><td>{{ r.warehouse_id ? refLabel(r.warehouse_id) : '-' }}</td><td class="num">{{ fmtNumber(r.qty) }}</td></tr>
        </tbody>
        <tbody v-else>
          <tr v-for="r in shown" :key="`${r.variant_id}|${r.location_id}|${r.lot_id}`" data-testid="stock-row" :data-variant="r.variant_id">
            <td>{{ refLabel(r.variant_id) }}</td><td>{{ r.location_id ? refLabel(r.location_id) : '-' }}</td><td>{{ r.lot_id ? refLabel(r.lot_id) : '' }}</td>
            <td class="num" :class="{ neg: r.on_hand < 0 }" data-testid="stock-on-hand">{{ fmtNumber(r.on_hand) }}</td><td class="num">{{ fmtNumber(r.reserved) }}</td><td class="num">{{ fmtNumber(r.available) }}</td><td class="num">{{ fmtNumber(r.incoming) }}</td><td class="num">{{ fmtNumber(r.outgoing) }}</td><td class="num" :class="{ neg: r.forecast < 0 }">{{ fmtNumber(r.forecast) }}</td><td class="num">{{ fmtMoney(r.unit_cost) }}</td><td class="num">{{ fmtMoney(r.value) }}</td>
            <td v-if="canAdjust" class="num"><router-link class="btn btn-sm" :to="{ name: 'new', params: { type: 'stock_adjustment' }, query: { variant_id: r.variant_id, location_id: r.location_id } }" data-testid="stock-adjust">조정</router-link></td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-else-if="!loading && !error" :title="search || warehouse ? '조건에 맞는 재고가 없습니다' : '아직 재고가 없습니다'" text="기초 재고는 재고 조정으로 넣습니다. 입고를 처리해도 여기에 나타납니다.">
        <router-link v-if="canAdjust && !search && !warehouse" class="btn btn-primary" :to="{ name: 'new', params: { type: 'stock_adjustment' } }">재고 조정</router-link>
      </EmptyState>
    </div>
  </div>
</template>

<style scoped>
.note { padding: 6px 16px; border-bottom: 1px solid var(--line); }
.neg { color: var(--red-fg); font-weight: 600; }
</style>

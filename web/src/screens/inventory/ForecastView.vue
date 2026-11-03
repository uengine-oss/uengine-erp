<script setup lang="ts">
// One product over time: what is there, what is promised by which document, where the balance goes below zero.
import { computed, onMounted, ref, watch } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { onDataChanged, sendCommand } from '../../lib/commands'
import { db } from '../../lib/conn'
import { fmtDate, fmtNumber } from '../../lib/format'
import { rows as readRows, useLoad } from '../../lib/load'
import { writeBlock } from '../../lib/mode'
import { ensureNames, refLabel } from '../../lib/refs'
import { hasRole } from '../../lib/session'
import { canAdjustStock, canReplenish, editOnHand, replenishNow } from '../../lib/stockActions'
import { toast } from '../../lib/ui'
import EmptyState from '../../components/EmptyState.vue'
import LoadError from '../../components/LoadError.vue'

interface Doc { picking_id: string; number: string; picking_type: string; state: string; origin_name: string | null; scheduled_date: string | null; qty: number; reserved: number; goes_out: boolean; comes_in: boolean; balance: number; short: boolean }
interface Forecast { variant_id: string; on_hand: number; forecast: number; documents: Doc[] }

const props = defineProps<{ variant: string }>()
const warehouse = ref('')
const warehouses = ref<{ id: string; name: string | null }[]>([])
const busy = ref('')

const { data, loading, error, load } = useLoad(async () => {
  const res = await rpc<Forecast>('erp_stock_forecast', { p_variant_id: props.variant, p_warehouse_id: warehouse.value || null })
  await ensureNames([props.variant])
  return res
})
onMounted(async () => {
  void load()
  warehouses.value = await readRows<{ id: string; name: string | null }>(db().from('erp_records').select('id,name').eq('type', 'warehouse').eq('active', true).order('name')).catch(() => [])
})
watch(() => [props.variant, warehouse.value], load)
onDataChanged(() => { void load() })

const docs = computed(() => data.value?.documents ?? [])
const series = computed(() => [{ key: 'now', label: '지금', value: Number(data.value?.on_hand ?? 0) }, ...docs.value.map((d) => ({ key: `${d.picking_id}`, label: fmtDate(d.scheduled_date).slice(5) || d.number, value: Number(d.balance) }))])
const top = computed(() => Math.max(1, ...series.value.map((s) => Math.abs(s.value))))
const hasNeg = computed(() => series.value.some((s) => s.value < 0))
const hasPos = computed(() => series.value.some((s) => s.value > 0))
const shortCount = computed(() => docs.value.filter((d) => d.short && d.goes_out).length)

/** Goods promised before what will cover them arrives: the first later receipt that brings the balance back. */
function coveredOn(i: number): string | null {
  const d = docs.value[i]
  if (!d.short || !d.goes_out) return null
  for (let k = i + 1; k < docs.value.length; k++) {
    if (docs.value[k].comes_in && docs.value[k].balance >= 0) return fmtDate(docs.value[k].scheduled_date) || docs.value[k].number
  }
  return ''
}
const canWork = computed(() => hasRole(['inventory']) && !writeBlock.value)
async function act(d: Doc, command: 'check_availability' | 'unreserve') {
  busy.value = d.picking_id
  try {
    await sendCommand({ type: 'picking', id: d.picking_id, command })
    toast(command === 'unreserve' ? '예약을 풀었습니다. 다른 전표가 먼저 가져갈 수 있습니다.' : '재고를 확인했습니다.')
    await load()
  } catch (e) {
    toast(messageOf(e), 'error')
  } finally {
    busy.value = ''
  }
}
async function edit() { if (await editOnHand({ variantId: props.variant, current: data.value?.on_hand })) await load() }
async function replenish() { if (await replenishNow(props.variant, warehouse.value || null)) await load() }
</script>

<template>
  <div class="page" data-testid="stock-forecast">
    <div class="page-head">
      <h1>재고 예측<span class="page-count">{{ refLabel(variant) }}</span></h1>
      <div class="grow"></div>
      <select v-model="warehouse" class="select" style="width: 150px" aria-label="창고" data-testid="forecast-warehouse"><option value="">모든 창고</option><option v-for="w in warehouses" :key="w.id" :value="w.id">{{ w.name }}</option></select>
      <button v-if="canAdjustStock() && !writeBlock" type="button" class="btn" data-testid="forecast-edit" @click="edit">현재고 수정</button>
      <button v-if="canReplenish() && !writeBlock" type="button" class="btn btn-primary" data-testid="forecast-replenish" @click="replenish">보충</button>
    </div>
    <LoadError :message="error" @retry="load" />
    <div class="page-body report-pad">
      <template v-if="data">
        <div class="stat-row">
          <div class="stat"><span class="stat-label">현재고</span><span class="stat-value" data-testid="forecast-on-hand">{{ fmtNumber(data.on_hand) }}</span></div>
          <div class="stat" :class="{ 'stat-bad': data.forecast < 0 }"><span class="stat-label">예측</span><span class="stat-value" data-testid="forecast-final">{{ fmtNumber(data.forecast) }}</span></div>
          <div class="stat" :class="{ 'stat-bad': shortCount }"><span class="stat-label">모자라는 출고</span><span class="stat-value" data-testid="forecast-short">{{ shortCount }}</span></div>
        </div>
        <section class="report-section" style="margin-top: 14px">
          <h2>잔량의 흐름</h2>
          <div class="scroll-x">
            <div class="flow" role="img" :aria-label="`지금 ${fmtNumber(data.on_hand)}, 마지막 예측 ${fmtNumber(data.forecast)}`" data-testid="forecast-chart">
              <div v-for="s in series" :key="s.key" class="flow-col" :title="`${s.label}: ${fmtNumber(s.value)}`">
                <div class="flow-up" :style="{ height: hasPos ? '70px' : '0' }"><i v-if="s.value > 0" :style="{ height: `${(s.value / top) * 100}%` }"></i></div>
                <div class="flow-zero"></div>
                <div class="flow-down" :style="{ height: hasNeg ? '50px' : '0' }"><i v-if="s.value < 0" :style="{ height: `${(-s.value / top) * 100}%` }"></i></div>
                <span class="flow-num" :class="{ neg: s.value < 0 }">{{ fmtNumber(s.value) }}</span>
                <span class="flow-label">{{ s.label }}</span>
              </div>
            </div>
          </div>
        </section>
        <section class="report-section">
          <h2>문서별</h2>
          <div class="scroll-x">
            <table v-if="docs.length" class="tbl" data-testid="forecast-table">
              <thead><tr><th>예정일</th><th>전표</th><th>원본</th><th class="num">들어옴</th><th class="num">나감</th><th class="num">예약</th><th class="num">잔량</th><th>알림</th><th v-if="canWork"></th></tr></thead>
              <tbody>
                <tr v-for="(d, i) in docs" :key="d.picking_id" data-testid="forecast-row" :data-number="d.number">
                  <td>{{ fmtDate(d.scheduled_date) }}</td><td><router-link :to="{ name: 'record', params: { type: 'picking', id: d.picking_id } }">{{ d.number }}</router-link></td><td>{{ d.origin_name }}</td>
                  <td class="num">{{ d.comes_in ? fmtNumber(d.qty) : '' }}</td><td class="num">{{ d.goes_out ? fmtNumber(d.qty) : '' }}</td><td class="num">{{ fmtNumber(d.reserved) }}</td>
                  <td class="num" :class="{ neg: d.balance < 0 }" data-testid="forecast-balance">{{ fmtNumber(d.balance) }}</td>
                  <td class="wrap"><span v-if="coveredOn(i)" class="pill pill-amber" data-testid="forecast-late-supply">입고가 늦음: {{ coveredOn(i) }}</span><span v-else-if="d.short" class="pill pill-red" data-testid="forecast-no-supply">수요 초과</span></td>
                  <td v-if="canWork" class="num">
                    <button v-if="d.goes_out && d.state === 'confirmed'" type="button" class="btn btn-sm" :disabled="busy === d.picking_id" data-testid="forecast-reserve" @click="act(d, 'check_availability')">예약</button>
                    <button v-if="d.goes_out && d.state === 'ready'" type="button" class="btn btn-sm" :disabled="busy === d.picking_id" data-testid="forecast-unreserve" @click="act(d, 'unreserve')">예약 해제</button>
                  </td>
                </tr>
              </tbody>
            </table>
            <EmptyState v-else title="예정된 입출고가 없습니다" text="확정한 주문과 구매만 여기에 나옵니다. 구매 견적은 세지 않습니다." />
          </div>
        </section>
      </template>
      <EmptyState v-else-if="!loading && !error" title="이 제품을 찾을 수 없습니다" />
    </div>
  </div>
</template>

<style scoped>
.flow { display: flex; align-items: flex-end; gap: 4px; padding: 6px 2px; min-width: max-content; }
.flow-col { display: flex; flex-direction: column; align-items: center; width: 54px; }
.flow-up, .flow-down { position: relative; width: 26px; }
.flow-up i, .flow-down i { position: absolute; left: 0; right: 0; display: block; }
.flow-up i { bottom: 0; background: var(--navy-700); }
.flow-down i { top: 0; background: var(--red-fg); }
.flow-zero { width: 100%; height: 1px; background: var(--line-strong); }
.flow-num { margin-top: 3px; font-size: 11.5px; font-variant-numeric: tabular-nums; }
.flow-label { max-width: 54px; overflow: hidden; color: var(--text-3); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
</style>

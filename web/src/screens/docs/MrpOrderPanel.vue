<script setup lang="ts">
// What an order needs against what is on the shelf. The parts come from this module and the stock is stock's own answer, each in stock's
// unit, and only the colour is decided here. Nothing refuses a shortage: this is where someone sees it first.
import { computed, onMounted, ref, watch } from 'vue'
import { rpc } from '../../lib/api'
import { bus, refreshBus } from '../../lib/bus'
import { fmtDate, fmtNumber } from '../../lib/format'
import { isAdmin } from '../../lib/session'
import type { ErpRecord, State } from '../../lib/types'

const props = defineProps<{ record: ErpRecord | null; draft: State }>()
const needs = ref<State[]>([])
const avail = ref<Record<string, State>>({})
const noStock = ref(false)
const levels = ref<State[]>([])
const OPEN = ['draft', 'confirmed', 'progress']

const isOpen = computed(() => OPEN.includes(props.record?.status ?? 'draft'))
const parts = computed<State[]>(() => (props.draft?.components ?? []).filter((c: State) => c.variant_id))
const key = computed(() => JSON.stringify([parts.value.map((c) => [c.variant_id, c.qty, c.uom_id]), props.draft?.warehouse_id, props.draft?.variant_id, props.draft?.qty, props.draft?.bom_id, props.record?.version]))

let seq = 0
async function load() {
  const my = ++seq
  if (!isOpen.value || !parts.value.length) { needs.value = []; avail.value = {}; levels.value = []; return }
  try {
    const list = await rpc<State[]>('erp_mrp_need', { p_components: parts.value })
    if (my !== seq) return
    needs.value = list
  } catch { needs.value = []; return }
  try {
    const list = await rpc<State[]>('erp_stock_availability', { p_variant_ids: [...new Set(needs.value.map((c) => c.variant_id))], p_warehouse_id: props.draft?.warehouse_id ?? null })
    if (my !== seq) return
    avail.value = Object.fromEntries(list.map((a) => [a.variant_id, a]))
    noStock.value = false
  } catch { avail.value = {}; noStock.value = true }
  try {
    const r = await rpc<{ lines: State[] }>('erp_mrp_explode', { p_variant_id: props.draft?.variant_id, p_qty: Number(props.draft?.qty ?? 1), p_uom_id: props.draft?.uom_id ?? null, p_bom_id: props.draft?.bom_id ?? null })
    if (my !== seq) return
    levels.value = r.lines.some((l) => l.depth > 0) ? r.lines : []
  } catch { levels.value = [] }
}
watch(key, load, { immediate: true })
onMounted(() => { if (isAdmin()) void refreshBus() })

const shortBy = (c: State): number => Math.max(0, Number(c.qty ?? 0) - Number(avail.value[c.variant_id]?.available ?? 0))
const anyShort = computed(() => needs.value.some((c) => avail.value[c.variant_id] && shortBy(c) > 0))
const stockStalled = computed(() => bus.subs.some((s) => s.name === 'inventory.making' && s.failures > 0))
const stockOff = computed(() => bus.modules.some((m) => m.id === 'inventory' && !m.enabled))
</script>

<template>
  <section v-if="isOpen && needs.length" class="form-note no-print" data-testid="mrp-parts">
    <h2>자재 가용 상태</h2>
    <p v-if="noStock" class="small muted" data-testid="mrp-no-stock">재고 모듈이 꺼져 있어 가용 수량을 볼 수 없습니다.</p>
    <div v-else class="scroll-x">
      <table class="tbl">
        <thead><tr><th>자재</th><th class="num">필요</th><th class="num">현재고</th><th class="num">가용</th><th class="num">부족</th><th>상태</th><th>다음 입고</th></tr></thead>
        <tbody>
          <tr v-for="c in needs" :key="c.id" data-testid="mrp-part-row">
            <td>{{ c.name }}</td>
            <td class="num" data-testid="mrp-part-need">{{ fmtNumber(c.qty) }}</td>
            <td class="num" data-testid="mrp-part-on-hand">{{ fmtNumber(avail[c.variant_id]?.on_hand) }}</td>
            <td class="num" data-testid="mrp-part-available">{{ fmtNumber(avail[c.variant_id]?.available) }}</td>
            <td class="num" :class="{ neg: shortBy(c) > 0 }" data-testid="mrp-part-short">{{ shortBy(c) > 0 ? fmtNumber(shortBy(c)) : '' }}</td>
            <td><span class="pill" :class="shortBy(c) > 0 ? 'pill-red' : 'pill-green'" data-testid="mrp-part-state">{{ shortBy(c) > 0 ? '부족' : '충분' }}</span></td>
            <td>{{ fmtDate(avail[c.variant_id]?.next_incoming_date) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="anyShort" class="small err-text" data-testid="mrp-short-note">자재가 모자랍니다. 그래도 확정하고 완료할 수 있고, 완료하면 재고가 음수가 됩니다. 자재는 있는데 기록이 늦은 경우가 있기 때문입니다.</p>
    <template v-if="levels.length">
      <h2 class="sub">아래 단계까지 펼치면</h2>
      <p class="small muted">반제품은 자기 제조 지시로 만듭니다. 이 지시가 대신 만들지 않습니다.</p>
      <div class="scroll-x">
        <table class="tbl" data-testid="mrp-levels">
          <thead><tr><th>자재</th><th class="num">이 지시에 드는 양</th></tr></thead>
          <tbody>
            <tr v-for="(l, i) in levels" :key="i" data-testid="mrp-level-row">
              <td :style="{ paddingLeft: `${8 + Number(l.depth) * 14}px` }">{{ l.name }}<span v-if="l.has_bom" class="tag" style="margin-left: 4px">반제품</span></td>
              <td class="num">{{ fmtNumber(l.qty) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
  <section v-if="record?.state.stock_state === 'pending'" class="form-note no-print" data-testid="mrp-stock-pending">
    <h2>재고 반영 대기</h2>
    <p v-if="stockOff" class="small">재고 모듈이 꺼져 있어 아직 재고가 움직이지 않았습니다. 켤 때 밀린 이벤트를 처리하면 이어서 반영합니다.</p>
    <p v-else-if="stockStalled" class="small err-text">재고 모듈이 멈춰 있어 아직 재고가 움직이지 않았습니다. <router-link to="/settings/bus">이벤트 버스</router-link>에서 고치면 이어서 반영합니다. 제조 기록은 그대로 있습니다.</p>
    <p v-else class="small">재고 모듈이 처리하면 재고가 움직입니다. 제조 기록은 이미 남았습니다.</p>
  </section>
</template>

<style scoped>
.form-note { margin-top: 14px; }
.form-note h2 { margin-bottom: 4px; font-size: 13px; }
.form-note h2.sub { margin-top: 12px; }
.form-note p { margin: 4px 0; }
</style>

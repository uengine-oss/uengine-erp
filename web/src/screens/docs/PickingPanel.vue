<script setup lang="ts">
// Each line of a slip against what is actually free. The numbers are the database's; only the colour is decided here.
import { computed, ref, watch } from 'vue'
import { rpc } from '../../lib/api'
import { fmtDate, fmtNumber } from '../../lib/format'
import { refLabel } from '../../lib/refs'
import type { ErpRecord, State } from '../../lib/types'

const props = defineProps<{ record: ErpRecord | null }>()
const avail = ref<Record<string, State>>({})
const OPEN = ['draft', 'waiting', 'confirmed', 'ready']
const isOpen = computed(() => OPEN.includes(String(props.record?.status)))
const moves = computed<State[]>(() => (props.record?.state.moves ?? []).filter((m: State) => m.variant_id))

async function load() {
  if (!isOpen.value || !moves.value.length) return
  try {
    const list = await rpc<State[]>('erp_stock_availability', { p_variant_ids: [...new Set(moves.value.map((m) => m.variant_id))], p_warehouse_id: props.record?.state.warehouse_id ?? null })
    avail.value = Object.fromEntries(list.map((a) => [a.variant_id, a]))
  } catch { avail.value = {} }
}
watch(() => [props.record?.id, props.record?.version], load, { immediate: true })

const need = (m: State) => Number(m.demand ?? 0) - Number(m.reserved ?? 0)
function pill(m: State): { text: string; color: string } {
  if (need(m) <= 0) return { text: '예약 완료', color: 'green' }
  if (Number(avail.value[m.variant_id]?.available ?? 0) >= need(m)) return { text: '가용, 미예약', color: 'blue' }
  return { text: '부족', color: 'red' }
}
const incoming = computed(() => props.record?.state.picking_type === 'incoming')
const rowsShown = computed(() => (props.record?.status === 'done' ? moves.value.filter((m) => Number(m.done ?? 0) !== Number(m.demand ?? 0)) : moves.value))
</script>

<template>
  <section v-if="(isOpen && !incoming && moves.length) || (record?.status === 'done' && rowsShown.length)" class="form-note no-print" data-testid="picking-availability">
    <h2>{{ isOpen ? '가용 상태' : '요구와 처리의 차이' }}</h2>
    <div class="scroll-x">
      <table class="tbl">
        <thead v-if="isOpen"><tr><th>제품</th><th class="num">요구</th><th class="num">예약</th><th class="num">남은 수량</th><th class="num">가용</th><th>상태</th><th>다음 입고</th></tr></thead>
        <thead v-else><tr><th>제품</th><th class="num">요구</th><th class="num">처리</th><th class="num">차이</th></tr></thead>
        <tbody v-if="isOpen">
          <tr v-for="m in rowsShown" :key="m.id" data-testid="availability-row">
            <td>{{ m.name ?? refLabel(m.variant_id) }}</td><td class="num">{{ fmtNumber(m.demand) }}</td><td class="num">{{ fmtNumber(m.reserved) }}</td><td class="num" :class="{ neg: need(m) > 0 }">{{ fmtNumber(need(m)) }}</td>
            <td class="num">{{ fmtNumber(avail[m.variant_id]?.available) }}</td><td><span class="pill" :class="`pill-${pill(m).color}`" data-testid="availability-state">{{ pill(m).text }}</span></td><td>{{ fmtDate(avail[m.variant_id]?.next_incoming_date) }}</td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="m in rowsShown" :key="m.id" data-testid="availability-row"><td>{{ m.name ?? refLabel(m.variant_id) }}</td><td class="num">{{ fmtNumber(m.demand) }}</td><td class="num">{{ fmtNumber(m.done) }}</td><td class="num neg">{{ fmtNumber(Number(m.done ?? 0) - Number(m.demand ?? 0)) }}</td></tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.form-note { margin-top: 14px; }
.form-note h2 { margin-bottom: 4px; font-size: 13px; }
</style>

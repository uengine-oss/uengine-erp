<script setup lang="ts">
// How much of this product there is and what keeps it stocked, on the product itself.
import { computed, ref, watch } from 'vue'
import { rpc } from '../../lib/api'
import { db } from '../../lib/conn'
import { fmtNumber } from '../../lib/format'
import { rows } from '../../lib/load'
import { refLabel, ensureNames } from '../../lib/refs'
import { catalogOf } from '../../lib/session'
import { canCommand } from '../../lib/fields'
import { writeBlock } from '../../lib/mode'
import type { ErpRecord, State } from '../../lib/types'

const props = defineProps<{ record: ErpRecord | null }>()
const variants = computed<State[]>(() => props.record?.state.variants ?? [])
const stock = ref<State[]>([])
const rules = ref<{ id: string; state: State }[]>([])
const on = computed(() => !!catalogOf('picking') && !!props.record && !!props.record.state.is_storable)
const canAddRule = computed(() => { const d = catalogOf('reorder_rule'); return !!d && canCommand(d, 'create') && !writeBlock.value })

async function load() {
  if (!on.value || !variants.value.length) return
  const ids = variants.value.map((v) => v.id)
  try {
    stock.value = await rpc<State[]>('erp_stock_availability', { p_variant_ids: ids })
    rules.value = await rows<{ id: string; state: State }>(db().from('erp_records').select('id,state').eq('type', 'reorder_rule').eq('active', true).in('state->>variant_id', ids))
    await ensureNames([...ids, ...rules.value.map((r) => r.state.location_id)])
  } catch { /* the product's own form still stands */ }
}
watch(() => [props.record?.id, props.record?.version], load, { immediate: true })
const nameOf = (id: string) => variants.value.find((v) => v.id === id)?.name ?? refLabel(id)
</script>

<template>
  <section v-if="on" class="form-note" data-testid="product-stock">
    <h2>재고와 재주문</h2>
    <div class="scroll-x">
      <table class="tbl">
        <thead><tr><th>변형</th><th class="num">현재고</th><th class="num">가용</th><th class="num">입고 예정</th><th class="num">출고 예정</th><th class="num">예측</th></tr></thead>
        <tbody><tr v-for="s in stock" :key="s.variant_id" data-testid="product-stock-row"><td>{{ nameOf(s.variant_id) }}</td><td class="num">{{ fmtNumber(s.on_hand) }}</td><td class="num">{{ fmtNumber(s.available) }}</td><td class="num">{{ fmtNumber(s.incoming) }}</td><td class="num">{{ fmtNumber(s.outgoing) }}</td><td class="num" :class="{ neg: s.forecast < 0 }">{{ fmtNumber(s.forecast) }}</td></tr></tbody>
      </table>
    </div>
    <div class="row-wrap" style="margin-top: 6px">
      <router-link v-for="r in rules" :key="r.id" class="tag" :to="{ name: 'record', params: { type: 'reorder_rule', id: r.id } }" data-testid="product-rule">{{ nameOf(r.state.variant_id) }} · 최소 {{ fmtNumber(r.state.min_qty) }} / 최대 {{ fmtNumber(r.state.max_qty) }}</router-link>
      <router-link v-if="canAddRule && variants[0]" class="btn btn-sm" :to="{ name: 'new', params: { type: 'reorder_rule' }, query: { variant_id: variants[0].id } }" data-testid="product-rule-new">재주문 규칙 만들기</router-link>
    </div>
  </section>
</template>

<style scoped>
.form-note { margin-top: 14px; }
.form-note h2 { margin-bottom: 4px; font-size: 13px; }
</style>

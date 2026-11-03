<script setup lang="ts">
// What has been scrapped, from the history: scrap leaves the stock table on purpose.
import { computed, onMounted } from 'vue'
import { db } from '../../lib/conn'
import { fmtMoney, fmtNumber } from '../../lib/format'
import { rows, useLoad } from '../../lib/load'
import { ensureNames, refLabel } from '../../lib/refs'
import { onDataChanged } from '../../lib/commands'
import EmptyState from '../../components/EmptyState.vue'
import LoadError from '../../components/LoadError.vue'

interface Row { location_id: string; variant_id: string; product_id: string; lot_id: string | null; qty: number; value: number }
const { data, loading, error, load } = useLoad(async () => {
  const list = await rows<Row>(db().from('erp_stock_scrapped').select('*').limit(1000))
  await ensureNames(list.flatMap((r) => [r.variant_id, r.location_id, r.lot_id]))
  return list
})
onMounted(load)
onDataChanged(() => { void load() })
const list = computed(() => data.value ?? [])
const total = computed(() => list.value.reduce((n, r) => n + Number(r.value ?? 0), 0))
</script>

<template>
  <div class="page" data-testid="stock-scrapped">
    <div class="page-head"><h1>폐기 현황<span class="page-count">금액 {{ fmtMoney(total) }}</span></h1><div class="grow"></div><router-link class="btn" :to="{ name: 'list', params: { type: 'scrap' } }">폐기 문서</router-link></div>
    <LoadError :message="error" @retry="load" />
    <div class="page-body" style="background: var(--surface)">
      <table v-if="list.length" class="tbl" data-testid="scrapped-table">
        <thead><tr><th>제품</th><th>폐기 위치</th><th>로트</th><th class="num">누적 수량</th><th class="num">금액</th></tr></thead>
        <tbody><tr v-for="r in list" :key="`${r.variant_id}|${r.location_id}|${r.lot_id}`" data-testid="scrapped-row"><td>{{ refLabel(r.variant_id) }}</td><td>{{ refLabel(r.location_id) }}</td><td>{{ r.lot_id ? refLabel(r.lot_id) : '' }}</td><td class="num">{{ fmtNumber(r.qty) }}</td><td class="num">{{ fmtMoney(r.value) }}</td></tr></tbody>
      </table>
      <EmptyState v-else-if="!loading && !error" title="폐기한 것이 없습니다" text="폐기를 처리하면 품목별로 쌓입니다." />
    </div>
  </div>
</template>

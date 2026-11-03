<script setup lang="ts">
// Every variant of every product in one list. A variant is edited on its product.
import { computed, ref, watch } from 'vue'
import { db } from '../../lib/conn'
import { toApiError } from '../../lib/api'
import { variantFilter } from '../../lib/query'
import { useLoad } from '../../lib/load'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'
import LoadError from '../../components/LoadError.vue'

interface Row { id: string; product_id: string; name: string | null; sku: string | null; barcode: string | null; active: boolean }
const PAGE = 50
const search = ref('')
const archived = ref(false)
const page = ref(1)
const total = ref(0)

const { data, loading, error, load } = useLoad(async () => {
  let q = db().from('erp_variants').select('id,product_id,name,sku,barcode,active', { count: 'exact' }).order('name').order('id')
  if (!archived.value) q = q.eq('active', true)
  if (search.value.trim()) q = q.or(variantFilter(search.value))
  const res = await q.range((page.value - 1) * PAGE, page.value * PAGE - 1)
  if (res.error) throw toApiError(res.error, res.status)
  total.value = res.count ?? 0
  return (res.data ?? []) as Row[]
})
watch([archived, page], load, { immediate: true })
let timer: ReturnType<typeof setTimeout> | undefined
watch(search, () => { clearTimeout(timer); timer = setTimeout(() => { page.value = 1; void load() }, 250) })
const rows = computed(() => data.value ?? [])
const last = computed(() => Math.max(1, Math.ceil(total.value / PAGE)))
</script>

<template>
  <div class="page" data-testid="variants">
    <div class="page-head"><h1>전체 변형<span class="page-count">{{ total.toLocaleString('ko-KR') }}건</span></h1></div>
    <div class="toolbar">
      <label class="search"><Icon name="search" :size="13" /><span class="sr-only">검색</span><input v-model="search" class="input" type="search" placeholder="이름·SKU·바코드" data-testid="variants-search" /></label>
      <div class="grow"></div>
      <label class="check small dim"><input v-model="archived" type="checkbox" />사용하지 않는 변형도</label>
    </div>
    <LoadError :message="error" @retry="load" />
    <div class="page-body" style="background: var(--surface)">
      <table v-if="rows.length" class="tbl" data-testid="variants-table">
        <thead><tr><th>변형</th><th>SKU</th><th>바코드</th><th>제품</th></tr></thead>
        <tbody><tr v-for="r in rows" :key="r.id" :class="{ 'is-archived': !r.active }" data-testid="variant-row"><td>{{ r.name }}</td><td>{{ r.sku }}</td><td>{{ r.barcode }}</td><td><router-link :to="{ name: 'record', params: { type: 'product', id: r.product_id } }" data-testid="variant-product">제품 열기</router-link></td></tr></tbody>
      </table>
      <EmptyState v-else-if="!loading && !error" title="변형이 없습니다" text="제품을 만들면 변형이 함께 만들어집니다." />
    </div>
    <div v-if="total > PAGE" class="pager">
      <div class="grow"></div>
      <button type="button" class="btn btn-sm btn-icon" :disabled="page <= 1" aria-label="이전 쪽" @click="page--"><Icon name="chevron-left" :size="13" /></button>
      <span>{{ page }} / {{ last }}</span>
      <button type="button" class="btn btn-sm btn-icon" :disabled="page >= last" aria-label="다음 쪽" @click="page++"><Icon name="chevron-right" :size="13" /></button>
    </div>
  </div>
</template>

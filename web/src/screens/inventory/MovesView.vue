<script setup lang="ts">
// The stock ledger, move by move or added up. Undone work is already left out by the database.
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { rpc } from '../../lib/api'
import { db } from '../../lib/conn'
import { fmtDateTime, fmtMoney, fmtNumber } from '../../lib/format'
import { rows as readRows, useLoad } from '../../lib/load'
import { ensureNames, refLabel } from '../../lib/refs'
import { catalogOf } from '../../lib/session'
import type { State } from '../../lib/types'
import { csvBlob, saveBlob } from '../../lib/ui'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'
import LoadError from '../../components/LoadError.vue'
import RefSelect from '../../components/RefSelect.vue'
import SavedSearchBar from '../../components/SavedSearchBar.vue'

interface Move { seq: number; date: string; document_type: string; document_id: string; number: string | null; picking_type: string; variant_id: string | null; product_id: string | null; lot_id: string | null; location_from: string | null; location_to: string | null; qty: number; is_return: boolean; actor_name: string | null; reason: string | null }

const PAGE = 100
const KINDS = [{ value: '', label: '전체' }, { value: 'incoming', label: '입고' }, { value: 'outgoing', label: '출고(반품 포함)' }, { value: 'internal', label: '내부 이동' }, { value: 'adjustment', label: '재고 조정' }, { value: 'scrap', label: '폐기' }]
const KIND_LABEL: Record<string, string> = { incoming: '입고', outgoing: '출고', internal: '내부 이동', adjustment: '조정', scrap: '폐기' }
const GROUPS = [{ value: 'picking_type', label: '유형' }, { value: 'product_id', label: '제품' }, { value: 'category_id', label: '제품 분류' }, { value: 'location_from', label: '출발' }, { value: 'location_to', label: '도착' }, { value: 'is_return', label: '반품 여부' }, { value: 'day', label: '일' }, { value: 'month', label: '월' }]

const route = useRoute()
const router = useRouter()
const tab = ref<'list' | 'report'>('list')
const kind = ref('')
const from = ref('')
const to = ref('')
const onlyReturns = ref(false)
const variant = computed(() => String(route.query.variant ?? '') || null)
const productPick = ref<string | null>(null)
const groupBy = ref<string[]>(['picking_type'])
const limit = ref(PAGE)

function moveQuery() {
  let q = db().from('erp_stock_moves').select('*')
  if (variant.value) q = q.eq('variant_id', variant.value)
  if (productPick.value) q = q.eq('product_id', productPick.value)
  if (from.value) q = q.gte('date', from.value)
  if (to.value) q = q.lt('date', new Date(Date.parse(to.value) + 86400000).toISOString().slice(0, 10))
  if (onlyReturns.value) q = q.eq('is_return', true)
  // What leaves through the outgoing door, and what comes back through it: a person looking at deliveries expects both.
  if (kind.value === 'outgoing') q = q.or('picking_type.eq.outgoing,is_return.eq.true')
  else if (kind.value) q = q.eq('picking_type', kind.value)
  return q.order('seq', { ascending: false })
}

const moves = useLoad(async () => {
  const list = await readRows<Move>(moveQuery().range(0, limit.value))
  await ensureNames(list.flatMap((m) => [m.variant_id, m.product_id, m.lot_id, m.location_from, m.location_to]))
  return list
})

const reportFilters = computed<State>(() => {
  const f: State = {}
  if (from.value) f.from = from.value
  if (to.value) f.to = to.value
  if (kind.value) f.picking_type = kind.value
  if (productPick.value) f.product_id = productPick.value
  if (onlyReturns.value) f.is_return = true
  return f
})
const report = useLoad(async () => {
  const res = await rpc<{ rows: State[] }>('erp_stock_move_report', { p_filters: reportFilters.value, p_group_by: groupBy.value })
  await ensureNames(res.rows.flatMap((r) => [r.product_id, r.category_id, r.location_from, r.location_to]))
  return res.rows
})

function refresh() { void (tab.value === 'list' ? moves.load() : report.load()) }
watch([tab, kind, from, to, onlyReturns, variant, productPick, groupBy, limit], refresh, { immediate: true, deep: true })

function toggleGroup(g: string) { groupBy.value = groupBy.value.includes(g) ? groupBy.value.filter((x) => x !== g) : [...groupBy.value, g] }
function applySaved(f: State, g: string[]) {
  from.value = f.from ?? ''
  to.value = f.to ?? ''
  kind.value = f.picking_type ?? ''
  productPick.value = f.product_id ?? null
  onlyReturns.value = !!f.is_return
  groupBy.value = g.length ? g : ['picking_type']
}
const groupLabel = (g: string) => GROUPS.find((x) => x.value === g)?.label ?? g
function groupCell(r: State, g: string) {
  const v = r[g]
  if (g === 'picking_type') return KIND_LABEL[v] ?? v
  if (g === 'is_return') return v === 'true' || v === true ? '반품' : '일반'
  return ['product_id', 'category_id', 'location_from', 'location_to'].includes(g) ? (v ? refLabel(v) : '(없음)') : v
}
const list = computed(() => (moves.data.value ?? []).slice(0, limit.value))
const hasMore = computed(() => (moves.data.value?.length ?? 0) > limit.value)
function openDoc(m: Move) {
  if (catalogOf(m.document_type)) void router.push({ name: 'record', params: { type: m.document_type, id: m.document_id } })
}
function exportCsv() {
  saveBlob(csvBlob(['일시', '참조', '제품', '로트', '출발', '도착', '수량', '유형', '반품', '처리자'], list.value.map((m) => [
    { value: fmtDateTime(m.date), numeric: false }, { value: m.number, numeric: false }, { value: refLabel(m.variant_id), numeric: false }, { value: m.lot_id ? refLabel(m.lot_id) : '', numeric: false },
    { value: refLabel(m.location_from), numeric: false }, { value: refLabel(m.location_to), numeric: false }, { value: m.qty, numeric: true }, { value: KIND_LABEL[m.picking_type] ?? m.picking_type, numeric: false }, { value: m.is_return ? '예' : '', numeric: false }, { value: m.actor_name, numeric: false },
  ])), '이동내역.csv')
}
</script>

<template>
  <div class="page" data-testid="stock-moves">
    <div class="page-head">
      <h1>이동 내역<span v-if="variant" class="page-count" data-testid="moves-variant">{{ refLabel(variant) }}</span></h1>
      <router-link v-if="variant" class="btn btn-sm btn-ghost" to="/inventory/moves" data-testid="moves-all">전체 보기</router-link>
      <div class="grow"></div>
      <button v-if="tab === 'list'" type="button" class="btn" :disabled="!list.length" data-testid="moves-csv" @click="exportCsv"><Icon name="download" :size="13" />CSV</button>
    </div>
    <div class="toolbar row-wrap">
      <div class="seg" role="group" aria-label="보기">
        <button type="button" :class="{ on: tab === 'list' }" :aria-pressed="tab === 'list'" data-testid="moves-tab-list" @click="tab = 'list'">내역</button>
        <button type="button" :class="{ on: tab === 'report' }" :aria-pressed="tab === 'report'" data-testid="moves-tab-report" @click="tab = 'report'">묶어 보기</button>
      </div>
      <select v-model="kind" class="select" style="width: 150px" aria-label="유형" data-testid="moves-kind"><option v-for="k in KINDS" :key="k.value" :value="k.value">{{ k.label }}</option></select>
      <span v-if="!variant" style="width: 180px"><RefSelect v-model="productPick" ref-type="product" placeholder="제품" aria-label="제품" /></span>
      <label class="field-inline">부터 <input v-model="from" class="input" type="date" data-testid="moves-from" /></label>
      <label class="field-inline">까지 <input v-model="to" class="input" type="date" data-testid="moves-to" /></label>
      <label class="check small dim"><input v-model="onlyReturns" type="checkbox" data-testid="moves-returns" />반품만</label>
      <SavedSearchBar v-if="tab === 'report'" report="stock_moves" :filters="reportFilters" :group-by="groupBy" @apply="applySaved" />
    </div>
    <div v-if="tab === 'report'" class="toolbar chip-row">
      <span class="muted small">묶을 항목</span>
      <button v-for="g in GROUPS" :key="g.value" type="button" class="toggle" :class="{ on: groupBy.includes(g.value) }" :aria-pressed="groupBy.includes(g.value)" :data-testid="`moves-group-${g.value}`" @click="toggleGroup(g.value)">{{ g.label }}</button>
    </div>
    <LoadError :message="tab === 'list' ? moves.error.value : report.error.value" @retry="refresh" />
    <div class="page-body" style="background: var(--surface)">
      <template v-if="tab === 'list'">
        <table v-if="list.length" class="tbl" data-testid="moves-table">
          <thead><tr><th>일시</th><th>참조</th><th>제품</th><th>로트</th><th>출발</th><th>도착</th><th class="num">수량</th><th>유형</th><th>처리자</th></tr></thead>
          <tbody>
            <tr v-for="m in list" :key="`${m.seq}|${m.variant_id}|${m.location_to}|${m.lot_id}`" class="clickable" tabindex="0" data-testid="move-row" @click="openDoc(m)" @keydown.enter="openDoc(m)">
              <td>{{ fmtDateTime(m.date).slice(0, 16) }}</td><td>{{ m.number }}</td><td>{{ refLabel(m.variant_id) }}</td><td>{{ m.lot_id ? refLabel(m.lot_id) : '' }}</td><td>{{ refLabel(m.location_from) }}</td><td>{{ refLabel(m.location_to) }}</td>
              <td class="num">{{ fmtNumber(m.qty) }}</td><td>{{ KIND_LABEL[m.picking_type] ?? m.picking_type }}<span v-if="m.is_return" class="tag" style="margin-left: 4px" data-testid="move-return">반품</span></td><td>{{ m.actor_name }}</td>
            </tr>
          </tbody>
        </table>
        <EmptyState v-else-if="!moves.loading.value && !moves.error.value" title="조건에 맞는 이동이 없습니다" text="전표를 처리하거나 재고를 조정하면 여기에 쌓입니다." />
        <div v-if="hasMore" style="padding: 10px 16px"><button type="button" class="btn" data-testid="moves-more" @click="limit += PAGE">더 보기</button></div>
      </template>
      <template v-else>
        <div v-if="report.data.value?.length" class="scroll-x">
          <table class="tbl" data-testid="moves-report">
            <thead><tr><th v-for="g in groupBy" :key="g">{{ groupLabel(g) }}</th><th class="num">이동 수</th><th class="num">수량</th><th class="num">금액</th></tr></thead>
            <tbody><tr v-for="(r, i) in report.data.value" :key="i" data-testid="moves-report-row"><td v-for="g in groupBy" :key="g">{{ groupCell(r, g) }}</td><td class="num">{{ fmtNumber(r.moves) }}</td><td class="num">{{ fmtNumber(r.qty) }}</td><td class="num">{{ fmtMoney(r.value) }}</td></tr></tbody>
          </table>
        </div>
        <EmptyState v-else-if="!report.loading.value && !report.error.value" title="조건에 맞는 이동이 없습니다" />
      </template>
    </div>
  </div>
</template>

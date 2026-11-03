<script setup lang="ts">
// A stock count: every place something is or was, a number for what was found, and applying it when ready.
// A number is kept as a draft adjustment the moment it is typed, so nobody loses a morning's count.
import { computed, onMounted, reactive, ref } from 'vue'
import { ApiError, messageOf, rpc } from '../../lib/api'
import { nudgeBus, onDataChanged, sendCommand } from '../../lib/commands'
import { db } from '../../lib/conn'
import { fmtDay, fmtNumber } from '../../lib/format'
import { rows as readRows, useLoad } from '../../lib/load'
import { writeBlock } from '../../lib/mode'
import { ensureNames, refLabel } from '../../lib/refs'
import { session, hasRole } from '../../lib/session'
import { ask, toast } from '../../lib/ui'
import type { ErpRecord, State } from '../../lib/types'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'
import LoadError from '../../components/LoadError.vue'
import NumberInput from '../../components/NumberInput.vue'

interface Line { key: string; variant_id: string; location_id: string; lot_id: string | null; warehouse_id: string | null; on_hand: number; draft: ErpRecord | null }

const { data, loading, error, load } = useLoad(async () => {
  const [stock, drafts, locations] = await Promise.all([
    readRows<State>(db().from('erp_stock').select('variant_id,location_id,lot_id,warehouse_id,on_hand').limit(5000)),
    readRows<ErpRecord>(db().from('erp_records').select('id,type,version,name,status,active,state,created_at,updated_at').eq('type', 'stock_adjustment').eq('status', 'draft').limit(5000)),
    readRows<{ id: string; state: State }>(db().from('erp_records').select('id,state').eq('type', 'location')),
  ])
  const internal = new Set(locations.filter((l) => l.state.usage === 'internal').map((l) => l.id))
  const keyOf = (v: string, l: string, lot: string | null) => `${v}|${l}|${lot ?? ''}`
  const by = new Map<string, Line>()
  for (const s of stock) {
    if (!internal.has(s.location_id)) continue
    by.set(keyOf(s.variant_id, s.location_id, s.lot_id), { key: keyOf(s.variant_id, s.location_id, s.lot_id), variant_id: s.variant_id, location_id: s.location_id, lot_id: s.lot_id, warehouse_id: s.warehouse_id, on_hand: Number(s.on_hand), draft: null })
  }
  for (const d of drafts) {
    const key = keyOf(d.state.variant_id, d.state.location_id, d.state.lot_id ?? null)
    const line = by.get(key)
    if (line) line.draft = d
    else by.set(key, { key, variant_id: d.state.variant_id, location_id: d.state.location_id, lot_id: d.state.lot_id ?? null, warehouse_id: d.state.warehouse_id ?? null, on_hand: Number(d.state.theoretical_qty ?? 0), draft: d })
  }
  const list = [...by.values()]
  await ensureNames(list.flatMap((l) => [l.variant_id, l.location_id, l.lot_id, l.warehouse_id]))
  return list.sort((a, b) => refLabel(a.location_id).localeCompare(refLabel(b.location_id), 'ko') || refLabel(a.variant_id).localeCompare(refLabel(b.variant_id), 'ko'))
})
onMounted(load)
onDataChanged(() => { if (!busy.value) void load() })

const search = ref('')
const warehouse = ref('')
const picked = ref<Set<string>>(new Set())
const typed = reactive<Record<string, number | null | undefined>>({})
const busy = ref(false)
const list = computed(() => (data.value ?? []).filter((l) => (!warehouse.value || l.warehouse_id === warehouse.value) && (!search.value.trim() || refLabel(l.variant_id).toLowerCase().includes(search.value.trim().toLowerCase()))))
const warehouses = computed(() => [...new Set((data.value ?? []).map((l) => l.warehouse_id).filter((x): x is string => !!x))])
const canWork = computed(() => hasRole(['inventory']) && !writeBlock.value)
const shown = (l: Line) => (l.key in typed ? typed[l.key] : l.draft?.state.counted_qty ?? null)
const difference = (l: Line) => { const c = shown(l); return c === null || c === undefined ? null : Number(c) - l.on_hand }
const printDate = computed(() => fmtDay(new Date().toISOString()))
const pickedLines = computed(() => list.value.filter((l) => picked.value.has(l.key)))
const allPicked = computed(() => list.value.length > 0 && list.value.every((l) => picked.value.has(l.key)))

function toggle(key: string) {
  const next = new Set(picked.value)
  if (next.has(key)) next.delete(key); else next.add(key)
  picked.value = next
}
function toggleAll() { picked.value = allPicked.value ? new Set() : new Set(list.value.map((l) => l.key)) }

async function saveCount(l: Line) {
  if (!(l.key in typed)) return
  const value = typed[l.key]
  if ((value ?? null) === (l.draft?.state.counted_qty ?? null)) { delete typed[l.key]; return }
  try {
    if (l.draft) await sendCommand({ type: 'stock_adjustment', id: l.draft.id, command: 'update', payload: { counted_qty: value }, expectedVersion: l.draft.version })
    else await sendCommand({ type: 'stock_adjustment', command: 'create', payload: { variant_id: l.variant_id, location_id: l.location_id, lot_id: l.lot_id ?? undefined, counted_qty: value } })
    delete typed[l.key]
    await load()
  } catch (e) {
    toast(messageOf(e), 'error')
  }
}

/** Only what has a number can be applied; a line without one stays as it is. */
async function apply(lines: Line[], force = false): Promise<void> {
  const ids = lines.filter((l) => l.draft).map((l) => l.draft!.id)
  if (!ids.length) { toast('실사 수량을 넣은 줄이 없습니다.', 'error'); return }
  busy.value = true
  try {
    const res = await rpc<{ done: number }>('erp_stock_adjust_many', { p_ids: ids, p_command: 'apply', p_force: force })
    nudgeBus()
    toast(`${res.done}건을 재고에 반영했습니다.`)
    picked.value = new Set()
    await load()
  } catch (e) {
    const err = e as ApiError
    if (err.code === 'ERP_STOCK_MOVED' && !force) {
      const again = await ask({ title: '실사 뒤에 재고가 움직였습니다', message: err.message.replace(/\s*\([a-z_]+\)\.?$/, ''), confirmLabel: '그래도 반영', danger: true })
      busy.value = false
      if (again) await apply(lines, true)
      return
    }
    toast(messageOf(e), 'error')
  } finally {
    busy.value = false
  }
}

/** Fills the count with what the books say, for the lines that need no second look. */
async function fillCurrent() {
  busy.value = true
  try {
    const have = pickedLines.value.filter((l) => l.draft).map((l) => l.draft!.id)
    if (have.length) await rpc('erp_stock_adjust_many', { p_ids: have, p_command: 'match' })
    for (const l of pickedLines.value.filter((x) => !x.draft)) {
      await sendCommand({ type: 'stock_adjustment', command: 'create', payload: { variant_id: l.variant_id, location_id: l.location_id, lot_id: l.lot_id ?? undefined, prefill: 'current' } })
    }
    await load()
  } catch (e) {
    toast(messageOf(e), 'error')
  } finally {
    busy.value = false
  }
}

async function addLine() {
  let values: State = {}
  let err = ''
  for (;;) {
    const answer = await ask({
      title: '실사 줄 추가', message: '재고에 없던 품목을 찾았을 때 씁니다.', error: err, values, confirmLabel: '추가',
      fields: [
        { name: 'variant_id', label: '제품', type: 'ref', ref: 'variant', required: true },
        { name: 'location_id', label: '위치', type: 'ref', ref: 'location', required: true },
        { name: 'counted_qty', label: '실사 수량', type: 'number', required: true },
        { name: 'lot_name', label: '로트 번호', type: 'text' },
      ],
    })
    if (!answer) return
    values = answer.values
    try {
      await sendCommand({ type: 'stock_adjustment', command: 'create', payload: { variant_id: values.variant_id, location_id: values.location_id, counted_qty: values.counted_qty, lot_name: values.lot_name || undefined } })
      await load()
      return
    } catch (e) {
      err = messageOf(e)
    }
  }
}
const printSheet = () => window.print()
</script>

<template>
  <div class="page" data-testid="stock-count">
    <div class="print-only count-print-head" data-testid="count-print-head">
      <strong>{{ session.company?.state?.name }} 재고 실사표</strong><span>출력일 {{ printDate }}</span><span>실사자: ____________</span>
    </div>
    <div class="page-head no-print">
      <h1>재고 실사<span class="page-count">{{ list.length }}줄</span></h1>
      <div class="grow"></div>
      <button type="button" class="btn" data-testid="count-print" @click="printSheet"><Icon name="printer" :size="13" />실사표 인쇄</button>
      <button v-if="canWork" type="button" class="btn" data-testid="count-add" @click="addLine"><Icon name="plus" :size="13" />줄 추가</button>
    </div>
    <div class="toolbar no-print">
      <label class="search"><Icon name="search" :size="13" /><span class="sr-only">제품 검색</span><input v-model="search" class="input" type="search" placeholder="제품 검색" data-testid="count-search" /></label>
      <select v-model="warehouse" class="select" style="width: 150px" aria-label="창고" data-testid="count-warehouse"><option value="">모든 창고</option><option v-for="w in warehouses" :key="w" :value="w">{{ refLabel(w) }}</option></select>
      <div class="grow"></div>
      <template v-if="canWork && picked.size">
        <span class="small" data-testid="count-picked">{{ picked.size }}줄 선택</span>
        <button type="button" class="btn btn-sm" :disabled="busy" data-testid="count-match" @click="fillCurrent">현재고로 채우기</button>
        <button type="button" class="btn btn-sm btn-primary" :disabled="busy" data-testid="count-apply" @click="apply(pickedLines)">선택 재고에 반영</button>
      </template>
    </div>
    <LoadError :message="error" @retry="load" />
    <div class="page-body" style="background: var(--surface)">
      <table v-if="list.length" class="tbl" data-testid="count-table">
        <thead><tr><th v-if="canWork" class="no-print" style="width: 30px"><input type="checkbox" :checked="allPicked" aria-label="모두 선택" data-testid="count-all" @change="toggleAll" /></th><th>위치</th><th>제품</th><th>로트</th><th class="num">현재고</th><th class="num" style="width: 120px">실사 수량</th><th class="num no-print">차이</th><th v-if="canWork" class="no-print" style="width: 70px"></th></tr></thead>
        <tbody>
          <tr v-for="l in list" :key="l.key" data-testid="count-row" :data-variant="l.variant_id">
            <td v-if="canWork" class="no-print"><input type="checkbox" :checked="picked.has(l.key)" :aria-label="`${refLabel(l.variant_id)} 선택`" data-testid="count-pick" @change="toggle(l.key)" /></td>
            <td>{{ refLabel(l.location_id) }}</td><td>{{ refLabel(l.variant_id) }}</td><td>{{ l.lot_id ? refLabel(l.lot_id) : '' }}</td>
            <td class="num" :class="{ neg: l.on_hand < 0 }" data-testid="count-on-hand">{{ fmtNumber(l.on_hand) }}</td>
            <td class="num"><NumberInput :model-value="shown(l)" :aria-label="`${refLabel(l.variant_id)} 실사 수량`" :disabled="!canWork" data-testid="count-qty" @update:model-value="typed[l.key] = $event" @change="saveCount(l)" /></td>
            <td class="num no-print" :class="{ neg: (difference(l) ?? 0) < 0 }" data-testid="count-diff">{{ difference(l) === null ? '' : fmtNumber(difference(l)) }}</td>
            <td v-if="canWork" class="num no-print"><button v-if="l.draft" type="button" class="btn btn-sm" :disabled="busy" data-testid="count-apply-one" @click="apply([l])">반영</button></td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-else-if="!loading && !error" title="실사할 재고가 없습니다" text="입고를 처리하거나 줄을 추가하면 여기에 나타납니다." />
    </div>
  </div>
</template>

<style scoped>
.count-print-head { padding-bottom: 8px; }
.count-print-head > * { margin-right: 18px; }
</style>

<script setup lang="ts">
// The same rows as a board, a calendar, a table of sums or columns. The browser only arranges what the query returned.
import { computed, ref, watch } from 'vue'
import { messageOf } from '../lib/api'
import { sendCommand } from '../lib/commands'
import { displayValue, visibleTransitions } from '../lib/fields'
import { fmtMoney, fmtNumber } from '../lib/format'
import { ensureNames } from '../lib/refs'
import type { CatalogDoc, ErpRecord, Field } from '../lib/types'
import ColumnChart from '../screens/analytics/ColumnChart.vue'
import EmptyState from './EmptyState.vue'
import Icon from './Icon.vue'
import StatusPill from './StatusPill.vue'

const props = defineProps<{ mode: string; doc: CatalogDoc; config: { date?: string; amount?: string; groups?: string[]; moves?: boolean; title?: string; subtitle?: string }; total: number; fetchRows: (limit: number) => Promise<ErpRecord[]> }>()
defineEmits<{ open: [row: ErpRecord] }>()

const LIMIT = 500
const rows = ref<ErpRecord[]>([])
const error = ref('')
const loading = ref(true)
let seq = 0

const fieldOf = (name: string | undefined): Field | undefined => props.doc.fields.find((f) => f.name === name)
const groupField = ref(props.config.groups?.[0] ?? '')
const group = computed(() => fieldOf(groupField.value))
const amount = computed(() => fieldOf(props.config.amount))

async function load() {
  const my = ++seq
  error.value = ''
  loading.value = true
  try {
    const list = await props.fetchRows(LIMIT)
    const ids = new Set<unknown>()
    for (const f of [...(props.config.groups ?? []), 'partner_id']) {
      if (fieldOf(f)?.type === 'ref') list.forEach((r) => ids.add(r.state?.[f]))
    }
    await ensureNames(ids)
    if (my === seq) rows.value = list
  } catch (e) {
    if (my === seq) { rows.value = []; error.value = messageOf(e) }
  } finally {
    if (my === seq) loading.value = false
  }
}
watch(() => [props.mode, props.total], load, { immediate: true })

const money = (r: ErpRecord) => (amount.value ? Number(r.state?.[amount.value.name] ?? 0) : 0)
const titleOf = (r: ErpRecord) => (props.config.title ? r.state?.[props.config.title] : null) ?? r.name ?? r.state?.number ?? r.id.slice(0, 8)
const subtitleOf = (r: ErpRecord) => {
  const f = fieldOf('partner_id')
  const partner = f ? displayValue(f, r.state?.partner_id) : ''
  return partner || (props.config.subtitle ? r.state?.[props.config.subtitle] ?? '' : '')
}

/* Board */
const board = computed(() => (props.doc.states ?? []).map((s) => {
  const items = rows.value.filter((r) => r.status === s.value)
  return { state: s, items, sum: items.reduce((n, r) => n + money(r), 0) }
}))

// The next step a board can take by itself: the state's main action, when it needs nothing asked. The rest opens the document.
const moveOf = (r: ErpRecord) => (props.config.moves ? visibleTransitions(props.doc, r.status).find((t) => t.primary && !t.params?.length) : undefined)
const moving = ref('')
async function move(r: ErpRecord, command: string) {
  moving.value = r.id
  error.value = ''
  try {
    await sendCommand({ type: props.doc.type, id: r.id, command, expectedVersion: r.version })
    await load()
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    moving.value = ''
  }
}

/* Calendar: a month at a time, moved by hand */
const shownMonth = ref('')
const dayOf = (r: ErpRecord) => { const f = props.config.date; return f && r.state?.[f] ? String(r.state[f]).slice(0, 10) : '' }
watch(rows, (list) => {
  const days = list.map(dayOf).filter(Boolean).sort()
  if (days.length && !days.some((d) => d.startsWith(shownMonth.value || '?'))) shownMonth.value = days[days.length - 1].slice(0, 7)
})
function stepMonth(by: number) {
  const [y, m] = shownMonth.value.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + by, 1))
  shownMonth.value = d.toISOString().slice(0, 7)
}
const cells = computed(() => {
  if (!shownMonth.value) return []
  const [y, m] = shownMonth.value.split('-').map(Number)
  const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay()
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const out: { key: string; day: number | null; items: ErpRecord[] }[] = Array.from({ length: lead }, (_, i) => ({ key: `x${i}`, day: null, items: [] }))
  for (let d = 1; d <= days; d++) {
    const iso = `${shownMonth.value}-${String(d).padStart(2, '0')}`
    out.push({ key: iso, day: d, items: rows.value.filter((r) => dayOf(r) === iso) })
  }
  return out
})

/* Sums by a chosen field, split by state */
const groupValue = (r: ErpRecord) => (group.value ? displayValue(group.value, r.state?.[group.value.name]) || '(없음)' : '')
const pivot = computed(() => {
  const by = new Map<string, Map<string, number>>()
  for (const r of rows.value) {
    const g = groupValue(r)
    const row = by.get(g) ?? new Map<string, number>()
    row.set(r.status ?? '', (row.get(r.status ?? '') ?? 0) + (amount.value ? money(r) : 1))
    by.set(g, row)
  }
  return [...by.entries()].map(([name, row]) => ({ name, row, total: [...row.values()].reduce((a, b) => a + b, 0) })).sort((a, b) => b.total - a.total)
})
const cellText = (v: number | undefined) => (v === undefined ? '' : amount.value ? fmtMoney(v) : fmtNumber(v))
const chartRows = computed(() => pivot.value.slice(0, 12).map((p) => ({ key: p.name, label: p.name, value: p.total })))
const chartFormat = (v: number) => (amount.value ? fmtMoney(v) : fmtNumber(v))
</script>

<template>
  <div class="views" data-testid="list-views">
    <div v-if="error" class="banner banner-error banner-flush" role="alert"><Icon name="alert" /><span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" @click="load">다시 시도</button></div>
    <p v-if="total > LIMIT" class="muted small views-note" data-testid="views-limited">앞의 {{ LIMIT }}건만 모았습니다. 전체 {{ total.toLocaleString('ko-KR') }}건을 보려면 조건을 좁히세요.</p>

    <div v-if="mode === 'board'" class="board" data-testid="list-board">
      <section v-for="c in board" :key="c.state.value" class="board-col" :data-state="c.state.value">
        <h3 class="board-head"><StatusPill :doc="doc" :value="c.state.value" /><span class="muted small">{{ c.items.length }}건</span><span v-if="amount" class="num small grow">{{ fmtMoney(c.sum) }}</span></h3>
        <template v-for="r in c.items" :key="r.id">
          <button type="button" class="board-card" data-testid="board-card" @click="$emit('open', r)">
            <strong class="ellipsis">{{ titleOf(r) }}</strong>
            <span v-if="subtitleOf(r)" class="dim small ellipsis">{{ subtitleOf(r) }}</span>
            <span v-if="amount" class="num small">{{ fmtMoney(money(r)) }}</span>
          </button>
          <button v-if="moveOf(r)" type="button" class="btn btn-sm board-move" :disabled="moving === r.id" data-testid="board-move" @click="move(r, moveOf(r)!.command)">{{ moveOf(r)!.label }}</button>
        </template>
      </section>
    </div>

    <div v-else-if="mode === 'calendar'" data-testid="list-calendar">
      <div class="row cal-nav">
        <button type="button" class="btn btn-sm btn-icon" aria-label="이전 달" :disabled="!shownMonth" data-testid="cal-prev" @click="stepMonth(-1)"><Icon name="chevron-left" :size="13" /></button>
        <strong data-testid="cal-month">{{ shownMonth || '날짜가 있는 문서가 없습니다' }}</strong>
        <button type="button" class="btn btn-sm btn-icon" aria-label="다음 달" :disabled="!shownMonth" data-testid="cal-next" @click="stepMonth(1)"><Icon name="chevron-right" :size="13" /></button>
      </div>
      <div class="scroll-x">
        <div class="cal">
          <div v-for="d in ['일', '월', '화', '수', '목', '금', '토']" :key="d" class="cal-head">{{ d }}</div>
          <div v-for="c in cells" :key="c.key" class="cal-cell" :class="{ blank: !c.day }">
            <span class="muted small">{{ c.day }}</span>
            <button v-for="r in c.items" :key="r.id" type="button" class="cal-item ellipsis" data-testid="cal-item" @click="$emit('open', r)">{{ titleOf(r) }}</button>
          </div>
        </div>
      </div>
    </div>

    <template v-else>
      <div v-if="(config.groups?.length ?? 0) > 1" class="row group-pick">
        <span class="dim small">묶을 항목</span>
        <div class="seg" role="group" aria-label="묶을 항목">
          <button v-for="g in config.groups" :key="g" type="button" :class="{ on: groupField === g }" :aria-pressed="groupField === g" @click="groupField = g">{{ fieldOf(g)?.label ?? g }}</button>
        </div>
      </div>
      <div v-if="mode === 'pivot' && pivot.length" class="scroll-x">
        <table class="tbl" data-testid="list-pivot">
          <thead><tr><th>{{ group?.label }}</th><th v-for="s in doc.states ?? []" :key="s.value" class="num">{{ s.label }}</th><th class="num">합계</th></tr></thead>
          <tbody><tr v-for="p in pivot" :key="p.name" data-testid="pivot-row"><td>{{ p.name }}</td><td v-for="s in doc.states ?? []" :key="s.value" class="num">{{ cellText(p.row.get(s.value)) }}</td><td class="num">{{ cellText(p.total) }}</td></tr></tbody>
        </table>
      </div>
      <div v-else-if="mode === 'chart' && chartRows.length" class="chart-box" data-testid="list-chart">
        <ColumnChart :rows="chartRows" :format="chartFormat" :description="`${group?.label ?? ''}별 ${amount?.label ?? '건수'}`" />
      </div>
      <EmptyState v-else-if="!loading && !error" title="모을 문서가 없습니다" />
    </template>
  </div>
</template>

<style scoped>
.views { min-height: 100%; }
.views-note { padding: 6px 16px; }
.board { display: flex; gap: 8px; align-items: flex-start; padding: 10px 16px; overflow-x: auto; }
.board-col { flex: 0 0 210px; min-width: 0; display: flex; flex-direction: column; gap: 5px; padding: 6px; background: var(--ink-50); border-radius: var(--radius); }
.board-head { display: flex; align-items: center; gap: 6px; margin: 0; padding: 2px; font-weight: 450; }
.board-card { display: flex; flex-direction: column; gap: 2px; min-width: 0; width: 100%; padding: 6px 8px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); text-align: left; cursor: pointer; color: inherit; }
.board-card:hover { border-color: var(--ink-400); }
.cal-nav { padding: 8px 16px; }
.cal { display: grid; grid-template-columns: repeat(7, minmax(92px, 1fr)); margin: 0 16px 16px; border-left: 1px solid var(--line); border-top: 1px solid var(--line); }
.cal-head { padding: 3px 6px; background: var(--ink-50); border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); font-size: 12px; color: var(--text-2); text-align: center; }
.cal-cell { min-height: 74px; padding: 2px 4px; display: flex; flex-direction: column; gap: 2px; min-width: 0; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.cal-cell.blank { background: var(--ink-50); }
.cal-item { display: block; width: 100%; padding: 1px 4px; border: 0; border-radius: var(--radius-sm); background: var(--navy-100); color: var(--text); font-size: 11.5px; text-align: left; cursor: pointer; }
.group-pick { padding: 8px 16px; }
.chart-box { padding: 12px 16px; }
</style>

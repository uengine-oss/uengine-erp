<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CatalogDoc, ErpEvent, Field } from '../lib/types'
import { collectRefIds, displayValue } from '../lib/fields'
import { fmtDateTime } from '../lib/format'
import { ensureNames } from '../lib/refs'
import { eventLabel, sourceColor, sourceLabel } from '../lib/eventText'
import Icon from './Icon.vue'

const props = defineProps<{ doc: CatalogDoc; events: ErpEvent[]; version: number | null; loading?: boolean; error?: string }>()
const emit = defineEmits<{ select: [version: number | null]; retry: [] }>()

const META_FIELDS: Record<string, Field> = {
  active: { name: 'active', label: '사용 여부', type: 'boolean' },
  deleted: { name: 'deleted', label: '삭제', type: 'boolean' },
}
const statusField = computed<Field>(() => ({
  name: 'state', label: '상태', type: 'enum',
  options: (props.doc.states ?? []).map((s) => ({ value: s.value, label: s.label })),
}))
function fieldOf(name: string): Field | undefined {
  if (name === 'state') return statusField.value
  return props.doc.fields.find((f) => f.name === name) ?? META_FIELDS[name]
}

interface ChangeLine { key: string; label: string; from?: string; to: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i
/** What a new record simply starts with is not news in its first history entry. */
function isBlank(v: unknown, name: string): boolean {
  return v === null || v === false || v === '' || name === 'active' || (Array.isArray(v) && !v.length)
}

function textOf(field: Field | undefined, v: unknown): string {
  const text = displayValue(field, v)
  return text === '' ? '(없음)' : text
}

function linesOf(ev: ErpEvent): ChangeLine[] {
  const out: ChangeLine[] = []
  const changes: Record<string, { from: unknown; to: unknown }> = ev.data?.changes ?? {}
  const created = ev.version === 1
  for (const [name, change] of Object.entries(changes)) {
    const f = fieldOf(name)
    // Internal ids with no catalog field mean nothing to a reader.
    if (!f && typeof change.to === 'string' && UUID_RE.test(change.to)) continue
    if (created && isBlank(change.to, name)) continue
    const hasFrom = !created && change.from !== null && change.from !== undefined
    out.push({ key: name, label: f?.label ?? name, from: hasFrom ? textOf(f, change.from) : undefined, to: textOf(f, change.to) })
  }
  const col: Record<string, { add?: any[]; set?: any[]; del?: string[] }> = ev.data?.col ?? {}
  for (const [name, op] of Object.entries(col)) {
    const f = fieldOf(name)
    const label = f?.label ?? name
    const columnsOf = (row: any) => Object.entries(row)
      .filter(([k]) => k !== 'id')
      .map(([k, v]) => {
        const c = f?.columns?.find((x) => x.name === k)
        return c ? `${c.label} ${textOf(c, v)}` : null
      })
      .filter(Boolean)
      .slice(0, 3)
      .join(', ')
    op.add?.forEach((row, i) => out.push({ key: `${name}-a${i}`, label: `${label} 줄 추가`, to: columnsOf(row) }))
    op.set?.forEach((row, i) => out.push({ key: `${name}-s${i}`, label: `${label} 줄 변경`, to: columnsOf(row) }))
    if (op.del?.length) out.push({ key: `${name}-d`, label: `${label} 줄 삭제`, to: `${op.del.length}줄` })
  }
  return out
}

const expanded = ref(new Set<number>())
const LIMIT = 5

// Newest first, as a person reads a history; the slider still runs oldest to newest.
const items = computed(() => [...props.events].reverse().map((ev) => {
  const lines = linesOf(ev)
  return { ev, lines, shown: expanded.value.has(ev.seq) ? lines : lines.slice(0, LIMIT), hidden: Math.max(0, lines.length - LIMIT) }
}))

watch(() => props.events, async (events) => {
  const ids = new Set<string>()
  for (const ev of events) {
    const after: Record<string, unknown> = {}
    const before: Record<string, unknown> = {}
    for (const [k, c] of Object.entries<any>(ev.data?.changes ?? {})) { after[k] = c.to; before[k] = c.from }
    collectRefIds(props.doc.fields, after, ids)
    collectRefIds(props.doc.fields, before, ids)
    for (const [name, op] of Object.entries<any>(ev.data?.col ?? {})) {
      const f = props.doc.fields.find((x) => x.name === name)
      if (f?.columns) [...(op.add ?? []), ...(op.set ?? [])].forEach((row) => collectRefIds(f.columns!, row, ids))
    }
  }
  try { await ensureNames(ids) } catch { /* names stay as placeholders; the history itself is intact */ }
}, { immediate: true })

const max = computed(() => props.events.length)
const position = computed(() => props.version ?? max.value)
const selectedEvent = computed(() => props.events[position.value - 1])

function onSlide(e: Event) {
  const v = Number((e.target as HTMLInputElement).value)
  emit('select', v >= max.value ? null : v)
}
function pick(index: number) {
  emit('select', index >= max.value ? null : index)
}
</script>

<template>
  <aside class="history no-print" aria-label="변경 이력" data-testid="history">
    <div class="history-head">
      <h2><Icon name="history" :size="14" />이력</h2>
      <span class="muted small">{{ events.length }}건</span>
    </div>

    <div v-if="events.length > 1" class="history-slider" data-testid="time-slider">
      <input type="range" min="1" :max="max" step="1" :value="position" aria-label="과거 시점 선택" @input="onSlide" />
      <div class="row small" style="justify-content: space-between">
        <span class="muted">처음</span>
        <span :class="version ? 'time-on' : 'muted'" data-testid="time-label">{{ version ? fmtDateTime(selectedEvent?.occurred_at) : '현재' }}</span>
      </div>
    </div>

    <div class="history-body">
      <div v-if="error" class="banner banner-error" style="margin: 8px 12px">
        <span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" @click="$emit('retry')">다시 시도</button>
      </div>
      <p v-else-if="loading && !events.length" class="muted" style="padding: 12px">불러오는 중…</p>
      <p v-else-if="!events.length" class="muted" style="padding: 12px">아직 이력이 없습니다.</p>
      <ol class="timeline">
        <li v-for="{ ev, lines, shown, hidden } in items" :key="ev.seq" :class="{ on: version === ev.version, later: version !== null && ev.version > version }" data-testid="history-item">
          <button type="button" class="timeline-head" :aria-label="`${fmtDateTime(ev.occurred_at)} 시점으로 보기`" @click="pick(ev.version)">
            <span class="timeline-title">{{ eventLabel(ev.event_type, doc.label) }}</span>
            <span class="muted small nowrap">{{ fmtDateTime(ev.occurred_at).slice(5, 16) }}</span>
          </button>
          <div class="timeline-meta">
            <span class="ellipsis">{{ ev.actor_name ?? '시스템' }}</span>
            <span class="pill" :class="`pill-${sourceColor(ev.source)}`">{{ sourceLabel(ev.source) }}</span>
          </div>
          <p v-if="ev.reason" class="timeline-reason">사유: {{ ev.reason }}</p>
          <ul v-if="lines.length" class="changes">
            <li v-for="c in shown" :key="c.key">
              <span class="change-label">{{ c.label }}</span>
              <template v-if="c.from !== undefined"><span class="change-from">{{ c.from }}</span><span class="muted"> → </span></template>
              <span class="change-to">{{ c.to }}</span>
            </li>
          </ul>
          <button v-if="hidden && !expanded.has(ev.seq)" type="button" class="btn btn-ghost btn-sm" @click="expanded.add(ev.seq)">외 {{ hidden }}건 더 보기</button>
        </li>
      </ol>
    </div>
  </aside>
</template>

<style scoped>
.history { display: flex; flex-direction: column; width: 288px; flex: none; min-height: 0; background: var(--surface); border-left: 1px solid var(--line); }
.history-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px 6px; }
.history-head h2 { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; }
.history-slider { padding: 0 12px 8px; border-bottom: 1px solid var(--line); }
.history-slider input { width: 100%; margin: 2px 0; accent-color: var(--navy-700); height: 18px; }
.time-on { color: var(--accent); font-weight: 600; }
.history-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.timeline { list-style: none; margin: 0; padding: 0; }
.timeline > li { padding: 8px 12px; border-bottom: 1px solid var(--ink-100); }
.timeline > li.on { background: var(--accent-soft); box-shadow: inset 2px 0 0 var(--accent); }
.timeline > li.later { opacity: 0.5; }
.timeline-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; width: 100%; padding: 0; border: 0; background: none; text-align: left; cursor: pointer; }
.timeline-head:hover .timeline-title { color: var(--navy-700); text-decoration: underline; }
.timeline-title { font-weight: 600; }
.timeline-meta { display: flex; align-items: center; gap: 6px; margin-top: 2px; color: var(--text-2); font-size: 12px; }
.timeline-reason { margin-top: 3px; font-size: 12px; color: var(--text-2); }
.changes { list-style: none; margin: 4px 0 0; padding: 0; font-size: 12px; }
.changes li { padding: 1px 0; word-break: break-word; }
.change-label { color: var(--text-3); margin-right: 5px; }
.change-from { color: var(--text-3); text-decoration: line-through; }
.change-to { color: var(--text); font-weight: 500; }
</style>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CatalogDoc, ErpEvent, Field } from '../lib/types'
import { collectRefIds, displayValue } from '../lib/fields'
import { fmtDateTime } from '../lib/format'
import { ensureNames } from '../lib/refs'
import { actorKind, eventLabel, sourceColor, sourceLabel } from '../lib/eventText'
import { theme } from '../lib/theme'
import Icon from './Icon.vue'

// `next` is the step this document is waiting for; the 대화 theme offers it at the top of the conversation.
const props = defineProps<{ doc: CatalogDoc; events: ErpEvent[]; version: number | null; loading?: boolean; error?: string; canRollback?: boolean; next?: { label: string } | null }>()
const emit = defineEmits<{ select: [version: number | null]; retry: []; rollbackWork: [ev: ErpEvent]; rollbackVersion: [ev: ErpEvent]; next: [] }>()

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
    // A value no catalog field names, one kept out of forms, or a block of JSON means nothing to a reader.
    if (!f || f.hidden || f.type === 'json') continue
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
        return c && !c.hidden ? `${c.label} ${textOf(c, v)}` : null
      })
      .filter(Boolean)
      .slice(0, 3)
      .join(', ')
    op.add?.forEach((row, i) => out.push({ key: `${name}-a${i}`, label: `${label} 줄 추가`, to: columnsOf(row) }))
    op.set?.forEach((row, i) => out.push({ key: `${name}-s${i}`, label: `${label} 줄 변경`, to: columnsOf(row) }))
    // Lines that exist only for bookkeeping, like where an order's slips are written down, are not shown as changes.
    if (f?.hidden) out.splice(out.length - ((op.add?.length ?? 0) + (op.set?.length ?? 0)))
    if (op.del?.length && !f?.hidden) out.push({ key: `${name}-d`, label: `${label} 줄 삭제`, to: `${op.del.length}줄` })
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
      <h2><Icon name="history" :size="14" />{{ theme === 'talk' ? `이 ${doc.label}의 작업` : '이력' }}</h2>
      <span class="muted small">{{ events.length }}건</span>
    </div>

    <div v-if="theme === 'talk' && next && !version" class="history-next" data-testid="history-next">
      <span><small>다음 일</small>{{ next.label }}</span>
      <button type="button" class="btn btn-primary btn-sm" @click="$emit('next')">지금 하기</button>
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
          <span class="actor" :class="`actor-${actorKind(ev)}`" aria-hidden="true">{{ actorKind(ev) === 'person' ? (ev.actor_name ?? '').trim().slice(0, 1) : '' }}</span>
          <button type="button" class="timeline-head" :aria-label="`${fmtDateTime(ev.occurred_at)} 시점으로 보기`" @click="pick(ev.version)">
            <span class="timeline-title"><span class="timeline-seq">#{{ ev.seq }}</span>{{ eventLabel(ev.event_type, doc.label) }}</span>
            <span class="muted small nowrap">{{ fmtDateTime(ev.occurred_at).slice(5, 16) }}</span>
          </button>
          <div class="timeline-meta">
            <span class="ellipsis">{{ ev.actor_name ?? '시스템' }}</span>
            <span class="pill" :class="`pill-${sourceColor(ev.source)}`">{{ sourceLabel(ev.source) }}</span>
          </div>
          <p v-if="ev.reason" class="timeline-reason"><span class="reason-label">사유: </span>{{ ev.reason }}</p>
          <ul v-if="lines.length" class="changes">
            <li v-for="c in shown" :key="c.key">
              <span class="change-label">{{ c.label }}</span>
              <template v-if="c.from !== undefined"><span class="change-from">{{ c.from }}</span><span class="muted"> → </span></template>
              <span class="change-to">{{ c.to }}</span>
            </li>
          </ul>
          <button v-if="hidden && !expanded.has(ev.seq)" type="button" class="btn btn-ghost btn-sm" @click="expanded.add(ev.seq)">외 {{ hidden }}건 더 보기</button>
          <div v-if="canRollback" class="timeline-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-testid="history-rollback-work" @click="$emit('rollbackWork', ev)"><Icon name="undo" :size="12" />{{ theme === 'talk' ? '이 작업 취소' : '이 작업 되돌리기' }}</button>
            <button v-if="ev.version < max" type="button" class="btn btn-ghost btn-sm" data-testid="history-rollback-version" @click="$emit('rollbackVersion', ev)">이 버전으로 되돌리기</button>
          </div>
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
.timeline-actions { display: flex; flex-wrap: wrap; gap: 2px; margin: 4px 0 0 -7px; }
.actor, .timeline-seq { display: none; }
@media (max-width: 720px) {
  .history { width: 100%; border-left: 0; border-top: 1px solid var(--line); }
  .history-body { overflow: visible; }
}

@media screen {
  /* 대화: the history reads as who did what, each with a face, and what they said about it. */
  :root[data-theme='talk'] .history { background: var(--bg); }
  :root[data-theme='talk'] .history-head { padding: 12px 16px 8px; }
  :root[data-theme='talk'] .history-head h2 { font-size: 14.5px; font-weight: 750; letter-spacing: -0.01em; }
  :root[data-theme='talk'] .history-next { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0 14px 10px; padding: 9px 10px 9px 12px; border: 1.5px dashed var(--navy-300); border-radius: 12px; background: var(--navy-50); font-weight: 650; }
  :root[data-theme='talk'] .history-next small { display: block; font-size: 11px; font-weight: 600; color: var(--brand-ink); }
  :root[data-theme='talk'] .history-slider { padding: 0 16px 8px; }
  :root[data-theme='talk'] .timeline > li { position: relative; padding: 10px 16px 10px 52px; border-bottom: 0; }
  :root[data-theme='talk'] .actor { position: absolute; left: 14px; top: 10px; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; font-size: 12px; font-weight: 700; }
  :root[data-theme='talk'] .actor-person { border-radius: 50%; background: var(--ink-900); color: #fff; }
  :root[data-theme='talk'] .actor-agent::before { content: ''; width: 17px; height: 17px; border-radius: 4px; background: var(--navy-700); transform: rotate(45deg); }
  :root[data-theme='talk'] .actor-system { border-radius: 50%; border: 1.5px solid var(--line-strong); background: var(--surface); }
  :root[data-theme='talk'] .actor-system::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--ink-300); }
  :root[data-theme='talk'] .timeline-reason { margin-top: 6px; padding: 7px 11px; border: 1px solid var(--line); border-radius: 4px 12px 12px 12px; background: var(--surface); color: var(--text); font-size: 12.5px; }
  :root[data-theme='talk'] .timeline-reason::before { content: '“'; }
  :root[data-theme='talk'] .timeline-reason::after { content: '”'; }
  :root[data-theme='talk'] .reason-label { display: none; }
  :root[data-theme='talk'] .changes { margin-top: 6px; padding: 6px 11px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
  :root[data-theme='talk'] .timeline-actions { gap: 2px 14px; margin: 6px 0 0; }
  :root[data-theme='talk'] .timeline-actions .btn { height: auto; padding: 0; border: 0; background: none; color: var(--brand-ink); font-size: 12px; font-weight: 650; }
  :root[data-theme='talk'] .timeline-actions .btn:hover { background: none; text-decoration: underline; }

  /* 관제: flat rows, each carrying its place in the ledger. */
  :root[data-theme='console'] .timeline > li { padding: 7px 12px; border-bottom-color: var(--line); }
  :root[data-theme='console'] .timeline-seq { display: inline; margin-right: 6px; font-family: var(--mono); font-size: 11px; font-weight: 500; color: var(--navy-700); }
  :root[data-theme='console'] .timeline-head > .muted { font-family: var(--mono); font-size: 11px; }
}
@media screen and (min-width: 721px) {
  :root[data-theme='talk'] .history { width: 360px; }
  :root[data-theme='console'] .history { width: auto; min-width: 0; }
}
</style>

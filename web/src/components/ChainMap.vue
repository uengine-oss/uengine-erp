<script setup lang="ts">
// Where this document's work went: each recent piece of work on it, with the events it caused in other modules
// stepping down to the right. The same chains the event log draws, read through the same member-only function.
import { computed, ref, watch } from 'vue'
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import { messageOf, rpc } from '../lib/api'
import { eventLabel, typeLabel } from '../lib/eventText'
import { fmtDateTime } from '../lib/format'
import { useMenu } from '../lib/menu'
import { ensureStreamNames, streamLabel } from '../lib/refs'
import { catalogOf } from '../lib/session'
import { moduleHue } from '../lib/theme'
import type { ErpEvent } from '../lib/types'
import Icon from './Icon.vue'

const props = defineProps<{ events: ErpEvent[]; id: string }>()

const CHAINS = 4
const ROWS = 24

// The most recent pieces of work that touched this document, newest first.
const correlations = computed(() => {
  const out: string[] = []
  for (let i = props.events.length - 1; i >= 0 && out.length < CHAINS; i--) {
    const c = props.events[i].correlation_id
    if (c && !out.includes(c)) out.push(c)
  }
  return out
})

const chains = ref<{ id: string; events: ErpEvent[] }[]>([])
const loading = ref(false)
const error = ref('')
let asked = 0
watch(() => correlations.value.join(','), async () => {
  const my = ++asked
  const ids = correlations.value
  if (!ids.length) { chains.value = []; return }
  loading.value = true
  error.value = ''
  try {
    const lists = await Promise.all(ids.map((c) => rpc<ErpEvent[]>('erp_correlation', { p_correlation_id: c })))
    await ensureStreamNames(lists.flat())
    if (my !== asked) return
    chains.value = ids.map((id, i) => ({ id, events: lists[i] ?? [] }))
  } catch (e) {
    if (my === asked) { chains.value = []; error.value = messageOf(e) }
  } finally {
    if (my === asked) loading.value = false
  }
}, { immediate: true })

const { modules } = useMenu()
const moduleName = (key: string | undefined) => modules.value.find((m) => m.key === key)?.label ?? ''

interface Row { ev: ErpEvent; depth: number; hue: string; module: string; to?: RouteLocationRaw }
function rowsOf(events: ErpEvent[]): Row[] {
  const children = new Map<number, ErpEvent[]>()
  const seqs = new Set(events.map((e) => e.seq))
  const roots: ErpEvent[] = []
  for (const e of events) {
    // A cause this person may not read is not in the list, so its effect starts a stair of its own.
    if (e.causation_seq && seqs.has(e.causation_seq)) children.set(e.causation_seq, [...(children.get(e.causation_seq) ?? []), e])
    else roots.push(e)
  }
  const out: Row[] = []
  const walk = (e: ErpEvent, depth: number) => {
    const module = catalogOf(e.stream_type)?.module
    out.push({
      ev: e, depth: Math.min(depth, 6), hue: moduleHue(module), module: moduleName(module),
      to: e.stream_id !== props.id && catalogOf(e.stream_type) ? { name: 'record', params: { type: e.stream_type, id: e.stream_id } } : undefined,
    })
    for (const c of children.get(e.seq) ?? []) walk(c, depth + 1)
  }
  roots.forEach((r) => walk(r, 0))
  return out
}

const groups = computed(() => chains.value.filter((c) => c.events.length).map((c) => {
  const rows = rowsOf(c.events)
  const first = c.events[0]
  return { id: c.id, at: first.occurred_at, actor: first.actor_name ?? '시스템', rows: rows.slice(0, ROWS), more: Math.max(0, rows.length - ROWS) }
}))
</script>

<template>
  <aside class="map no-print" aria-label="연결 지도" data-testid="chain-map">
    <div class="map-head">
      <h2><Icon name="link" :size="14" />연결 지도</h2>
      <span class="muted small">최근 작업 {{ groups.length }}건</span>
    </div>
    <div class="map-body">
      <p v-if="error" class="map-note err-text">{{ error }}</p>
      <p v-else-if="loading && !groups.length" class="map-note muted">불러오는 중…</p>
      <p v-else-if="!groups.length" class="map-note muted">아직 이 문서에서 시작된 일이 없습니다.</p>
      <section v-for="g in groups" :key="g.id" class="map-group">
        <div class="map-when"><span>{{ fmtDateTime(g.at).slice(5, 16) }}</span><span class="ellipsis">{{ g.actor }}</span></div>
        <ol class="map-rows">
          <li v-for="n in g.rows" :key="n.ev.seq" :class="{ here: n.ev.stream_id === id }" :style="{ '--depth': n.depth, '--hue': n.hue }">
            <component :is="n.to ? RouterLink : 'span'" :to="n.to" class="map-row">
              <span class="map-doc ellipsis"><b v-if="n.module">{{ n.module }}</b>{{ typeLabel(n.ev.stream_type) }} {{ streamLabel(n.ev.stream_id) }}</span>
              <span class="map-event ellipsis">{{ eventLabel(n.ev.event_type, typeLabel(n.ev.stream_type)) }}</span>
            </component>
          </li>
        </ol>
        <router-link v-if="g.more" class="map-more" :to="{ name: 'events', query: { stream: id } }">외 {{ g.more }}건은 이벤트 로그에서 봅니다</router-link>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.map { display: flex; flex-direction: column; min-height: 0; background: var(--surface); border-left: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.map-head { display: flex; align-items: center; justify-content: space-between; flex: none; padding: 8px 12px 6px; }
.map-head h2 { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; }
.map-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding-bottom: 6px; }
.map-note { padding: 4px 12px 10px; }
.map-group { padding: 4px 12px 8px; }
.map-group + .map-group { border-top: 1px solid var(--line); padding-top: 8px; }
.map-when { display: flex; gap: 8px; margin-bottom: 4px; font-family: var(--mono); font-size: 11px; color: var(--text-3); }
.map-rows { list-style: none; margin: 0; padding: 0; }
.map-rows li { position: relative; margin-left: calc(var(--depth) * 13px); padding: 1px 0; }
/* The riser of each stair: a short line down from the event that caused this one. */
.map-rows li:not(:first-child)::before { content: ''; position: absolute; left: -8px; top: -2px; width: 6px; height: 14px; border-left: 1px solid var(--line-strong); border-bottom: 1px solid var(--line-strong); }
.map-row { display: flex; flex-direction: column; gap: 0; padding: 3px 8px; border-left: 2px solid var(--hue); border-radius: 0 2px 2px 0; background: var(--ink-50); color: var(--text); text-decoration: none; font-size: 12px; line-height: 1.35; }
a.map-row:hover { background: var(--ink-100); text-decoration: none; }
.map-doc { color: var(--text-2); font-size: 11.5px; }
.map-doc b { margin-right: 6px; color: var(--hue); font-weight: 650; }
.map-event { font-weight: 600; }
.here > .map-row { background: var(--navy-50); box-shadow: inset 0 0 0 1px var(--navy-300); }
.map-more { display: inline-block; margin-top: 4px; font-size: 11.5px; }
@media (max-width: 720px) {
  .map { border-left: 0; border-top: 1px solid var(--line); }
  .map-body { overflow: visible; }
}
</style>

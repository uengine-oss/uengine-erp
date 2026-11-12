<script setup lang="ts">
// The newest events of the ledger, along the bottom of the 관제 theme. It redraws what the event log already
// shows; clicking one opens the log on that document.
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { catalogOf } from '../lib/session'
import { eventLabel, typeLabel } from '../lib/eventText'
import { fmtTime } from '../lib/format'
import { loadTail, tail } from '../lib/ledgerTail'
import { timeView } from '../lib/mode'
import { onLedgerEvent } from '../lib/realtime'
import { streamLabel } from '../lib/refs'
import { moduleHue } from '../lib/theme'

let timer: ReturnType<typeof setTimeout> | undefined
onMounted(loadTail)
// One command can write many events, so the strip reads once after they have all arrived.
onLedgerEvent(() => {
  clearTimeout(timer)
  timer = setTimeout(loadTail, 300)
})
watch(() => timeView.at, loadTail)
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <footer class="strip" data-testid="ledger-strip">
    <span class="strip-head">원장</span>
    <span v-if="tail.failed" class="strip-none">원장을 읽지 못했습니다.</span>
    <span v-else-if="!tail.events.length" class="strip-none">아직 이벤트가 없습니다.</span>
    <ol v-else class="strip-list">
      <li v-for="ev in tail.events" :key="ev.seq">
        <router-link :to="{ name: 'events', query: { stream: ev.stream_id } }" class="strip-item" :style="{ '--hue': moduleHue(catalogOf(ev.stream_type)?.module) }">
          <span class="strip-seq">#{{ ev.seq }}</span>
          <i></i>
          <span class="strip-event">{{ eventLabel(ev.event_type, typeLabel(ev.stream_type)) }}</span>
          <span class="strip-doc">{{ streamLabel(ev.stream_id) }}</span>
          <span class="strip-time">{{ fmtTime(ev.occurred_at) }}</span>
        </router-link>
      </li>
    </ol>
  </footer>
</template>

<style scoped>
.strip { display: flex; align-items: center; flex: none; height: 28px; overflow: hidden; background: #080b10; border-top: 1px solid var(--line); font-family: var(--mono); font-size: 11.5px; color: var(--text-3); }
.strip-head { flex: none; align-self: stretch; display: inline-flex; align-items: center; padding: 0 12px; background: var(--navy-700); color: var(--on-brand); font-family: var(--font); font-weight: 700; letter-spacing: 0.04em; }
.strip-none { padding: 0 12px; font-family: var(--font); }
.strip-list { display: flex; flex: 1 1 auto; min-width: 0; margin: 0; padding: 0; list-style: none; overflow: hidden; }
.strip-list li { flex: none; border-right: 1px solid var(--line); }
.strip-item { display: inline-flex; align-items: center; gap: 7px; height: 27px; padding: 0 12px; color: var(--text-2); text-decoration: none; white-space: nowrap; }
.strip-item:hover { background: var(--ink-50); text-decoration: none; }
.strip-item i { width: 6px; height: 6px; border-radius: 50%; background: var(--hue); }
.strip-seq { color: var(--text-3); }
.strip-event { color: var(--text); font-family: var(--font); font-weight: 600; }
.strip-doc { max-width: 180px; overflow: hidden; text-overflow: ellipsis; font-family: var(--font); }
.strip-list li:first-child .strip-seq { color: var(--navy-700); }
@media (max-width: 720px) {
  .strip-time, .strip-doc { display: none; }
}
</style>

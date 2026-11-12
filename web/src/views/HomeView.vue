<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { db } from '../lib/conn'
import { messageOf, rpc, toApiError } from '../lib/api'
import { onDataChanged } from '../lib/commands'
import { timeView } from '../lib/mode'
import { session } from '../lib/session'
import { eventLabel, sourceColor, sourceLabel, typeLabel } from '../lib/eventText'
import { fmtBytes, fmtDateTime } from '../lib/format'
import { ensureStreamNames, forgetName, streamLabel } from '../lib/refs'
import { onLedgerEvent } from '../lib/realtime'
import type { ErpEvent, Usage } from '../lib/types'
import { resolveNav } from '../nav'
import EmptyState from '../components/EmptyState.vue'
import HomeAlerts from '../components/HomeAlerts.vue'
import Icon from '../components/Icon.vue'

const events = ref<ErpEvent[]>([])
const usage = ref<Usage | null>(null)
const error = ref('')
const loading = ref(true)

async function load() {
  try {
    let q = db().from('erp_events').select('*')
    if (timeView.at) q = q.lte('occurred_at', timeView.at)
    const { data, error: err, status } = await q.order('seq', { ascending: false }).limit(12)
    if (err) throw toApiError(err, status)
    const list = (data ?? []) as ErpEvent[]
    await ensureStreamNames(list)
    events.value = list
    usage.value = await rpc<Usage>('erp_usage')
    error.value = ''
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(() => timeView.at, load)
onDataChanged(() => { void load() })

let timer: ReturnType<typeof setTimeout> | undefined
onLedgerEvent((ev) => {
  forgetName(ev.stream_id)
  clearTimeout(timer)
  timer = setTimeout(load, 300)
})
onBeforeUnmount(() => clearTimeout(timer))

const streamName = (e: ErpEvent) => (e.stream_type === 'company' ? typeLabel('company') : streamLabel(e.stream_id))
const percent = computed(() => (usage.value ? (usage.value.db_bytes / usage.value.limit_bytes) * 100 : 0))
const shortcuts = computed(() => resolveNav(session.catalog).filter((m) => m.screens.length && m.key !== 'settings'))
const openingHint = computed(() => shortcuts.value.length === 0)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 data-testid="home-title">홈</h1>
      <span class="muted small">통화 {{ session.company?.state?.currency }} · 스키마 v{{ session.status?.version }}</span>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert"><Icon name="alert" /><span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" @click="load">다시 시도</button></div>
    <div class="page-body">
      <div class="home-grid">
        <section class="home-panel">
          <div class="home-panel-head">
            <h2>최근 이벤트</h2>
            <router-link class="small" to="/events" data-testid="home-events-link">원장 전체 보기</router-link>
          </div>
          <table v-if="events.length" class="tbl" data-testid="home-events">
            <tbody>
              <tr v-for="e in events" :key="e.seq">
                <td class="muted nowrap" style="width: 128px">{{ fmtDateTime(e.occurred_at).slice(5, 16) }}</td>
                <td>{{ eventLabel(e.event_type, typeLabel(e.stream_type)) }}</td>
                <td class="ev-name"><span class="muted small">{{ typeLabel(e.stream_type) }}</span> {{ streamName(e) }}</td>
                <td class="nowrap">{{ e.actor_name ?? '시스템' }}</td>
                <td style="width: 70px"><span class="pill" :class="`pill-${sourceColor(e.source)}`">{{ sourceLabel(e.source) }}</span></td>
              </tr>
            </tbody>
          </table>
          <EmptyState v-else-if="!loading && !error" title="아직 이벤트가 없습니다" text="이 회사에서 일어나는 모든 변경이 여기에 기록됩니다." />
        </section>

        <div class="home-side">
          <HomeAlerts />
          <section class="home-panel">
            <div class="home-panel-head"><h2>사용량</h2><router-link class="small" to="/settings/usage">자세히</router-link></div>
            <div v-if="usage" class="home-usage" data-testid="home-usage">
              <div class="row" style="justify-content: space-between">
                <span>데이터베이스</span>
                <span class="num">{{ fmtBytes(usage.db_bytes) }} / {{ fmtBytes(usage.limit_bytes) }}</span>
              </div>
              <div class="meter" :class="{ warn: usage.level === 'near', bad: usage.level === 'full' }" role="progressbar" :aria-valuenow="Math.round(percent)" aria-valuemin="0" aria-valuemax="100"><i :style="{ width: `${Math.min(100, percent)}%` }"></i></div>
              <dl class="kv small" style="margin: 8px 0 0">
                <dt>이벤트</dt><dd class="num">{{ usage.events.toLocaleString('ko-KR') }}건</dd>
                <dt>문서</dt><dd class="num">{{ usage.records.toLocaleString('ko-KR') }}건</dd>
              </dl>
            </div>
          </section>
          <section class="home-panel">
            <div class="home-panel-head"><h2>바로 가기</h2></div>
            <ul class="home-links">
              <li v-for="m in shortcuts" :key="m.key"><router-link :to="m.to"><Icon :name="m.icon" :size="14" />{{ m.label }}</router-link></li>
              <li><router-link to="/settings/members"><Icon name="settings" :size="14" />구성원 관리</router-link></li>
              <li><router-link to="/settings/backup"><Icon name="download" :size="14" />백업 받기</router-link></li>
            </ul>
            <p v-if="openingHint" class="hint" style="padding: 0 12px 10px">업무 모듈은 설치되는 대로 왼쪽 메뉴에 나타납니다.</p>
          </section>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.home-grid { display: grid; grid-template-columns: minmax(0, 1fr) 288px; gap: 12px; padding: 12px 16px 20px; align-items: start; }
.home-side { display: flex; flex-direction: column; gap: 12px; }
.home-panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.home-panel-head { display: flex; align-items: center; justify-content: space-between; height: 36px; padding: 0 12px; border-bottom: 1px solid var(--line); }
.home-panel-head h2 { font-size: 13px; }
.home-usage { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px 12px; }
.home-links { list-style: none; margin: 0; padding: 4px 0; }
.home-links a { display: flex; align-items: center; gap: 8px; padding: 5px 12px; color: var(--ink-800); }
.home-links a:hover { background: var(--navy-50); text-decoration: none; }
.ev-name { max-width: 220px; }
@media screen {
  /* The panels themselves are restyled in themes.css: the alerts panel is a component of its own with the same classes. */
  :root[data-theme='talk'] .home-grid { gap: 14px; padding: 4px 20px 24px; }
  :root[data-theme='talk'] .home-side { gap: 14px; }
  :root[data-theme='talk'] .home-usage { padding: 12px 16px 14px; }
  :root[data-theme='console'] .home-grid { gap: 8px; padding: 8px; }
  :root[data-theme='console'] .home-side { gap: 8px; }
  :root[data-theme='console'] .home-panel td.muted.nowrap { font-family: var(--mono); font-size: 11.5px; }
}
@media screen and (min-width: 721px) {
  :root[data-theme='talk'] .home-grid { grid-template-columns: minmax(0, 1fr) 340px; }
  :root[data-theme='console'] .home-grid { grid-template-columns: minmax(0, 1fr) 320px; }
}
@media (max-width: 720px) {
  .home-grid { grid-template-columns: minmax(0, 1fr); }
  .home-panel { overflow-x: auto; }
}
</style>

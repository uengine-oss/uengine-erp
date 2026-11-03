<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { db } from '../lib/conn'
import { messageOf, rpc, toApiError } from '../lib/api'
import { catalogOf, isAdmin, session } from '../lib/session'
import { eventLabel, sourceColor, sourceLabel, SOURCES } from '../lib/eventText'
import { fmtDateTime } from '../lib/format'
import { ensureNames, forgetName, refLabel } from '../lib/refs'
import { onLedgerEvent } from '../lib/realtime'
import type { ErpEvent, Usage } from '../lib/types'
import ChainTree from '../components/ChainTree.vue'
import EmptyState from '../components/EmptyState.vue'
import Icon from '../components/Icon.vue'

const route = useRoute()
const router = useRouter()
const PAGE_SIZE = 25

const streamType = computed(() => String(route.query.type ?? ''))
const source = computed(() => String(route.query.source ?? ''))
const page = computed(() => Math.max(1, Number(route.query.page ?? 1) || 1))
const eventText = ref(String(route.query.event ?? ''))
const actorText = ref(String(route.query.actor ?? ''))
const dateFrom = computed(() => String(route.query.from ?? ''))
const dateTo = computed(() => String(route.query.to ?? ''))
const streamId = computed(() => String(route.query.stream ?? ''))

const rows = ref<ErpEvent[]>([])
const total = ref(0)
const loading = ref(true)
const error = ref('')
let seq = 0

const typeOptions = computed(() => session.catalog.map((c) => ({ value: c.type, label: c.label })))

function setQuery(patch: Record<string, string | undefined>) {
  const query: Record<string, any> = { ...route.query, ...patch }
  for (const k of Object.keys(query)) if (query[k] === undefined || query[k] === '') delete query[k]
  void router.replace({ query })
}

async function load() {
  const my = ++seq
  error.value = ''
  try {
    let q = db().from('erp_events').select('*', { count: 'exact' })
    if (streamType.value) q = q.eq('stream_type', streamType.value)
    if (source.value) q = q.eq('source', source.value)
    if (streamId.value) q = q.eq('stream_id', streamId.value)
    const ev = String(route.query.event ?? '').trim()
    if (ev) q = q.ilike('event_type', `%${ev}%`)
    const actor = String(route.query.actor ?? '').trim()
    if (actor) q = q.ilike('actor_name', `%${actor}%`)
    if (dateFrom.value) q = q.gte('occurred_at', new Date(`${dateFrom.value}T00:00:00`).toISOString())
    if (dateTo.value) q = q.lte('occurred_at', new Date(`${dateTo.value}T23:59:59.999`).toISOString())
    const from = (page.value - 1) * PAGE_SIZE
    const { data, error: err, count, status } = await q.order('seq', { ascending: false }).range(from, from + PAGE_SIZE - 1)
    if (my !== seq) return
    if (err) throw toApiError(err, status)
    const list = (data ?? []) as ErpEvent[]
    await ensureNames(list.map((e) => e.stream_id))
    if (my !== seq) return
    rows.value = list
    total.value = count ?? 0
  } catch (e) {
    if (my === seq) error.value = messageOf(e)
  } finally {
    if (my === seq) loading.value = false
  }
}
watch(() => route.query, load, { immediate: true, deep: true })

let textTimer: ReturnType<typeof setTimeout> | undefined
watch([eventText, actorText], ([e, a]) => {
  clearTimeout(textTimer)
  textTimer = setTimeout(() => setQuery({ event: e.trim() || undefined, actor: a.trim() || undefined, page: undefined }), 250)
})

let liveTimer: ReturnType<typeof setTimeout> | undefined
const fresh = ref(new Set<number>())
onLedgerEvent((ev) => {
  forgetName(ev.stream_id)
  fresh.value.add(ev.seq)
  clearTimeout(liveTimer)
  liveTimer = setTimeout(load, 300)
})
onBeforeUnmount(() => { clearTimeout(textTimer); clearTimeout(liveTimer) })

const filtered = computed(() => !!(streamType.value || source.value || streamId.value || route.query.event || route.query.actor || dateFrom.value || dateTo.value))
function clearFilters() {
  eventText.value = ''
  actorText.value = ''
  void router.replace({ query: {} })
}
const lastPage = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const typeLabel = (t: string) => catalogOf(t)?.label ?? t
const streamName = (e: ErpEvent) => (e.stream_type === 'company' ? typeLabel('company') : refLabel(e.stream_id))

/* Detail: raw data and the causal chain */
const selected = ref<ErpEvent | null>(null)
const chain = ref<ErpEvent[]>([])
const chainError = ref('')
let chainSeq = 0

async function selectEvent(ev: ErpEvent) {
  selected.value = ev
  const my = ++chainSeq
  chainError.value = ''
  try {
    const list = await rpc<ErpEvent[]>('erp_correlation', { p_correlation_id: ev.correlation_id })
    if (my !== chainSeq) return
    chain.value = list
  } catch (e) {
    if (my === chainSeq) { chain.value = []; chainError.value = messageOf(e) }
  }
}
const selectedJson = computed(() => (selected.value ? JSON.stringify(selected.value.data, null, 2) : ''))
function recordRoute(ev: ErpEvent) {
  return ev.stream_type === 'company' ? { path: '/settings/company' } : { name: 'record', params: { type: ev.stream_type, id: ev.stream_id } }
}

/* Integrity check, in batches because the API cuts statements at 8 seconds */
const verifying = ref(false)
const verifyDone = ref(0)
const verifyTotal = ref(0)
const verifyResult = ref<{ checked: number; mismatches: { id: string; type: string }[] } | null>(null)
const verifyError = ref('')
const verifyPercent = computed(() => (verifyTotal.value ? Math.min(100, Math.round((verifyDone.value / verifyTotal.value) * 100)) : 0))

async function verify() {
  verifying.value = true
  verifyResult.value = null
  verifyError.value = ''
  verifyDone.value = 0
  try {
    const usage = await rpc<Usage>('erp_usage')
    verifyTotal.value = usage.records
    let after: string | null = null
    const bad: { id: string; type: string }[] = []
    for (;;) {
      const res: { checked: number; mismatches: { id: string; type: string }[]; next: string | null } =
        await rpc('erp_verify', { p_after: after, p_limit: 500 })
      verifyDone.value += res.checked
      bad.push(...res.mismatches)
      if (!res.next) break
      after = res.next
    }
    verifyResult.value = { checked: verifyDone.value, mismatches: bad }
  } catch (e) {
    verifyError.value = messageOf(e)
  } finally {
    verifying.value = false
  }
}
</script>

<template>
  <div class="page" data-testid="events">
    <div class="page-head">
      <h1>이벤트 원장<span class="page-count" data-testid="events-count">{{ total.toLocaleString('ko-KR') }}건</span></h1>
      <span class="muted small">모든 변경의 원본 기록입니다. 수정하거나 지울 수 없습니다.</span>
      <div class="grow"></div>
      <button v-if="isAdmin()" type="button" class="btn" :disabled="verifying" data-testid="verify" @click="verify"><Icon name="shield" />{{ verifying ? '검증 중…' : '무결성 검증' }}</button>
    </div>

    <div v-if="verifying || verifyResult || verifyError" class="verify-row">
      <template v-if="verifying">
        <div class="meter grow" role="progressbar" :aria-valuenow="verifyPercent" aria-valuemin="0" aria-valuemax="100"><i :style="{ width: `${verifyPercent}%` }"></i></div>
        <span class="small dim nowrap" data-testid="verify-progress">{{ verifyDone.toLocaleString('ko-KR') }} / {{ verifyTotal.toLocaleString('ko-KR') }}건 재생 중</span>
      </template>
      <div v-else-if="verifyError" class="banner banner-error grow" role="alert"><Icon name="alert" /><span>{{ verifyError }}</span></div>
      <div v-else-if="verifyResult && !verifyResult.mismatches.length" class="banner banner-ok grow" data-testid="verify-ok">
        <Icon name="check" /><span class="grow">문서 {{ verifyResult.checked.toLocaleString('ko-KR') }}건을 이벤트에서 다시 계산해 현재 상태와 대조했습니다. 불일치 0건.</span>
        <button type="button" class="btn btn-sm btn-ghost" aria-label="닫기" @click="verifyResult = null"><Icon name="x" :size="12" /></button>
      </div>
      <div v-else-if="verifyResult" class="banner banner-error grow" role="alert" data-testid="verify-bad">
        <Icon name="alert" />
        <span class="grow">문서 {{ verifyResult.checked.toLocaleString('ko-KR') }}건 중 {{ verifyResult.mismatches.length }}건이 이벤트와 다릅니다:
          <template v-for="(m, i) in verifyResult.mismatches.slice(0, 5)" :key="m.id"><template v-if="i">, </template><router-link :to="{ name: 'record', params: { type: m.type, id: m.id } }">{{ typeLabel(m.type) }}</router-link></template>
        </span>
      </div>
    </div>

    <div class="toolbar" style="flex-wrap: wrap">
      <select class="select" style="width: 124px" aria-label="문서 유형" data-testid="filter-type" :value="streamType" @change="setQuery({ type: ($event.target as HTMLSelectElement).value || undefined, page: undefined })">
        <option value="">모든 유형</option>
        <option v-for="o in typeOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
      <input v-model="eventText" class="input" style="width: 150px" placeholder="이벤트 이름" aria-label="이벤트 이름" autocomplete="off" data-testid="filter-event" />
      <input v-model="actorText" class="input" style="width: 110px" placeholder="행위자" aria-label="행위자" autocomplete="off" data-testid="filter-actor" />
      <select class="select" style="width: 104px" aria-label="출처" data-testid="filter-source" :value="source" @change="setQuery({ source: ($event.target as HTMLSelectElement).value || undefined, page: undefined })">
        <option value="">모든 출처</option>
        <option v-for="s in SOURCES" :key="s" :value="s">{{ sourceLabel(s) }}</option>
      </select>
      <input class="input" type="date" style="width: 126px" aria-label="시작일" :value="dateFrom" @change="setQuery({ from: ($event.target as HTMLInputElement).value || undefined, page: undefined })" />
      <span class="muted">~</span>
      <input class="input" type="date" style="width: 126px" aria-label="종료일" :value="dateTo" @change="setQuery({ to: ($event.target as HTMLInputElement).value || undefined, page: undefined })" />
      <button v-if="filtered" type="button" class="btn btn-ghost btn-sm" data-testid="filter-clear" @click="clearFilters">조건 지우기</button>
    </div>

    <div v-if="error" class="banner banner-error banner-flush" role="alert"><Icon name="alert" /><span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" @click="load">다시 시도</button></div>

    <div class="events-split">
      <div class="page-body" style="background: var(--surface)">
        <table v-if="rows.length" class="tbl" data-testid="events-table">
          <thead>
            <tr><th class="num" style="width: 56px">#</th><th style="width: 138px">시간</th><th>이벤트</th><th>문서</th><th>행위자</th><th style="width: 76px">출처</th></tr>
          </thead>
          <tbody>
            <tr v-for="e in rows" :key="e.seq" class="clickable" :class="{ 'is-selected': selected?.seq === e.seq }" tabindex="0" data-testid="event-row"
                @click="selectEvent(e)" @keydown.enter="selectEvent(e)">
              <td class="num muted">{{ e.seq }}</td>
              <td class="nowrap">{{ fmtDateTime(e.occurred_at) }}</td>
              <td :title="e.event_type">{{ eventLabel(e.event_type, typeLabel(e.stream_type)) }}</td>
              <td class="ev-doc"><span class="muted small">{{ typeLabel(e.stream_type) }}</span> {{ streamName(e) }}</td>
              <td>{{ e.actor_name ?? '시스템' }}</td>
              <td><span class="pill" :class="`pill-${sourceColor(e.source)}`">{{ sourceLabel(e.source) }}</span></td>
            </tr>
          </tbody>
        </table>
        <template v-else-if="!loading && !error">
          <EmptyState v-if="filtered" title="조건에 맞는 이벤트가 없습니다" text="필터를 바꾸어 보세요.">
            <button type="button" class="btn" @click="clearFilters">조건 지우기</button>
          </EmptyState>
          <EmptyState v-else title="볼 수 있는 이벤트가 없습니다" text="회사에 변경이 생기면 여기에 쌓입니다. 역할에 따라 일부 유형의 이벤트는 보이지 않습니다." />
        </template>
      </div>

      <aside v-if="selected" class="ev-detail" aria-label="이벤트 상세" data-testid="event-detail">
        <div class="ev-detail-head">
          <div class="grow">
            <h2 class="ellipsis">{{ eventLabel(selected.event_type, typeLabel(selected.stream_type)) }}</h2>
            <div class="muted small mono ellipsis">{{ selected.event_type }}</div>
          </div>
          <router-link class="btn btn-sm" :to="recordRoute(selected)" data-testid="event-open-record">문서 열기</router-link>
          <button type="button" class="btn btn-ghost btn-sm btn-icon" aria-label="닫기" @click="selected = null"><Icon name="x" :size="13" /></button>
        </div>
        <div class="ev-detail-body">
          <dl class="kv small">
            <dt>시간</dt><dd>{{ fmtDateTime(selected.occurred_at) }}</dd>
            <dt>행위자</dt><dd>{{ selected.actor_name ?? '시스템' }} · {{ sourceLabel(selected.source) }}</dd>
            <dt>스트림 버전</dt><dd>v{{ selected.version }}</dd>
            <template v-if="selected.reason"><dt>사유</dt><dd>{{ selected.reason }}</dd></template>
            <dt>상관 ID</dt><dd class="mono" style="font-size: 11px" data-testid="event-correlation">{{ selected.correlation_id }}</dd>
          </dl>
          <h3 class="ev-h">인과 사슬 <span class="muted small" style="font-weight: 450">{{ chain.length }}건</span></h3>
          <p v-if="chainError" class="err-text small">{{ chainError }}</p>
          <ChainTree v-else :events="chain" :selected="selected.seq" @select="selectEvent" />
          <h3 class="ev-h">원본 데이터</h3>
          <pre class="ev-json" data-testid="event-json">{{ selectedJson }}</pre>
        </div>
      </aside>
    </div>

    <div v-if="total > PAGE_SIZE" class="pager">
      <span>{{ total.toLocaleString('ko-KR') }}건</span>
      <div class="grow"></div>
      <button type="button" class="btn btn-sm btn-icon" :disabled="page <= 1" aria-label="이전 쪽" @click="setQuery({ page: page > 2 ? String(page - 1) : undefined })"><Icon name="chevron-left" :size="13" /></button>
      <span>{{ page }} / {{ lastPage }}</span>
      <button type="button" class="btn btn-sm btn-icon" :disabled="page >= lastPage" aria-label="다음 쪽" data-testid="events-next" @click="setQuery({ page: String(page + 1) })"><Icon name="chevron-right" :size="13" /></button>
    </div>
  </div>
</template>

<style scoped>
.verify-row { display: flex; align-items: center; gap: 10px; padding: 6px 16px; background: var(--surface); border-bottom: 1px solid var(--line); }
.events-split { display: flex; flex: 1 1 auto; min-height: 0; }
.ev-doc { max-width: 190px; }
.ev-detail { display: flex; flex-direction: column; width: 400px; flex: none; min-height: 0; background: var(--surface); border-left: 1px solid var(--line); }
.ev-detail-head { display: flex; align-items: flex-start; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--line); }
.ev-detail-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 8px 12px 16px; }
.ev-h { margin: 14px 0 4px; }
.ev-json { margin: 0; padding: 8px 10px; background: var(--ink-50); border: 1px solid var(--line); border-radius: var(--radius); font-family: var(--mono); font-size: 11.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
</style>

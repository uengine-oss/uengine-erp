<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { db } from '../lib/conn'
import { toApiError, messageOf, rpc } from '../lib/api'
import { onDataChanged } from '../lib/commands'
import { timeView, writeBlock } from '../lib/mode'
import { catalogOf, hasRole } from '../lib/session'
import { screenFor } from '../nav'
import { canCommand, collectRefIds, displayValue, isNumeric, listFields } from '../lib/fields'
import { fmtDay, josa } from '../lib/format'
import { searchFilter, sortColumn } from '../lib/query'
import { ensureNames, forgetName, refLabel } from '../lib/refs'
import { onLedgerEvent } from '../lib/realtime'
import { csvBlob, saveBlob, toast } from '../lib/ui'
import type { ErpRecord, Field } from '../lib/types'
import EmptyState from '../components/EmptyState.vue'
import FieldValue from '../components/FieldValue.vue'
import Icon from '../components/Icon.vue'
import ListViews from '../components/ListViews.vue'
import StatusPill from '../components/StatusPill.vue'

const props = defineProps<{ type: string }>()
const route = useRoute()
const router = useRouter()

const PAGE_SIZE = 25
const SELECT = 'id,type,version,name,status,active,state,created_at,updated_at'

const doc = computed(() => catalogOf(props.type))
const fields = computed<Field[]>(() => (doc.value ? listFields(doc.value).filter((f) => f.name !== 'state') : []))
const states = computed(() => doc.value?.states ?? [])
const canCreate = computed(() => !!doc.value && canCommand(doc.value, 'create'))
const screen = computed(() => screenFor(props.type))
// Settings types have their own screens; everything else can come in from a file.
const canImport = computed(() => canCreate.value && doc.value?.module !== 'settings')

const FIELD_FILTER = /^(eq|nn|lt)\.([a-z_]+)$/
const fieldFilters = computed(() => Object.entries(route.query).flatMap(([key, value]) => {
  const m = key.match(FIELD_FILTER)
  return m ? [{ key, op: m[1], field: m[2], value: String(value) }] : []
}))
const stateIn = computed(() => (route.query['in.status'] ? String(route.query['in.status']).split(',') : []))
const filterLabel = (f: { op: string; field: string; value: string }) => {
  const def = doc.value?.fields.find((x) => x.name === f.field)
  const label = def?.label ?? f.field
  if (f.op === 'nn') return `${label} 있음`
  const shown = def?.type === 'ref' ? refLabel(f.value) : def?.options?.find((o) => o.value === f.value)?.label ?? (f.value === 'true' ? '예' : f.value.slice(0, 10))
  return f.op === 'lt' ? `${label} ${shown} 전` : `${label}: ${shown}`
}
function isQuickOn(f: { query: Record<string, string> }) {
  return Object.entries(f.query).every(([k, v]) => route.query[k] === v)
}
function toggleQuick(f: { query: Record<string, string> }) {
  const on = isQuickOn(f)
  const patch: Record<string, string | undefined> = { page: undefined }
  for (const [k, v] of Object.entries(f.query)) patch[k] = on ? undefined : v
  setQuery(patch)
}

// Filters live in the address so Back returns to the same page of the same list.
const search = ref(String(route.query.q ?? ''))
const status = computed(() => String(route.query.status ?? ''))
const archived = computed(() => route.query.archived === '1')
const page = computed(() => Math.max(1, Number(route.query.page ?? 1) || 1))
const sortKey = computed(() => String(route.query.sort ?? ''))
const sortAsc = computed(() => route.query.dir === 'asc')

const rows = ref<ErpRecord[]>([])
const total = ref(0)
const loading = ref(true)
const error = ref('')
const exporting = ref(false)
let seq = 0

// erp_records_at reads the ledger, so looking at a past date offers only what that read can do: state and pages.
const atPast = computed(() => !!timeView.at)
const filtered = computed(() => (atPast.value ? !!status.value : !!(String(route.query.q ?? '').trim() || status.value || archived.value || fieldFilters.value.length || stateIn.value.length)))
// erp_catalog is not filtered by role, so an empty result may mean the role cannot read this type.
const restricted = computed(() => {
  const roles = doc.value?.read_roles
  return !!roles?.length && !hasRole(roles)
})
const roleNames = computed(() => {
  const options = catalogOf('member')?.fields.find((f) => f.name === 'roles')?.options ?? []
  return (doc.value?.read_roles ?? []).map((r) => options.find((o) => o.value === r)?.label ?? r).join(', ')
})

function setQuery(patch: Record<string, string | undefined>) {
  const query: Record<string, any> = { ...route.query, ...patch }
  for (const k of Object.keys(query)) if (query[k] === undefined || query[k] === '') delete query[k]
  void router.replace({ query })
}

function buildQuery(select: string, withCount: boolean) {
  let q = db().from('erp_records').select(select, withCount ? { count: 'exact' } : undefined).eq('type', props.type)
  if (!archived.value) q = q.eq('active', true)
  if (status.value) q = q.eq('status', status.value)
  const text = String(route.query.q ?? '').trim()
  if (text) q = q.or(searchFilter(doc.value, text))
  if (stateIn.value.length) q = q.in('status', stateIn.value)
  for (const f of fieldFilters.value) {
    if (f.op === 'eq') q = q.eq(`state->>${f.field}`, f.value)
    else if (f.op === 'nn') q = q.not(`state->>${f.field}`, 'is', null)
    else q = q.lt(`state->>${f.field}`, f.value)
  }
  const field = fields.value.find((f) => f.name === sortKey.value)
  const column = sortKey.value === 'status' ? 'status' : field ? sortColumn(field) : null
  if (column) q = q.order(column, { ascending: sortAsc.value, nullsFirst: false }).order('id')
  else q = q.order('updated_at', { ascending: false }).order('id')
  return q
}

async function recordsAt(from: number, size: number): Promise<{ total: number; rows: ErpRecord[] }> {
  return rpc('erp_records_at', { p_type: props.type, p_at: timeView.at, p_limit: size, p_offset: from, p_status: status.value || null })
}

async function fetchPage(from: number): Promise<{ records: ErpRecord[]; count: number }> {
  if (atPast.value) {
    const res = await recordsAt(from, PAGE_SIZE)
    return { records: res.rows, count: res.total }
  }
  const { data, error: err, count, status: http } = await buildQuery(SELECT, true).range(from, from + PAGE_SIZE - 1)
  if (err) throw toApiError(err, http)
  return { records: (data ?? []) as unknown as ErpRecord[], count: count ?? 0 }
}

async function load() {
  if (!doc.value) { loading.value = false; return }
  const my = ++seq
  error.value = ''
  try {
    const from = (page.value - 1) * PAGE_SIZE
    const { records, count } = await fetchPage(from)
    if (my !== seq) return
    const ids = new Set<string>()
    for (const r of records) collectRefIds(fields.value, r.state, ids)
    fieldFilters.value.forEach((f) => ids.add(f.value))
    await ensureNames(ids)
    if (my !== seq) return
    rows.value = records
    total.value = count
    void loadMarks(records, my)
    // Filtering or a deletion can leave the page past the end.
    if (!records.length && page.value > 1 && total.value > 0) setQuery({ page: String(Math.ceil(total.value / PAGE_SIZE)) })
  } catch (e) {
    if (my !== seq) return
    error.value = messageOf(e)
    // Rows still on screen are from another moment; under a date banner they would read as that date's.
    if (atPast.value) { rows.value = []; total.value = 0 }
  } finally {
    if (my === seq) loading.value = false
  }
}

watch(() => [props.type, route.query, timeView.at], load, { immediate: true, deep: true })
onDataChanged(() => { void load() })
watch(doc, (d) => { if (d) document.title = `${d.label} · uEngine ERP` }, { immediate: true })

let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(search, (v) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => setQuery({ q: v.trim() || undefined, page: undefined }), 250)
})

let liveTimer: ReturnType<typeof setTimeout> | undefined
onLedgerEvent((ev) => {
  if (ev.stream_type !== props.type) return
  forgetName(ev.stream_id)
  clearTimeout(liveTimer)
  liveTimer = setTimeout(load, 400)
})
onBeforeUnmount(() => { clearTimeout(searchTimer); clearTimeout(liveTimer) })

function toggleSort(key: string) {
  if (sortKey.value === key) {
    if (sortAsc.value) setQuery({ dir: 'desc', page: undefined })
    else setQuery({ sort: undefined, dir: undefined, page: undefined })
  } else {
    setQuery({ sort: key, dir: 'asc', page: undefined })
  }
}
const canSort = (f: Field) => !atPast.value && !!sortColumn(f)

/* A word beside a row, from the database. Losing it costs nothing, so a failure stays quiet. */
const marks = ref<Record<string, { label: string; color: string }>>({})
async function loadMarks(records: ErpRecord[], my: number) {
  const ask_ = screen.value?.marks
  if (!ask_ || !records.length) { marks.value = {}; return }
  try {
    const found = await ask_(records)
    if (my === seq) marks.value = found
  } catch { marks.value = {} }
}

/* Ticked rows, and what can be done with them */
const bulk = computed(() => (writeBlock.value ? [] : (screen.value?.bulk ?? []).filter((b) => b.key === 'zip' || (doc.value && canCommand(doc.value, 'update')))))
const picked = ref<Record<string, ErpRecord>>({})
const pickedRows = computed(() => Object.values(picked.value))
const allPicked = computed(() => rows.value.length > 0 && rows.value.every((r) => picked.value[r.id]))
const bulkBusy = ref('')
function togglePick(r: ErpRecord) {
  const { [r.id]: on, ...rest } = picked.value
  picked.value = on ? rest : { ...picked.value, [r.id]: r }
}
function togglePickAll() {
  const next = { ...picked.value }
  for (const r of rows.value) { if (allPicked.value) delete next[r.id]; else next[r.id] = r }
  picked.value = next
}
async function runBulk(action: { key: string; from?: string[]; run: (rows: ErpRecord[]) => Promise<void> }) {
  const chosen = action.from ? pickedRows.value.filter((r) => action.from!.includes(r.status ?? '')) : pickedRows.value
  if (!chosen.length) { toast('이 작업을 할 수 있는 상태의 행이 없습니다.', 'error'); return }
  bulkBusy.value = action.key
  try {
    await action.run(chosen)
    picked.value = {}
    await load()
  } catch (e) {
    toast(messageOf(e), 'error')
  } finally {
    bulkBusy.value = ''
  }
}

/* Other ways to look at the same rows */
const viewMode = computed(() => String(route.query.view ?? 'list'))
const viewChoices = computed(() => {
  const v = screen.value?.views
  if (!v) return []
  const out = [{ key: 'list', label: '목록' }, { key: 'board', label: '칸반' }]
  if (v.date) out.push({ key: 'calendar', label: '달력' })
  if (v.groups?.length) out.push({ key: 'pivot', label: '피벗' }, { key: 'chart', label: '그래프' })
  return out
})
const showAlt = computed(() => viewMode.value !== 'list' && !atPast.value && viewChoices.value.some((c) => c.key === viewMode.value))
async function fetchForViews(limit: number): Promise<ErpRecord[]> {
  const { data, error: err, status: http } = await buildQuery(SELECT, false).range(0, limit - 1)
  if (err) throw toApiError(err, http)
  return (data ?? []) as unknown as ErpRecord[]
}

const firstRow = computed(() => (total.value ? (page.value - 1) * PAGE_SIZE + 1 : 0))
const lastRow = computed(() => Math.min(page.value * PAGE_SIZE, total.value))
const lastPage = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))

const openRecord = (r: ErpRecord) => router.push({ name: 'record', params: { type: props.type, id: r.id } })

function clearFilters() {
  search.value = ''
  void router.replace({ query: {} })
}

async function exportCsv() {
  if (!doc.value) return
  exporting.value = true
  try {
    const all: ErpRecord[] = []
    // PostgREST caps each response, so the export pages through the same query as the screen.
    for (let from = 0; ; from += 1000) {
      let batch: ErpRecord[]
      if (atPast.value) {
        batch = (await recordsAt(from, 1000)).rows
      } else {
        const { data, error: err, status: http } = await buildQuery(SELECT, false).range(from, from + 999)
        if (err) throw toApiError(err, http)
        batch = (data ?? []) as unknown as ErpRecord[]
      }
      all.push(...batch)
      if (batch.length < 1000) break
    }
    const ids = new Set<string>()
    for (const r of all) collectRefIds(fields.value, r.state, ids)
    await ensureNames(ids)
    const headers = fields.value.map((f) => f.label)
    if (states.value.length) headers.push('상태')
    const body = all.map((r) => {
      const cells = fields.value.map((f) => ({ value: displayValue(f, r.state?.[f.name]), numeric: isNumeric(f) }))
      if (states.value.length) cells.push({ value: states.value.find((s) => s.value === r.status)?.label ?? r.status ?? '', numeric: false })
      return cells
    })
    saveBlob(csvBlob(headers, body), `${doc.value.label}_${fmtDay(new Date().toISOString())}.csv`)
    toast(`${all.length.toLocaleString('ko-KR')}건을 내보냈습니다.`)
  } catch (e) {
    toast(messageOf(e), 'error')
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <div v-if="!doc" class="page">
    <div class="page-body">
      <EmptyState title="설치되지 않은 화면입니다" text="이 유형이 아직 데이터베이스에 없거나, 이 유형을 쓰는 모듈이 꺼져 있습니다. 모듈은 관리자가 설정 > 모듈에서 켭니다. 업그레이드 안내가 보이면 SQL 을 다시 실행하세요.">
        <router-link class="btn" to="/">홈으로</router-link>
      </EmptyState>
    </div>
  </div>
  <div v-else class="page" data-testid="meta-list">
    <div class="page-head">
      <h1>{{ doc.label }}<span class="page-count" data-testid="list-count">{{ total.toLocaleString('ko-KR') }}건</span></h1>
      <div class="grow"></div>
      <router-link v-if="canImport" class="btn" :to="{ name: 'import', query: { type } }" data-testid="list-import">가져오기</router-link>
      <button type="button" class="btn" :disabled="exporting || !total" data-testid="export-csv" @click="exportCsv"><Icon name="download" :size="13" />{{ exporting ? '내보내는 중…' : 'CSV' }}</button>
      <router-link v-if="canCreate" class="btn btn-primary" :to="{ name: 'new', params: { type } }" data-testid="new-record"><Icon name="plus" :size="13" />새로 만들기</router-link>
    </div>
    <div class="toolbar">
      <label v-if="!atPast" class="search">
        <Icon name="search" :size="13" />
        <span class="sr-only">검색</span>
        <input v-model="search" class="input" type="search" placeholder="검색" autocomplete="off" data-testid="list-search" />
      </label>
      <div v-if="states.length" class="seg" role="group" aria-label="상태 필터" data-testid="state-filter">
        <button type="button" :class="{ on: !status }" :aria-pressed="!status" @click="setQuery({ status: undefined, page: undefined })">전체</button>
        <button v-for="s in states" :key="s.value" type="button" :class="{ on: status === s.value }" :aria-pressed="status === s.value" @click="setQuery({ status: s.value, page: undefined })">{{ s.label }}</button>
      </div>
      <button v-for="f in atPast ? [] : screen?.filters ?? []" :key="f.key" type="button" class="toggle" :class="{ on: isQuickOn(f) }" :aria-pressed="isQuickOn(f)" :data-testid="`list-filter-${f.key}`" @click="toggleQuick(f)">{{ f.label }}</button>
      <div v-if="viewChoices.length && !atPast" class="seg" role="group" aria-label="보기" data-testid="view-switch">
        <button v-for="c in viewChoices" :key="c.key" type="button" :class="{ on: viewMode === c.key }" :aria-pressed="viewMode === c.key" :data-testid="`view-${c.key}`" @click="setQuery({ view: c.key === 'list' ? undefined : c.key, page: undefined })">{{ c.label }}</button>
      </div>
      <div class="grow"></div>
      <span v-if="atPast" class="muted small" data-testid="past-note">과거 시점에서는 검색과 정렬을 쓸 수 없습니다.</span>
      <label v-else class="check small dim">
        <input type="checkbox" :checked="archived" data-testid="include-archived" @change="setQuery({ archived: ($event.target as HTMLInputElement).checked ? '1' : undefined, page: undefined })" />
        보관 포함
      </label>
    </div>

    <div v-if="fieldFilters.length || stateIn.length" class="toolbar chip-row" data-testid="list-conditions">
      <span class="muted small">조건</span>
      <span v-for="f in fieldFilters" :key="f.key" class="tag" data-testid="list-condition">{{ filterLabel(f) }}<button type="button" aria-label="조건 빼기" @click="setQuery({ [f.key]: undefined, page: undefined })"><Icon name="x" :size="10" /></button></span>
      <span v-if="stateIn.length" class="tag" data-testid="list-condition">{{ stateIn.map((s) => states.find((x) => x.value === s)?.label ?? s).join(', ') }}<button type="button" aria-label="조건 빼기" @click="setQuery({ 'in.status': undefined, page: undefined })"><Icon name="x" :size="10" /></button></span>
    </div>
    <div v-if="pickedRows.length" class="toolbar" data-testid="bulk-bar">
      <span class="small" data-testid="bulk-count">{{ pickedRows.length }}건 선택</span>
      <button v-for="b in bulk" :key="b.key" type="button" class="btn btn-sm" :disabled="!!bulkBusy" :data-testid="`bulk-${b.key}`" @click="runBulk(b)">{{ bulkBusy === b.key ? '처리 중…' : b.label }}</button>
      <button type="button" class="btn btn-sm btn-ghost" data-testid="bulk-clear" @click="picked = {}">선택 해제</button>
    </div>

    <div v-if="error" class="banner banner-error banner-flush" role="alert">
      <Icon name="alert" /><span class="grow">{{ error }}</span>
      <button type="button" class="btn btn-sm" @click="load">다시 시도</button>
    </div>

    <div class="page-body" style="background: var(--surface)">
      <ListViews v-if="showAlt && doc" :mode="viewMode" :doc="doc" :config="screen?.views ?? {}" :total="total" :fetch-rows="fetchForViews" @open="openRecord" />
      <table v-else-if="rows.length" class="tbl" data-testid="list-table">
        <thead>
          <tr>
            <th v-if="bulk.length" style="width: 32px"><input type="checkbox" :checked="allPicked" aria-label="이 쪽 모두 선택" data-testid="bulk-all" @change="togglePickAll" /></th>
            <th v-for="f in fields" :key="f.name" :class="{ num: isNumeric(f) }" :aria-sort="sortKey === f.name ? (sortAsc ? 'ascending' : 'descending') : undefined">
              <button v-if="canSort(f)" type="button" class="th-sort" :class="{ on: sortKey === f.name }" @click="toggleSort(f.name)">
                {{ f.label }}<Icon v-if="sortKey === f.name" :name="sortAsc ? 'arrow-up' : 'arrow-down'" :size="11" />
              </button>
              <template v-else>{{ f.label }}</template>
            </th>
            <th v-if="states.length" :aria-sort="sortKey === 'status' ? (sortAsc ? 'ascending' : 'descending') : undefined" style="width: 100px">
              <button v-if="!atPast" type="button" class="th-sort" :class="{ on: sortKey === 'status' }" @click="toggleSort('status')">
                상태<Icon v-if="sortKey === 'status'" :name="sortAsc ? 'arrow-up' : 'arrow-down'" :size="11" />
              </button>
              <template v-else>상태</template>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id" class="clickable" :class="{ 'is-archived': !r.active }" tabindex="0"
              data-testid="list-row" @click="openRecord(r)" @keydown.enter="openRecord(r)">
            <td v-if="bulk.length" @click.stop><input type="checkbox" :checked="!!picked[r.id]" :aria-label="`${r.name ?? '행'} 선택`" data-testid="bulk-row" @change="togglePick(r)" /></td>
            <td v-for="f in fields" :key="f.name" :class="{ num: isNumeric(f) }"><FieldValue :field="f" :value="r.state?.[f.name]" /></td>
            <td v-if="states.length"><StatusPill :doc="doc" :value="r.status" /><span v-if="!r.active" class="tag" style="margin-left: 4px">보관</span><span v-if="marks[r.id]" class="pill" :class="`pill-${marks[r.id].color}`" style="margin-left: 4px" data-testid="list-mark">{{ marks[r.id].label }}</span></td>
          </tr>
        </tbody>
      </table>
      <template v-else-if="!loading && !error">
        <EmptyState v-if="filtered" :title="`조건에 맞는 ${josa(doc.label, '이', '가')} 없습니다`" text="검색어나 상태 필터를 바꾸어 보세요.">
          <button type="button" class="btn" @click="clearFilters">조건 지우기</button>
        </EmptyState>
        <EmptyState v-else-if="atPast" :title="`이 시점에는 ${josa(doc.label, '이', '가')} 없습니다`" :text="`${timeView.date} 까지 등록된 것이 없습니다. 날짜를 바꾸거나 현재로 돌아가세요.`" />
        <EmptyState v-else-if="restricted" :title="`표시할 ${josa(doc.label, '이', '가')} 없습니다`"
                    :text="`이 목록은 ${roleNames} 역할에게만 보입니다. 필요하면 관리자에게 권한을 요청하세요.`" />
        <EmptyState v-else :title="`아직 등록된 ${josa(doc.label, '이', '가')} 없습니다`"
                    :text="canCreate ? `첫 ${josa(doc.label, '을', '를')} 만들면 이 표에 나타납니다.` : writeBlock ? '' : '권한이 있는 구성원이 등록하면 이 표에 나타납니다.'">
          <router-link v-if="canCreate" class="btn btn-primary" :to="{ name: 'new', params: { type } }"><Icon name="plus" :size="13" />새로 만들기</router-link>
        </EmptyState>
      </template>
    </div>

    <div v-if="total > PAGE_SIZE && !showAlt" class="pager" data-testid="pager">
      <span>{{ firstRow.toLocaleString('ko-KR') }}–{{ lastRow.toLocaleString('ko-KR') }} / {{ total.toLocaleString('ko-KR') }}</span>
      <div class="grow"></div>
      <button type="button" class="btn btn-sm btn-icon" :disabled="page <= 1" aria-label="이전 쪽" data-testid="page-prev" @click="setQuery({ page: page > 2 ? String(page - 1) : undefined })"><Icon name="chevron-left" :size="13" /></button>
      <span data-testid="page-no">{{ page }} / {{ lastPage }}</span>
      <button type="button" class="btn btn-sm btn-icon" :disabled="page >= lastPage" aria-label="다음 쪽" data-testid="page-next" @click="setQuery({ page: String(page + 1) })"><Icon name="chevron-right" :size="13" /></button>
    </div>
  </div>
</template>

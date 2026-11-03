<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { db } from '../lib/conn'
import { ApiError, messageOf, rpc, toApiError } from '../lib/api'
import { onDataChanged, sendCommand } from '../lib/commands'
import { timeView, writeBlock } from '../lib/mode'
import { openRollback } from '../lib/rollback'
import { catalogOf, isAdmin, loadCompany, session } from '../lib/session'
import {
  canCommand, collectRefIds, deepEqual, emptyDraft, formFields, isDangerous, isDerived, isLongText, isNumeric, newId,
  visibleExtraCommands, visibleTransitions,
} from '../lib/fields'
import { fmtDateTime } from '../lib/format'
import { ensureNames, forgetName } from '../lib/refs'
import { onLedgerEvent } from '../lib/realtime'
import { ask, toast } from '../lib/ui'
import { COMPANY_ID, type CommandDef, type CommandResult, type ErpEvent, type ErpRecord, type Field, type State } from '../lib/types'
import { screenFor } from '../nav'
import EmptyState from '../components/EmptyState.vue'
import FieldInput from '../components/FieldInput.vue'
import FieldValue from '../components/FieldValue.vue'
import HistoryPanel from '../components/HistoryPanel.vue'
import Icon from '../components/Icon.vue'
import LinesEditor from '../components/LinesEditor.vue'
import StatePipeline from '../components/StatePipeline.vue'
import StatusPill from '../components/StatusPill.vue'

const props = defineProps<{ type: string; id?: string | null; embedded?: boolean }>()
const router = useRouter()
const route = useRoute()

const doc = computed(() => catalogOf(props.type))
const screen = computed(() => screenFor(props.type))
const isNew = computed(() => !props.id)

const record = ref<ErpRecord | null>(null)
const draft = ref<State>({})
const baseline = ref<State>({})
const loading = ref(true)
const notFound = ref(false)
const busy = ref(false)

const formError = ref('')
const conflict = ref(false)
const remoteNotice = ref('')
const remoteStale = ref(false)
const invalidField = ref('')

const events = ref<ErpEvent[]>([])
const eventsLoading = ref(false)
const eventsError = ref('')

// `company`: the date picked at the top of the app rather than this document's own slider.
const asOf = ref<{ version: number; at: string; state: State; company?: boolean } | null>(null)
const absentAtTime = ref(false)
const timeError = ref('')

function readHistoryPref() {
  try { return localStorage.getItem('erp.history') !== 'off' } catch { return true }
}
const showHistory = ref(readHistoryPref())
function toggleHistory() {
  showHistory.value = !showHistory.value
  try { localStorage.setItem('erp.history', showHistory.value ? 'on' : 'off') } catch { /* preference only */ }
}

const view = computed<State>(() => asOf.value?.state ?? draft.value)
const fields = computed<Field[]>(() => (doc.value
  ? formFields(doc.value, isNew.value).filter((f) => !(f.name === 'state' && doc.value?.states?.length) && !screen.value?.hideFields?.includes(f.name))
  : []))
const lineFields = computed(() => fields.value.filter((f) => f.type === 'lines'))
// With line tables, totals read best under the lines, like the foot of a printed document.
const totalFields = computed(() => (lineFields.value.length ? fields.value.filter((f) => f.type === 'money' && isDerived(f)) : []))
const gridFields = computed(() => fields.value.filter((f) => {
  if (f.type === 'lines' || totalFields.value.includes(f)) return false
  // A read-only value that is empty (merged into nothing, say) only adds noise.
  const empty = view.value[f.name] === null || view.value[f.name] === undefined || view.value[f.name] === ''
  return !(isDerived(f) && empty)
}))
const isAdvanced = (f: Field) => !!screen.value?.advanced?.includes(f.name) && !(f.required && isNew.value)
const mainFields = computed(() => gridFields.value.filter((f) => !isAdvanced(f)))
const advancedFields = computed(() => gridFields.value.filter(isAdvanced))
const extra = computed(() => (screen.value?.formExtra ? defineAsyncComponent(screen.value.formExtra) : null))

const canEdit = computed(() => {
  if (!doc.value) return false
  return canCommand(doc.value, isNew.value ? 'create' : 'update')
})
const timeTraveling = computed(() => !!asOf.value)
const closedState = computed(() => !isNew.value && !!screen.value?.readonlyIn?.includes(record.value?.status ?? ''))
const readOnly = computed(() => timeTraveling.value || !canEdit.value || closedState.value)
const status = computed(() => (asOf.value ? asOf.value.state.state ?? null : record.value?.status ?? draft.value.state ?? null))

const isShownAsValue = (f: Field) =>
  readOnly.value || isDerived(f) || (!isNew.value && (!!f.create_only || !!screen.value?.lockedAfterCreate?.includes(f.name)))
const isFull = (f: Field) => f.type === 'json' || isLongText(f)
const fieldId = (f: Field) => `f-${props.type}-${f.name}`

/* Change tracking */
const newBaselinePayload = ref<State>({})
// What erp_preview last saw or returned. The loader below runs immediately, so this must come first.
let lastPreviewJson = ''
const clean = (v: unknown) => (v === '' || v === undefined ? null : v)
const isWritable = (f: Field) => !isDerived(f) && !(!isNew.value && f.create_only)

function createPayload(): State {
  const out: State = {}
  for (const f of doc.value?.fields ?? []) {
    if (isDerived(f)) continue
    const v = clean(draft.value[f.name])
    if (v === null || (Array.isArray(v) && !v.length)) continue
    out[f.name] = v
  }
  return out
}
function updatePayload(): State {
  const out: State = {}
  for (const f of fields.value) {
    if (!isWritable(f) || screen.value?.lockedAfterCreate?.includes(f.name)) continue
    if (!deepEqual(clean(draft.value[f.name]), clean(baseline.value[f.name]))) out[f.name] = clean(draft.value[f.name])
  }
  return out
}
const dirty = computed(() => {
  if (timeTraveling.value || loading.value || !doc.value) return false
  return isNew.value ? !deepEqual(createPayload(), newBaselinePayload.value) : Object.keys(updatePayload()).length > 0
})

/* Loading */
let loadSeq = 0
function adoptRecord(r: ErpRecord) {
  record.value = r
  const next: State = {}
  for (const f of doc.value?.fields ?? []) {
    const v = r.state?.[f.name]
    next[f.name] = v ?? (f.type === 'lines' || f.type === 'tags' || f.type === 'refs' ? [] : null)
  }
  draft.value = next
  baseline.value = JSON.parse(JSON.stringify(next))
  lastPreviewJson = JSON.stringify(next)
  void resolveNames(next)
}
async function resolveNames(state: State) {
  const ids = new Set<string>()
  collectRefIds(doc.value?.fields ?? [], state, ids)
  try { await ensureNames(ids) } catch { /* inputs fall back to a placeholder */ }
}

async function loadRecord() {
  if (!doc.value) { loading.value = false; return }
  const my = ++loadSeq
  formError.value = ''
  conflict.value = false
  remoteNotice.value = ''
  remoteStale.value = false
  invalidField.value = ''
  asOf.value = null
  absentAtTime.value = false
  timeError.value = ''
  notFound.value = false
  if (isNew.value) {
    record.value = null
    events.value = []
    const empty = emptyDraft(doc.value)
    // A screen can link here with some values already chosen.
    for (const f of doc.value.fields) {
      const given = route.query[f.name]
      if (typeof given === 'string' && given && !isDerived(f)) empty[f.name] = isNumeric(f) ? Number(given) : given
    }
    draft.value = empty
    baseline.value = JSON.parse(JSON.stringify(empty))
    lastPreviewJson = JSON.stringify(empty)
    newBaselinePayload.value = createPayload()
    loading.value = false
    return
  }
  loading.value = true
  try {
    const { data, error, status: http } = await db().from('erp_records').select('*').eq('id', props.id!).eq('type', props.type).maybeSingle()
    if (my !== loadSeq) return
    if (error) throw toApiError(error, http)
    if (!data) {
      // Gone now, but it may have existed on the date being looked at.
      record.value = null
      if (timeView.at) {
        await applyCompanyTime()
        if (my !== loadSeq || asOf.value || absentAtTime.value || timeError.value) return
      }
      notFound.value = true
      return
    }
    adoptRecord(data as ErpRecord)
    if (timeView.at) await applyCompanyTime()
    else void loadStream()
  } catch (e) {
    if (my !== loadSeq) return
    if ((e as ApiError).code === 'INVALID') notFound.value = true
    else formError.value = messageOf(e)
  } finally {
    if (my === loadSeq) loading.value = false
  }
}

async function loadStream() {
  if (!props.id) return
  eventsLoading.value = true
  eventsError.value = ''
  try {
    events.value = await rpc<ErpEvent[]>('erp_stream', { p_id: props.id })
  } catch (e) {
    eventsError.value = messageOf(e)
  } finally {
    eventsLoading.value = false
  }
}

watch(() => [props.type, props.id], ([, id], old) => {
  // A record just created here is already loaded; only its address changed.
  if (id && old && !old[1] && record.value?.id === id) return
  void loadRecord()
}, { immediate: true })

/* Server-side calculation: the browser holds no business rules, so every change asks the server */
let previewTimer: ReturnType<typeof setTimeout> | undefined
let previewSeq = 0
const previewError = ref('')

function previewPayload(): State {
  const out: State = { ...draft.value }
  for (const f of doc.value?.fields ?? []) if (f.type === 'password') delete out[f.name]
  if (props.id) out.id = props.id
  return out
}

function mergeLines(current: State[], incoming: unknown): State[] {
  if (!Array.isArray(incoming)) return current
  return incoming.map((row, i) => {
    const mine = current.find((c) => c.id === row?.id) ?? current[i] ?? {}
    return { ...mine, ...row, id: row?.id ?? mine.id ?? newId() }
  })
}

function applyPreview(result: unknown) {
  if (!result || typeof result !== 'object') return
  const incoming = result as State
  const next: State = { ...draft.value }
  for (const f of doc.value?.fields ?? []) {
    if (!(f.name in incoming) || f.type === 'password') continue
    next[f.name] = f.type === 'lines' ? mergeLines(next[f.name] ?? [], incoming[f.name]) : incoming[f.name]
  }
  if (!deepEqual(next, draft.value)) draft.value = next
  lastPreviewJson = JSON.stringify(draft.value)
  void resolveNames(draft.value)
}

async function runPreview() {
  const my = ++previewSeq
  try {
    const result = await rpc('erp_preview', { p_type: props.type, p_payload: previewPayload() })
    // Anything typed while the request was out supersedes this answer.
    if (my === previewSeq) {
      previewError.value = ''
      applyPreview(result)
    }
  } catch (e) {
    if (my === previewSeq) previewError.value = messageOf(e)
  }
}

watch(draft, () => {
  if (loading.value || readOnly.value || !doc.value) return
  const now = JSON.stringify(draft.value)
  if (now === lastPreviewJson) return
  lastPreviewJson = now
  previewSeq++
  clearTimeout(previewTimer)
  previewTimer = setTimeout(runPreview, 300)
}, { deep: true })

/* Commands */
function handleCommandError(e: unknown) {
  const err = e as ApiError
  if (err.code === 'ERP_CONFLICT') {
    conflict.value = true
    formError.value = ''
    return
  }
  formError.value = messageOf(e)
  const hit = doc.value?.fields.find((f) => err.message?.startsWith(`${f.label} 항목`))
  invalidField.value = hit?.name ?? ''
}

function adoptResult(res: CommandResult) {
  const state = res.state ?? {}
  adoptRecord({
    id: res.id, type: res.type, version: res.version, name: res.name, status: res.status, state,
    active: state.active ?? true,
    created_at: record.value?.created_at ?? '', updated_at: new Date().toISOString(),
  })
  forgetName(res.id)
  if (props.type === 'company') void loadCompany()
}

async function save(): Promise<boolean> {
  if (!doc.value || busy.value) return false
  formError.value = ''
  invalidField.value = ''
  clearTimeout(previewTimer)
  previewSeq++
  busy.value = true
  try {
    if (isNew.value) {
      const res = await sendCommand({ type: props.type, command: 'create', payload: createPayload() })
      adoptResult(res)
      newBaselinePayload.value = createPayload()
      toast('저장했습니다.')
      await router.replace({ name: 'record', params: { type: props.type, id: res.id } })
      void loadStream()
      return true
    }
    const payload = updatePayload()
    if (!Object.keys(payload).length) return true
    const res = await sendCommand({ type: props.type, id: props.id, command: 'update', payload, expectedVersion: record.value?.version ?? null })
    adoptResult(res)
    remoteStale.value = false
    remoteNotice.value = ''
    toast('저장했습니다.')
    void loadStream()
    return true
  } catch (e) {
    handleCommandError(e)
    return false
  } finally {
    busy.value = false
  }
}

function setField(f: Field, value: unknown) {
  draft.value[f.name] = value
  // The complaint was about this field, so it stops applying once the field changes.
  if (invalidField.value === f.name) {
    invalidField.value = ''
    formError.value = ''
  }
}

function revert() {
  draft.value = JSON.parse(JSON.stringify(baseline.value))
  lastPreviewJson = JSON.stringify(draft.value)
  formError.value = ''
  invalidField.value = ''
  previewError.value = ''
}

async function runCommand(command: string, label: string, def: Pick<CommandDef, 'params' | 'danger' | 'confirm'> = {}, after?: () => void) {
  if (!doc.value || !props.id) return
  const ui = screen.value?.commands?.[command]
  const danger = isDangerous(command, def)
  // A JSON box is no way to ask a person anything. Such parameters are for other callers, or the screen fills them.
  const params = ui?.fields ? ui.fields(record.value) : def.params?.filter((p) => p.type !== 'json' && !p.api_only && !ui?.hideParams?.includes(p.name))
  let payload: State = {}
  let reason: string | null = null
  if (params?.length || danger) {
    const answer = await ask({
      title: label,
      message: def.confirm ?? (danger ? `"${label}" 작업을 진행할까요? 이 변경은 이력에 그대로 남습니다.` : undefined),
      fields: params,
      danger,
      reason: danger,
      confirmLabel: label,
    })
    if (!answer) return
    payload = ui?.payload ? ui.payload(answer.values) : answer.values
    reason = answer.reason || null
  }
  // An action means "with what is on screen", so unsaved edits are saved first.
  if (dirty.value && !(await save())) return
  busy.value = true
  formError.value = ''
  try {
    for (;;) {
      try {
        const res = await sendCommand({ type: props.type, id: props.id, command, payload, expectedVersion: record.value?.version ?? null, reason })
        adoptResult(res)
        toast(`${label} 완료`)
        void loadStream()
        after?.()
        return
      } catch (e) {
        const err = e as ApiError
        const retry = err.code ? ui?.retry?.[err.code] : undefined
        if (!retry) throw e
        const { payload: toPayload, ...question } = retry
        // The database's own sentence explains what it found. It stands in only where no wording was set here.
        const answer = await ask({ confirmLabel: label, message: err.message.replace(/\s*\([a-z_]+\)\.?$/, ''), ...question })
        if (!answer) return
        payload = { ...payload, ...toPayload(answer.values) }
      }
    }
  } catch (e) {
    handleCommandError(e)
  } finally {
    busy.value = false
  }
}

const transitions = computed(() => (doc.value && !isNew.value && !timeTraveling.value ? visibleTransitions(doc.value, status.value) : []))
const extraCommands = computed(() => (doc.value && !isNew.value && !timeTraveling.value ? visibleExtraCommands(doc.value) : []))
const isActive = computed(() => record.value?.state?.active !== false)

interface MenuItem { key: string; label: string; danger?: boolean; run: () => void }
const menuItems = computed<MenuItem[]>(() => {
  if (!doc.value || isNew.value || timeTraveling.value) return []
  const items: MenuItem[] = extraCommands.value.map((c) => ({
    key: c.command, label: c.label, danger: !!c.danger, run: () => void runCommand(c.command, c.label, c),
  }))
  if (isActive.value && canCommand(doc.value, 'archive')) {
    items.push({ key: 'archive', label: '보관', run: () => void runCommand('archive', '보관', { confirm: '보관하면 목록과 선택 입력에서 숨겨집니다. "보관 포함"으로 다시 볼 수 있습니다.' }) })
  }
  if (!isActive.value && canCommand(doc.value, 'unarchive')) {
    items.push({ key: 'unarchive', label: '보관 해제', run: () => void runCommand('unarchive', '보관 해제') })
  }
  if (canCommand(doc.value, 'delete')) {
    items.push({
      key: 'delete', label: '삭제', danger: true,
      run: () => void runCommand('delete', '삭제', { confirm: '삭제하면 목록에서 사라집니다. 지나간 이벤트는 원장에 남습니다.' }, () => {
        void router.replace({ name: 'list', params: { type: props.type } })
      }),
    })
  }
  return items
})
const menuOpen = ref(false)
function closeMenu() { menuOpen.value = false }

/* Refresh */
async function refreshFromServer() {
  await loadRecord()
}

/* Time travel */
let asOfSeq = 0
let asOfTimer: ReturnType<typeof setTimeout> | undefined
function selectVersion(version: number | null) {
  clearTimeout(asOfTimer)
  const my = ++asOfSeq
  if (version === null) {
    if (timeView.at) void applyCompanyTime()
    else asOf.value = null
    return
  }
  asOfTimer = setTimeout(async () => {
    const ev = events.value.find((x) => x.version === version)
    if (!ev || !props.id) return
    try {
      // By version, not time: events of one transaction share a timestamp.
      const state = await rpc<State>('erp_at_version', { p_id: props.id, p_version: version })
      if (my !== asOfSeq) return
      await resolveNames(state)
      if (my === asOfSeq) asOf.value = { version, at: ev.occurred_at, state }
    } catch (e) {
      toast(messageOf(e), 'error')
    }
  }, 120)
}

/* The date picked at the top of the app */
async function applyCompanyTime() {
  const at = timeView.at
  if (!at || !props.id) return
  const my = ++asOfSeq
  absentAtTime.value = false
  timeError.value = ''
  try {
    await loadStream()
    const state = await rpc<State>('erp_as_of', { p_id: props.id, p_at: at })
    if (my !== asOfSeq) return
    if (!state || !Object.keys(state).length || state.deleted) {
      asOf.value = null
      absentAtTime.value = true
      return
    }
    await resolveNames(state)
    if (my !== asOfSeq) return
    const cutoff = Date.parse(at)
    const seen = events.value.filter((e) => Date.parse(e.occurred_at) <= cutoff)
    asOf.value = { version: seen[seen.length - 1]?.version ?? 0, at, state, company: true }
  } catch (e) {
    if (my !== asOfSeq) return
    // Falling back to the current document here would pass off today's values as that date's.
    asOf.value = null
    if ((e as ApiError).code === 'ERP_FORBIDDEN') notFound.value = true
    else timeError.value = messageOf(e)
  }
}

watch(() => timeView.at, (at) => {
  if (isNew.value) return
  if (at) {
    // Anything being typed stays in the draft, under the past, for when the date is cleared.
    if (record.value) void applyCompanyTime()
    else void loadRecord()
    return
  }
  asOfSeq++
  asOf.value = null
  absentAtTime.value = false
  timeError.value = ''
  if (!record.value) void loadRecord()
})

/* Rollback */
const canRollback = computed(() => isAdmin() && !writeBlock.value && doc.value?.revertible !== false)

async function rollbackWork(ev: ErpEvent) {
  await openRollback('correlation', { correlation_id: ev.correlation_id }, '이 작업 되돌리기', `${fmtDateTime(ev.occurred_at)} ${ev.actor_name ?? '시스템'}의 작업과 그로 이어진 일을 되돌립니다.`)
}
async function rollbackVersion(ev: ErpEvent) {
  await openRollback('record', { id: props.id, version: ev.version }, '이 버전으로 되돌리기', `이 문서를 v${ev.version} (${fmtDateTime(ev.occurred_at)}) 의 모습으로 되돌립니다.`)
}
async function rollbackToShown() {
  const shown = asOf.value
  if (!shown) return
  const ev = events.value.find((x) => x.version === shown.version)
  if (ev) await rollbackVersion(ev)
}

/* Work other modules did after a command, and rollbacks: realtime may be off, so this reads for itself. */
async function rereadAfterChange() {
  if (!props.id || !record.value || busy.value) return
  const { data, error } = await db().from('erp_records').select('*').eq('id', props.id).eq('type', props.type).maybeSingle()
  const current = record.value
  if (error || !current) return
  void loadStream()
  if (!data) {
    if (timeView.at) return
    asOf.value = null
    notFound.value = true
    return
  }
  const fresh = data as ErpRecord
  // A slower read can come back after a later save has already moved this screen on.
  if (fresh.version <= current.version) return
  if (dirty.value) {
    remoteStale.value = true
    remoteNotice.value = '다른 모듈이 이 문서를 변경했습니다. 지금 저장하면 충돌합니다. 새로 고치면 입력 중인 내용은 사라집니다.'
    return
  }
  if (!timeView.at) asOf.value = null
  adoptRecord(fresh)
}
onDataChanged(() => { void rereadAfterChange() })

/* Live changes from other people */
onLedgerEvent((ev) => {
  if (ev.stream_id !== props.id || !record.value) return
  if (ev.version <= record.value.version) return
  // This tab's own command: its response is on the way and will update the screen.
  if (busy.value && ev.actor_id === session.me?.user_id) return
  void loadStream()
  const who = ev.source === 'rollback' ? '되돌리기' : ev.source === 'reaction' || ev.source.startsWith('bus:') ? '연쇄 반응' : `${ev.actor_name ?? '다른 사용자'} 님`
  if (dirty.value) {
    remoteStale.value = true
    remoteNotice.value = `${who}이 이 문서를 변경했습니다. 지금 저장하면 충돌합니다. 새로 고치면 입력 중인 내용은 사라집니다.`
    return
  }
  remoteNotice.value = `${who}이 방금 이 문서를 변경해 화면을 새로 고쳤습니다.`
  remoteStale.value = false
  void db().from('erp_records').select('*').eq('id', props.id!).maybeSingle().then(({ data }) => {
    if (data && !dirty.value) adoptRecord(data as ErpRecord)
  })
})

/* Page-level behaviour */
function onKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    if (dirty.value && !readOnly.value) void save()
  }
}
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (dirty.value) e.preventDefault()
}
function onDocClick() { closeMenu() }
onMounted(() => {
  document.addEventListener('keydown', onKey)
  window.addEventListener('beforeunload', onBeforeUnload)
  document.addEventListener('click', onDocClick)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey)
  window.removeEventListener('beforeunload', onBeforeUnload)
  document.removeEventListener('click', onDocClick)
  clearTimeout(previewTimer)
  clearTimeout(asOfTimer)
})
onBeforeRouteLeave(async () => {
  if (!dirty.value) return true
  const answer = await ask({ title: '저장하지 않은 변경', message: '입력한 내용이 저장되지 않았습니다. 이 화면을 떠날까요?', confirmLabel: '저장 안 하고 떠나기', cancelLabel: '계속 입력', danger: true })
  return !!answer
})

const title = computed(() => {
  if (isNew.value) return `새 ${doc.value?.label ?? ''}`
  return (asOf.value ? asOf.value.state.number ?? asOf.value.state.name : record.value?.name) ?? doc.value?.label ?? ''
})
const printDate = computed(() => fmtDateTime(new Date().toISOString()).slice(0, 10))
watch(title, (t) => { if (!props.embedded && t) document.title = `${t} · uEngine ERP` }, { immediate: true })
const printPage = () => window.print()
const backTo = computed(() => (props.type === 'member' ? { path: '/settings/members' } : { name: 'list', params: { type: props.type } }))
const isCompanyForm = computed(() => props.id === COMPANY_ID)
</script>

<template>
  <div v-if="!doc" class="page">
    <div class="page-body"><EmptyState title="설치되지 않은 화면입니다" text="이 유형이 아직 데이터베이스에 없거나, 이 유형을 쓰는 모듈이 꺼져 있습니다. 데이터와 이력은 남아 있으니 모듈을 켜면 다시 보입니다." /></div>
  </div>
  <div v-else-if="notFound" class="page">
    <div class="page-body">
      <EmptyState title="이 문서를 찾을 수 없습니다" text="삭제되었거나, 이 문서를 볼 권한이 없습니다.">
        <router-link class="btn" :to="backTo">{{ doc.label }} 목록으로</router-link>
      </EmptyState>
    </div>
  </div>
  <div v-else-if="timeError || absentAtTime || (isNew && timeView.at)" class="page">
    <div class="page-body">
      <EmptyState v-if="timeError" title="그 시점의 모습을 읽지 못했습니다" :text="timeError">
        <button type="button" class="btn" data-testid="time-retry" @click="applyCompanyTime">다시 시도</button>
      </EmptyState>
      <EmptyState v-else-if="absentAtTime" title="이 시점에는 없던 문서입니다" :text="`${timeView.date} 뒤에 만들어졌습니다.`">
        <router-link v-if="!isCompanyForm" class="btn" :to="backTo">{{ doc.label }} 목록으로</router-link>
      </EmptyState>
      <EmptyState v-else title="과거 시점에서는 새로 만들 수 없습니다" :text="`${timeView.date} 시점을 보고 있습니다. 현재로 돌아간 뒤 만드세요.`" />
    </div>
  </div>
  <div v-else class="page form-page" data-testid="meta-form">
    <div class="print-only print-head">
      <div>{{ session.company?.state?.name }}</div>
      <div class="small">{{ doc.label }} · 출력일 {{ printDate }}</div>
    </div>

    <header class="form-head">
      <div class="form-title-row">
        <div class="crumbs">
          <router-link v-if="!isCompanyForm" :to="backTo" class="no-print">{{ doc.label }}</router-link>
          <Icon v-if="!isCompanyForm" class="no-print muted" name="chevron-right" :size="12" />
          <h1 class="ellipsis" data-testid="form-title">{{ title }}</h1>
          <StatusPill :doc="doc" :value="status" />
          <span v-if="record && !isActive" class="tag">보관</span>
          <span v-if="record" class="muted small nowrap no-print" data-testid="form-version">v{{ asOf ? asOf.version : record.version }}</span>
        </div>
        <StatePipeline class="no-print" :doc="doc" :value="status" />
      </div>
      <div class="form-actions no-print">
        <template v-if="!timeTraveling && canEdit && !closedState">
          <button type="button" class="btn btn-primary" :disabled="busy || (!isNew && !dirty)" data-testid="save" @click="save">{{ busy ? '저장 중…' : '저장' }}</button>
          <button v-if="dirty && !isNew" type="button" class="btn" :disabled="busy" data-testid="revert" @click="revert">되돌리기</button>
        </template>
        <span v-if="transitions.length && !timeTraveling && canEdit && !closedState" class="sep"></span>
        <button v-for="t in transitions" :key="t.command" type="button" class="btn" :class="{ 'btn-primary': t.primary && !dirty, 'btn-danger': !t.primary && isDangerous(t.command, t) }"
                :disabled="busy" :data-testid="`tr-${t.command}`" @click="runCommand(t.command, t.label, t)">{{ t.label }}</button>
        <span v-if="dirty" class="muted small" data-testid="dirty-mark">저장하지 않은 변경 있음</span>
        <component :is="extra" v-if="extra && record && !isNew" :record="asOf ? null : record" :doc="doc" />
        <div class="grow"></div>
        <div v-if="menuItems.length" class="menu-wrap">
          <button type="button" class="btn" aria-haspopup="menu" :aria-expanded="menuOpen" data-testid="more-menu" @click.stop="menuOpen = !menuOpen"><Icon name="more" />더 보기</button>
          <div v-if="menuOpen" class="menu" role="menu">
            <button v-for="m in menuItems" :key="m.key" type="button" role="menuitem" :class="{ danger: m.danger }" :data-testid="`menu-${m.key}`" @click="closeMenu(); m.run()">{{ m.label }}</button>
          </div>
        </div>
        <button v-if="!isNew" type="button" class="btn" data-testid="print" @click="printPage"><Icon name="printer" />인쇄</button>
        <button v-if="!isNew" type="button" class="btn" :aria-pressed="showHistory" data-testid="toggle-history" @click="toggleHistory"><Icon name="history" />이력</button>
      </div>
    </header>

    <div v-if="timeTraveling && !asOf?.company" class="banner banner-time banner-flush no-print" data-testid="time-banner">
      <Icon name="history" />
      <span class="grow">{{ fmtDateTime(asOf?.at) }} 시점의 모습입니다 (v{{ asOf?.version }} / v{{ record?.version }}). 읽기 전용입니다.</span>
      <button v-if="isAdmin() && !writeBlock && doc.revertible !== false" type="button" class="btn btn-sm btn-danger" data-testid="time-rollback-version" @click="rollbackToShown">이 버전으로 되돌리기</button>
      <button type="button" class="btn btn-sm" data-testid="time-exit" @click="selectVersion(null)">현재로 돌아가기</button>
    </div>
    <div v-if="conflict" class="banner banner-warn banner-flush no-print" role="alert" data-testid="conflict">
      <Icon name="alert" />
      <span class="grow">다른 사람이 먼저 변경했습니다. 새로 고친 뒤 다시 입력하세요.</span>
      <button type="button" class="btn btn-sm" data-testid="conflict-refresh" @click="refreshFromServer"><Icon name="refresh" :size="12" />새로 고침</button>
    </div>
    <div v-else-if="remoteNotice" class="banner banner-flush no-print" :class="remoteStale ? 'banner-warn' : 'banner-info'" role="status" data-testid="remote-notice">
      <Icon :name="remoteStale ? 'alert' : 'info'" />
      <span class="grow">{{ remoteNotice }}</span>
      <button v-if="remoteStale" type="button" class="btn btn-sm" @click="refreshFromServer"><Icon name="refresh" :size="12" />새로 고침</button>
      <button v-else type="button" class="btn btn-sm btn-ghost" aria-label="닫기" @click="remoteNotice = ''"><Icon name="x" :size="12" /></button>
    </div>
    <div v-if="formError" class="banner banner-error banner-flush no-print" role="alert" data-testid="form-error"><Icon name="alert" /><span class="grow">{{ formError }}</span></div>
    <div v-if="previewError && !formError && !timeTraveling" class="banner banner-warn banner-flush no-print" data-testid="preview-error"><Icon name="info" /><span class="grow">자동 계산을 하지 못했습니다: {{ previewError }}</span></div>

    <div class="form-layout">
      <div class="form-main">
        <p v-if="loading" class="muted" style="padding: 16px">불러오는 중…</p>
        <form v-else class="form-sheet" autocomplete="off" @submit.prevent="save">
          <div class="field-grid">
            <div v-for="f in mainFields" :key="f.name" class="field" :class="{ full: isFull(f) }" :data-field="f.name">
              <label class="field-label" :for="fieldId(f)">{{ f.label }}<span v-if="f.required && !isShownAsValue(f)" class="req" aria-hidden="true">*</span></label>
              <div>
                <div v-if="isShownAsValue(f)" class="field-value" :id="fieldId(f)"><FieldValue :field="f" :value="view[f.name]" /></div>
                <FieldInput v-else :id="fieldId(f)" :field="f" :invalid="invalidField === f.name" :model-value="draft[f.name]" @update:model-value="setField(f, $event)" />
                <div v-if="f.help && !isShownAsValue(f)" class="hint" style="margin-top: 2px">{{ f.help }}</div>
              </div>
            </div>
          </div>
          <details v-if="advancedFields.length" class="form-more no-print" data-testid="form-advanced">
            <summary>그 밖의 항목 {{ advancedFields.length }}개</summary>
            <div class="field-grid">
              <div v-for="f in advancedFields" :key="f.name" class="field" :class="{ full: isFull(f) }" :data-field="f.name">
                <label class="field-label" :for="fieldId(f)">{{ f.label }}</label>
                <div>
                  <div v-if="isShownAsValue(f)" class="field-value" :id="fieldId(f)"><FieldValue :field="f" :value="view[f.name]" /></div>
                  <FieldInput v-else :id="fieldId(f)" :field="f" :invalid="invalidField === f.name" :model-value="draft[f.name]" @update:model-value="setField(f, $event)" />
                  <div v-if="f.help && !isShownAsValue(f)" class="hint" style="margin-top: 2px">{{ f.help }}</div>
                </div>
              </div>
            </div>
          </details>

          <section v-for="f in lineFields" :key="f.name" class="form-lines" :data-field="f.name">
            <h2>{{ f.label }}</h2>
            <LinesEditor :field="f" :model-value="view[f.name]" :readonly="readOnly || isDerived(f)" :sections="screen?.sections"
                         :fixed-rows="screen?.fixedLines?.includes(f.name)" :hide-columns="screen?.hideColumns?.[f.name]" @update:model-value="draft[f.name] = $event" />
          </section>

          <dl v-if="totalFields.length" class="totals" data-testid="totals">
            <template v-for="(f, i) in totalFields" :key="f.name">
              <dt :class="{ grand: i === totalFields.length - 1 }">{{ f.label }}</dt>
              <dd :class="{ grand: i === totalFields.length - 1 }" :data-field="f.name"><FieldValue :field="f" :value="view[f.name]" /></dd>
            </template>
          </dl>
        </form>
      </div>
      <HistoryPanel v-if="!isNew && showHistory" :doc="doc" :events="events" :version="asOf?.version ?? null" :loading="eventsLoading" :error="eventsError" :can-rollback="canRollback"
                    @select="selectVersion" @retry="loadStream" @rollback-work="rollbackWork" @rollback-version="rollbackVersion" />
    </div>
  </div>
</template>

<style scoped>
.form-head { flex: none; background: var(--surface); border-bottom: 1px solid var(--line); }
.form-title-row { display: flex; align-items: center; gap: 12px; min-height: 40px; padding: 6px 16px 0; }
.crumbs { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1 1 auto; }
.crumbs a { white-space: nowrap; color: var(--text-2); }
.form-actions { display: flex; align-items: center; gap: 6px; min-height: 40px; padding: 2px 16px 6px; }
.sep { width: 1px; height: 18px; margin: 0 4px; background: var(--line-strong); }
.form-layout { display: flex; flex: 1 1 auto; min-height: 0; }
.form-main { flex: 1 1 auto; min-width: 0; overflow: auto; background: var(--surface); }
.form-sheet { padding: 12px 16px 28px; }
.form-more { margin-top: 8px; }
.form-more > summary { margin-bottom: 6px; }
.form-lines { margin-top: 14px; }
.form-lines h2 { margin-bottom: 6px; font-size: 13px; }
.totals { display: grid; grid-template-columns: auto 130px; justify-content: end; gap: 3px 16px; margin: 10px 0 0; }
.totals dt { color: var(--text-2); text-align: right; }
.totals dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.totals .grand { padding-top: 4px; border-top: 1px solid var(--line-strong); font-size: 14px; font-weight: 650; color: var(--text); }
.print-head { padding-bottom: 10px; font-weight: 650; }
@media (max-width: 720px) {
  .form-title-row { flex-wrap: wrap; padding-bottom: 4px; }
  .form-actions { flex-wrap: wrap; }
  .form-layout { flex-direction: column; overflow: auto; }
  .form-main { flex: none; overflow: visible; }
  .pipeline { max-width: 100%; overflow-x: auto; }
}
@media print {
  .form-head { border: 0; }
  .form-title-row { padding: 0 0 8px; }
  .form-sheet { padding: 0; }
}
</style>

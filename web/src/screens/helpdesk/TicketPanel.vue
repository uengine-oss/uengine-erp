<script setup lang="ts">
// Under a ticket: where its SLA stands, the conversation and a box to answer, the customer's link, and the contact person.
// The SLA status moves with the clock, so the database works it out each time; this screen only draws it. The contact person can
// ask to be forgotten, so saving it is a step of its own and the values never reach the ledger (as on a lead).
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { messageOf, rpc, toApiError } from '../../lib/api'
import { onDataChanged, sendCommand } from '../../lib/commands'
import { conn, db } from '../../lib/conn'
import { deepEqual } from '../../lib/fields'
import { fmtDateTime, fmtNumber } from '../../lib/format'
import { writeBlock } from '../../lib/mode'
import { hasRole } from '../../lib/session'
import type { CatalogDoc, ErpRecord, Field, State } from '../../lib/types'
import { ask, copyText, toast } from '../../lib/ui'
import FieldInput from '../../components/FieldInput.vue'
import Icon from '../../components/Icon.vue'
import { CLOCK, KIND, supportLink, type Sla } from './sla'

const props = defineProps<{ record: ErpRecord | null; draft: State; doc: CatalogDoc; readonly: boolean }>()

const canWrite = computed(() => hasRole(['helpdesk']) && !writeBlock.value)
const sla = ref<Sla | null>(null)
const error = ref('')
const busy = ref(false)

/* SLA */
let seq = 0
async function loadSla() {
  const id = props.record?.id
  if (!id) { sla.value = null; return }
  const my = ++seq
  try {
    const got = await rpc<Sla[]>('erp_helpdesk_sla', { p_ids: [id], p_at: null })
    if (my === seq) sla.value = got[0] ?? null
  } catch (e) {
    if (my === seq) error.value = messageOf(e)
  }
}
// "At risk" comes with time and no event, so it is asked again while the ticket is open on screen.
const timer = setInterval(() => { if (props.record && ['new', 'in_progress', 'waiting'].includes(props.record.status ?? '')) void loadSla() }, 30_000)
onBeforeUnmount(() => clearInterval(timer))

const clocks = computed(() => (sla.value ? [{ key: 'response', label: '첫 응답', c: sla.value.response }, { key: 'resolve', label: '해결', c: sla.value.resolve }].filter((x) => x.c.status !== 'none' || x.c.target_minutes) : []))
function leftText(c: Sla['response']): string {
  if (c.status === 'met') return c.done_at ? `${fmtDateTime(c.done_at).slice(5, 16)} 에 마침` : '마침'
  if (c.paused) return `고객 대기라 멈춤 · 남은 ${hours(c.left_minutes)}`
  if (c.status === 'breached') return c.due ? `${fmtDateTime(c.due).slice(5, 16)} 에 기한이 지났습니다` : '기한이 지났습니다'
  if (c.left_minutes === null || c.left_minutes === undefined) return ''
  return `남은 ${hours(c.left_minutes)}`
}
function hours(min: number | null | undefined): string {
  if (min === null || min === undefined) return ''
  const m = Math.max(0, Math.round(min))
  return m >= 60 ? `${fmtNumber(Math.floor(m / 60))}시간${m % 60 ? ` ${m % 60}분` : ''}` : `${m}분`
}

/* The conversation */
const messages = computed<State[]>(() => (Array.isArray(props.record?.state.messages) ? props.record!.state.messages : []))
const kind = ref<'reply' | 'note' | 'customer_comment'>('reply')
const body = ref('')
const thenWait = ref(false)
const open = computed(() => !['closed', 'cancelled'].includes(props.record?.status ?? ''))
async function send() {
  const id = props.record?.id
  if (!id || busy.value || !body.value.trim()) return
  busy.value = true
  error.value = ''
  try {
    const payload: State = { message: body.value }
    if (kind.value === 'reply' && thenWait.value) payload.wait = true
    await sendCommand({ type: 'helpdesk_ticket', id, command: kind.value, payload })
    body.value = ''
    thenWait.value = false
    toast(kind.value === 'reply' ? '답장을 남겼습니다.' : kind.value === 'note' ? '메모를 남겼습니다.' : '고객의 글을 적었습니다.')
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}

/* The customer's link */
const link = computed(() => (props.record?.state.portal_token && conn.value ? supportLink(conn.value, props.record.state.portal_token) : ''))
async function copyLink() {
  if (link.value && (await copyText(link.value))) toast('고객 링크를 복사했습니다. 고객은 이 링크로 진행을 보고 글을 남깁니다.')
  else toast('복사하지 못했습니다. 브라우저가 클립보드를 막았습니다.', 'error')
}
async function renewLink() {
  if (!props.record) return
  const answer = await ask({ title: '고객 링크 새로 만들기', message: '지금 링크는 더 열리지 않습니다. 새 링크를 고객에게 다시 보내야 합니다.', confirmLabel: '새로 만들기' })
  if (!answer) return
  try {
    await sendCommand({ type: 'helpdesk_ticket', id: props.record.id, command: 'renew_link', payload: {} })
    toast('새 링크를 만들었습니다.')
  } catch (e) {
    error.value = messageOf(e)
  }
}

/* The contact person, outside the ledger */
const fields = computed<Field[]>(() => props.doc.private_fields ?? [])
const saved = ref<State>({})
const values = ref<State>({})
const hasRow = ref(false)
const changed = computed<State>(() => Object.fromEntries(fields.value
  .filter((f) => !deepEqual(values.value[f.name] || null, saved.value[f.name] || null))
  .map((f) => [f.name, values.value[f.name] || null])))
const dirty = computed(() => Object.keys(changed.value).length > 0)
let pseq = 0
async function loadPrivate() {
  const id = props.record?.id
  if (!id || !hasRole(['helpdesk'])) return
  const my = ++pseq
  const { data, error: err, status } = await db().from('erp_helpdesk_ticket_private').select('*').eq('ticket_id', id).maybeSingle()
  if (my !== pseq) return
  if (err) { error.value = messageOf(toApiError(err, status)); return }
  const next: State = {}
  for (const f of fields.value) next[f.name] = data?.[f.name] ?? null
  saved.value = next
  values.value = { ...next }
  hasRow.value = !!data
}
async function savePrivate() {
  if (!props.record || !dirty.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await sendCommand({ type: 'helpdesk_ticket', id: props.record.id, command: 'set_private', payload: changed.value })
    toast('연락처를 저장했습니다.')
    await loadPrivate()
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}
async function erasePrivate() {
  if (!props.record || busy.value) return
  const answer = await ask({
    title: '연락처 지우기',
    message: '이 티켓의 연락처를 지웁니다. 되돌릴 수 없습니다.\n원장에는 지웠다는 사실과 사유, 처리한 사람만 남습니다. 사유에 지우는 값을 적지 마세요.',
    danger: true, reason: true, reasonRequired: true, confirmLabel: '지우기',
  })
  if (!answer) return
  busy.value = true
  try {
    await sendCommand({ type: 'helpdesk_ticket', id: props.record.id, command: 'erase_private', payload: {}, reason: answer.reason })
    toast('연락처를 지웠습니다.')
    await loadPrivate()
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}

watch(() => [props.record?.id, props.record?.version], () => { void loadSla(); void loadPrivate() }, { immediate: true })
onDataChanged(() => { void loadSla() })
</script>

<template>
  <section v-if="record" class="hd no-print" data-testid="hd-panel">
    <p v-if="error" class="err-text small" role="alert" data-testid="hd-error">{{ error }}</p>

    <div class="block" data-testid="hd-sla">
      <h2>SLA
        <span v-if="sla && sla.status !== 'none'" class="pill" :class="`pill-${CLOCK[sla.status].color}`" data-testid="hd-sla-status">{{ CLOCK[sla.status].label }}</span>
        <span v-if="sla?.policy" class="muted small">{{ sla.policy }} · {{ sla.basis === 'working' ? '근무 시간' : '달력 시간' }}</span>
      </h2>
      <p v-if="!clocks.length" class="muted small" data-testid="hd-sla-none">이 티켓에 맞는 SLA 정책이 없습니다. 팀과 우선순위를 확인하세요.</p>
      <div v-for="x in clocks" :key="x.key" class="clock" :data-testid="`hd-sla-${x.key}`" :data-status="x.c.status">
        <span class="clock-name">{{ x.label }}</span>
        <span class="pill" :class="`pill-${CLOCK[x.c.status].color}`">{{ CLOCK[x.c.status].label }}</span>
        <span class="small">{{ x.c.target_minutes ? `${hours(x.c.target_minutes)} 안에` : '' }}<template v-if="x.c.due"> · 기한 {{ fmtDateTime(x.c.due).slice(0, 16) }}</template></span>
        <span class="small dim">{{ leftText(x.c) }}</span>
      </div>
    </div>

    <div class="block" data-testid="hd-thread">
      <h2>대화 <span class="muted small">답장과 고객 글은 고객 링크에도 보입니다. 내부 메모는 보이지 않습니다</span></h2>
      <p v-if="!messages.length" class="muted small">아직 주고받은 글이 없습니다.</p>
      <ol class="thread">
        <li v-for="m in messages" :key="m.id" :class="`msg msg-${m.kind}`" data-testid="hd-message" :data-kind="m.kind">
          <div class="msg-head small"><span class="tag">{{ KIND[m.kind] ?? m.kind }}</span><strong>{{ m.kind === 'customer' ? (m.via === 'portal' ? '고객(링크)' : '고객') : m.by }}</strong><span class="dim">{{ fmtDateTime(m.at).slice(0, 16) }}</span></div>
          <p class="msg-body">{{ m.body }}</p>
        </li>
      </ol>
      <form v-if="canWrite && open" class="compose" data-testid="hd-compose" @submit.prevent="send">
        <div class="seg" role="group" aria-label="글 종류">
          <button type="button" :class="{ on: kind === 'reply' }" :aria-pressed="kind === 'reply'" data-testid="hd-kind-reply" @click="kind = 'reply'">답장</button>
          <button type="button" :class="{ on: kind === 'note' }" :aria-pressed="kind === 'note'" data-testid="hd-kind-note" @click="kind = 'note'">내부 메모</button>
          <button type="button" :class="{ on: kind === 'customer_comment' }" :aria-pressed="kind === 'customer_comment'" data-testid="hd-kind-customer" @click="kind = 'customer_comment'">고객 글 적기</button>
        </div>
        <textarea v-model="body" class="input" rows="3" maxlength="4000" :placeholder="kind === 'reply' ? '고객에게 보낼 답' : kind === 'note' ? '팀 안에서만 보는 메모' : '전화나 메일로 받은 고객의 말'" aria-label="내용" data-testid="hd-body"></textarea>
        <div class="row-wrap">
          <label v-if="kind === 'reply' && ['new', 'in_progress'].includes(record.status ?? '')" class="check small"><input v-model="thenWait" type="checkbox" data-testid="hd-then-wait" /> 답한 뒤 고객 대기로 둡니다(해결 시계가 멈춥니다)</label>
          <span class="grow"></span>
          <button type="submit" class="btn btn-primary" :disabled="busy || !body.trim()" data-testid="hd-send">{{ kind === 'reply' ? '답장 보내기' : kind === 'note' ? '메모 남기기' : '고객 글 적기' }}</button>
        </div>
      </form>
    </div>

    <div v-if="link" class="block" data-testid="hd-link">
      <h2>고객 링크 <span class="muted small">계정 없이 이 문의의 진행을 보고 글을 남깁니다. 고객이 남긴 글은 대기 중인 티켓을 다시 진행으로 돌립니다</span></h2>
      <div class="row-wrap">
        <!-- The link carries the project's public key: copied or opened whole, shown only by its ticket part. -->
        <code class="link-short grow" data-testid="hd-link-url">…/support/{{ String(record.state.portal_token).slice(0, 10) }}…</code>
        <button type="button" class="btn" data-testid="hd-link-copy" @click="copyLink"><Icon name="copy" :size="13" />복사</button>
        <a class="btn" :href="link" target="_blank" rel="noopener" data-testid="hd-link-open"><Icon name="external" :size="13" />열기</a>
        <button v-if="canWrite" type="button" class="btn btn-ghost" data-testid="hd-link-renew" @click="renewLink">새로 만들기</button>
      </div>
    </div>

    <div v-if="hasRole(['helpdesk'])" class="block" data-testid="hd-contact">
      <h2><Icon name="lock" :size="13" /> 고객 담당자 연락처 <span class="muted small">헬프데스크 담당과 관리자만 봅니다</span></h2>
      <p class="note small" data-testid="hd-contact-note">사람이 지워 달라고 할 수 있는 값이라 원장 밖에 저장합니다. 이력에는 어느 칸이 바뀌었는지만 남고, 지우면 되돌릴 수 없습니다.</p>
      <div class="field-grid" @keydown.enter.prevent="savePrivate">
        <div v-for="f in fields" :key="f.name" class="field" :data-field="`contact-${f.name}`">
          <label class="field-label" :for="`hc-${f.name}`">{{ f.label }}</label>
          <div><FieldInput :id="`hc-${f.name}`" :field="f" :disabled="!!writeBlock" :model-value="values[f.name]" @update:model-value="values[f.name] = $event" /></div>
        </div>
      </div>
      <div class="row-wrap" style="margin-top: 8px">
        <button type="button" class="btn btn-primary" :disabled="!!writeBlock || !dirty || busy" data-testid="hd-contact-save" @click="savePrivate">연락처 저장</button>
        <button v-if="hasRow" type="button" class="btn btn-danger" :disabled="!!writeBlock || busy" data-testid="hd-contact-erase" @click="erasePrivate">연락처 지우기</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hd { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line); max-width: 860px; }
.block { margin-bottom: 16px; }
.block h2 { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; font-size: 13px; }
.block h2 .muted { font-weight: 450; }
.clock { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 4px 0; }
.clock-name { width: 52px; font-weight: 600; }
.thread { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.msg { padding: 8px 10px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.msg-customer { background: var(--navy-50); }
.msg-note { background: var(--ink-50); border-style: dashed; }
.msg-head { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
.msg-body { margin: 0; white-space: pre-line; }
.compose { display: flex; flex-direction: column; gap: 6px; }
.compose textarea { width: 100%; resize: vertical; }
.note { margin-bottom: 8px; padding: 6px 8px; background: var(--navy-50); border-radius: var(--radius-sm); }
.grow { flex: 1 1 auto; }
.link-short { padding: 5px 8px; background: var(--ink-50); border-radius: var(--radius-sm); color: var(--text-2); }
</style>

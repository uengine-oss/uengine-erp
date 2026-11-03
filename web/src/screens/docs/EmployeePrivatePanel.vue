<script setup lang="ts">
// Contact details and the like. They live outside the ledger so they can be erased, which is why saving here is a step of
// its own and why this panel says what it keeps and what it cannot forget. Only hr and admin see it, and the database
// answers everyone else with nothing whether or not this panel is drawn.
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { messageOf, toApiError } from '../../lib/api'
import { sendCommand } from '../../lib/commands'
import { db } from '../../lib/conn'
import { eventLabel } from '../../lib/eventText'
import { deepEqual } from '../../lib/fields'
import { fmtDateTime } from '../../lib/format'
import { writeBlock } from '../../lib/mode'
import { hasRole, isAdmin } from '../../lib/session'
import type { CatalogDoc, ErpEvent, ErpRecord, Field, State } from '../../lib/types'
import { ask, toast } from '../../lib/ui'
import FieldInput from '../../components/FieldInput.vue'
import Icon from '../../components/Icon.vue'

const props = defineProps<{ record: ErpRecord | null; draft: State; doc: CatalogDoc; readonly: boolean }>()
const route = useRoute()

const allowed = computed(() => hasRole(['hr']))
const fields = computed<Field[]>(() => props.doc.private_fields ?? [])
const isNew = computed(() => !route.params.id)

const saved = ref<State>({})
const values = ref<State>({})
const hasRow = ref(false)
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const accountOpen = ref(false)
const log = ref<ErpEvent[]>([])
const labelOf = (name: string) => fields.value.find((f) => f.name === name)?.label ?? name

const empty = (): State => Object.fromEntries(fields.value.map((f) => [f.name, null]))
const canWrite = computed(() => !writeBlock.value)
const changed = computed<State>(() => Object.fromEntries(fields.value
  .filter((f) => !deepEqual(values.value[f.name] || null, saved.value[f.name] || null))
  .map((f) => [f.name, values.value[f.name] || null])))
const dirty = computed(() => Object.keys(changed.value).length > 0)

let seq = 0
async function load() {
  const id = props.record?.id
  if (!allowed.value || !id) return
  const my = ++seq
  loading.value = true
  error.value = ''
  try {
    const { data, error: err, status } = await db().from('erp_employee_private').select('*').eq('employee_id', id).maybeSingle()
    if (my !== seq) return
    if (err) throw toApiError(err, status)
    const next = empty()
    for (const f of fields.value) next[f.name] = data?.[f.name] ?? null
    saved.value = next
    values.value = { ...next }
    hasRow.value = !!data
    const trail = await db().from('erp_events').select('seq,event_type,actor_name,occurred_at,reason,data').eq('stream_type', 'employee_private').eq('data->>employee_id', id).order('seq', { ascending: false }).limit(5)
    if (my !== seq) return
    log.value = (trail.data ?? []) as ErpEvent[]
    await checkAccount(my)
  } catch (e) {
    if (my === seq) error.value = messageOf(e)
  } finally {
    if (my === seq) loading.value = false
  }
}
watch(() => props.record?.id, load, { immediate: true })

// Leaving does not close the account: a member is not part of what a rollback can undo, so the two stay separate steps.
async function checkAccount(my: number) {
  accountOpen.value = false
  const member = props.record?.state.member_id
  if (props.record?.status !== 'left' || !member) return
  const { data } = await db().from('erp_members').select('active').eq('record_id', member).maybeSingle()
  if (my === seq) accountOpen.value = !!data?.active
}
watch(() => props.record?.status, () => { void load() })

async function save() {
  if (!props.record || !dirty.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await sendCommand({ type: 'employee', id: props.record.id, command: 'set_private', payload: changed.value })
    toast('개인정보를 저장했습니다.')
    await load()
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}

async function erase() {
  if (!props.record || busy.value) return
  const answer = await ask({
    title: '개인정보 지우기',
    message: '이 직원의 개인정보를 모두 지웁니다. 되돌릴 수 없습니다.\n원장에는 지웠다는 사실과 사유, 처리한 사람만 남습니다. 이름과 입퇴사일은 원장에 남아 지워지지 않습니다.\n사유도 원장에 남으니 지우는 값이나 민감한 내용을 적지 마세요.',
    danger: true,
    reason: true,
    reasonRequired: true,
    confirmLabel: '지우기',
  })
  if (!answer) return
  busy.value = true
  error.value = ''
  try {
    await sendCommand({ type: 'employee', id: props.record.id, command: 'erase_private', payload: {}, reason: answer.reason })
    toast('개인정보를 지웠습니다.')
    await load()
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section v-if="allowed && !isNew" class="private no-print" data-testid="private-panel">
    <h2><Icon name="lock" :size="13" /> 개인정보 <span class="muted small">인사 담당자와 관리자만 봅니다</span></h2>
    <div v-if="accountOpen" class="banner banner-warn" role="status" data-testid="account-still-open">
      <Icon name="alert" /><span class="grow">이 직원의 ERP 계정이 아직 켜져 있습니다. 퇴사 처리는 계정을 막지 않습니다. 관리자가 구성원 화면에서 비활성화합니다.</span>
      <router-link v-if="isAdmin()" class="btn btn-sm" to="/settings/members" data-testid="account-open-members">구성원 화면으로</router-link>
    </div>
    <template v-if="record">
      <p class="note small" data-testid="private-note">
        이 칸들은 원장 밖에 따로 저장합니다. 이력에는 어느 칸이 바뀌었는지와 처리한 사람만 남고 값은 남지 않습니다. 그래서 지울 수 있지만, 지우면 되돌릴 수 없고 과거 값을 볼 수도 없습니다.
        이름, 사번, 부서, 직책, 상사, 입퇴사일은 과거 문서에 쓰이므로 원장에 남아 지워지지 않습니다. 주민등록번호는 받지 않으니 어느 칸에도 적지 마세요.
      </p>
      <p v-if="error" class="err-text small" role="alert" data-testid="private-error">{{ error }}</p>
      <div class="field-grid" @keydown.enter.prevent="save">
        <div v-for="f in fields" :key="f.name" class="field" :data-field="f.name">
          <label class="field-label" :for="`p-${f.name}`">{{ f.label }}</label>
          <div><FieldInput :id="`p-${f.name}`" :field="f" :disabled="!canWrite || loading" :model-value="values[f.name]" @update:model-value="values[f.name] = $event" /></div>
        </div>
      </div>
      <div class="actions">
        <button type="button" class="btn btn-primary" :disabled="!canWrite || !dirty || busy" data-testid="private-save" @click="save">{{ busy ? '저장 중…' : '개인정보 저장' }}</button>
        <button v-if="hasRow" type="button" class="btn btn-danger" :disabled="!canWrite || busy" data-testid="private-erase" @click="erase">개인정보 지우기</button>
      </div>
      <ul v-if="log.length" class="trail small dim" data-testid="private-log">
        <li v-for="e in log" :key="e.seq" data-testid="private-log-row">
          {{ fmtDateTime(e.occurred_at) }} {{ e.actor_name ?? '시스템' }} · {{ eventLabel(e.event_type) }}: {{ (e.data.fields ?? []).map(labelOf).join(', ') }}<template v-if="e.reason"> · 사유: {{ e.reason }}</template>
        </li>
      </ul>
    </template>
    <p v-else class="muted small" data-testid="private-past">개인정보는 원장에 없으므로 지난 시점의 값을 보여 줄 수 없습니다.</p>
  </section>
</template>

<style scoped>
.private { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line); }
.private h2 { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 13px; }
.private h2 .muted { font-weight: 450; }
.note { margin-bottom: 8px; padding: 6px 8px; background: var(--navy-50); border-radius: var(--radius-sm); }
.actions { display: flex; gap: 6px; margin-top: 8px; }
.trail { margin: 10px 0 0; padding: 0; list-style: none; }
</style>

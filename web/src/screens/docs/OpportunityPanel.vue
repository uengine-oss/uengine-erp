<script setup lang="ts">
// The contact person, who can ask to be forgotten, so saving here is a step of its own and the values never reach the ledger.
// Below it, the quotes this deal became: read-only, and empty when the sales module is off, since this module knows nothing of them.
import { computed, ref, watch } from 'vue'
import { messageOf, toApiError } from '../../lib/api'
import { onDataChanged, sendCommand } from '../../lib/commands'
import { db } from '../../lib/conn'
import { deepEqual } from '../../lib/fields'
import { writeBlock } from '../../lib/mode'
import { catalogOf, hasRole } from '../../lib/session'
import type { CatalogDoc, ErpRecord, Field, State } from '../../lib/types'
import { ask, toast } from '../../lib/ui'
import FieldInput from '../../components/FieldInput.vue'
import Icon from '../../components/Icon.vue'
import StatusPill from '../../components/StatusPill.vue'

const props = defineProps<{ record: ErpRecord | null; draft: State; doc: CatalogDoc; readonly: boolean }>()

const allowed = computed(() => hasRole(['sales']))
const fields = computed<Field[]>(() => props.doc.private_fields ?? [])
const saved = ref<State>({})
const values = ref<State>({})
const hasRow = ref(false)
const busy = ref(false)
const error = ref('')
const quotes = ref<ErpRecord[]>([])
const quoteDoc = computed(() => catalogOf('sales_order'))

const changed = computed<State>(() => Object.fromEntries(fields.value
  .filter((f) => !deepEqual(values.value[f.name] || null, saved.value[f.name] || null))
  .map((f) => [f.name, values.value[f.name] || null])))
const dirty = computed(() => Object.keys(changed.value).length > 0)

let seq = 0
async function load() {
  const id = props.record?.id
  if (!id) return
  const my = ++seq
  error.value = ''
  try {
    if (quoteDoc.value) {
      const q = await db().from('erp_records').select('id,type,name,status,version,state').eq('type', 'sales_order').eq('state->>origin_id', id).order('created_at')
      if (my === seq) quotes.value = (q.data ?? []) as ErpRecord[]
    }
    if (!allowed.value) return
    const { data, error: err, status } = await db().from('erp_opportunity_private').select('*').eq('opportunity_id', id).maybeSingle()
    if (my !== seq) return
    if (err) throw toApiError(err, status)
    const next: State = {}
    for (const f of fields.value) next[f.name] = data?.[f.name] ?? null
    saved.value = next
    values.value = { ...next }
    hasRow.value = !!data
  } catch (e) {
    if (my === seq) error.value = messageOf(e)
  }
}
watch(() => [props.record?.id, props.record?.version], load, { immediate: true })
// The quote is sales' work and arrives after the win, on no version of this document.
onDataChanged(() => { void load() })

async function save() {
  if (!props.record || !dirty.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await sendCommand({ type: 'opportunity', id: props.record.id, command: 'set_private', payload: changed.value })
    toast('연락처를 저장했습니다.')
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
    title: '연락처 지우기',
    message: '이 건의 연락처를 지웁니다. 되돌릴 수 없습니다.\n원장에는 지웠다는 사실과 사유, 처리한 사람만 남습니다. 사유에 지우는 값을 적지 마세요.',
    danger: true, reason: true, reasonRequired: true, confirmLabel: '지우기',
  })
  if (!answer) return
  busy.value = true
  error.value = ''
  try {
    await sendCommand({ type: 'opportunity', id: props.record.id, command: 'erase_private', payload: {}, reason: answer.reason })
    toast('연락처를 지웠습니다.')
    await load()
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section v-if="record" class="contact no-print" data-testid="opportunity-panel">
    <template v-if="allowed">
      <h2><Icon name="lock" :size="13" /> 연락처 <span class="muted small">영업 담당자와 관리자만 봅니다</span></h2>
      <p class="note small" data-testid="contact-note">사람이 지워 달라고 할 수 있는 값이라 원장 밖에 저장합니다. 이력에는 어느 칸이 바뀌었는지만 남고, 지우면 되돌릴 수 없습니다.</p>
      <p v-if="error" class="err-text small" role="alert" data-testid="contact-error">{{ error }}</p>
      <div class="field-grid" @keydown.enter.prevent="save">
        <div v-for="f in fields" :key="f.name" class="field" :data-field="`contact-${f.name}`">
          <label class="field-label" :for="`c-${f.name}`">{{ f.label }}</label>
          <div><FieldInput :id="`c-${f.name}`" :field="f" :disabled="!!writeBlock" :model-value="values[f.name]" @update:model-value="values[f.name] = $event" /></div>
        </div>
      </div>
      <div class="actions">
        <button type="button" class="btn btn-primary" :disabled="!!writeBlock || !dirty || busy" data-testid="contact-save" @click="save">{{ busy ? '저장 중…' : '연락처 저장' }}</button>
        <button v-if="hasRow" type="button" class="btn btn-danger" :disabled="!!writeBlock || busy" data-testid="contact-erase" @click="erase">연락처 지우기</button>
      </div>
    </template>
    <div v-if="quotes.length" class="quotes" data-testid="opportunity-quotes">
      <h2>이 건에서 나온 견적</h2>
      <ul>
        <li v-for="q in quotes" :key="q.id" data-testid="opportunity-quote">
          <router-link :to="{ name: 'record', params: { type: 'sales_order', id: q.id } }">{{ q.name }}</router-link>
          <StatusPill v-if="quoteDoc" :doc="quoteDoc" :value="q.status" />
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.contact { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line); }
.contact h2 { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 13px; }
.contact h2 .muted { font-weight: 450; }
.note { margin-bottom: 8px; padding: 6px 8px; background: var(--navy-50); border-radius: var(--radius-sm); }
.actions { display: flex; gap: 6px; margin-top: 8px; }
.quotes { margin-top: 12px; }
.quotes ul { margin: 0; padding: 0; list-style: none; }
.quotes li { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
</style>

<script setup lang="ts">
// Closing periods. The refusals (a hard lock moved back, drafts or bank lines still inside) are the database's.
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { onDataChanged, sendCommand } from '../../lib/commands'
import { fmtDateTime } from '../../lib/format'
import { useLoad } from '../../lib/load'
import { writeBlock } from '../../lib/mode'
import { ensureNames, refLabel } from '../../lib/refs'
import { catalogOf, isAdmin, loadCompany } from '../../lib/session'
import { COMPANY_ID, type State } from '../../lib/types'
import { ask, toast } from '../../lib/ui'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'
import LoadError from '../../components/LoadError.vue'

interface Status { lock_date_all: string | null; lock_date_tax: string | null; lock_date_sale: string | null; lock_date_purchase: string | null; lock_date_hard: string | null; effective: Record<string, string | null>; next_open: string | null; exceptions: { id: string; field: string; lock_date: string | null; member_id: string | null; reason: string; end_at: string; state: string }[] }
const KINDS = [{ key: 'all', field: 'lock_date_all', label: '전체 잠금일' }, { key: 'tax', field: 'lock_date_tax', label: '세금 잠금일' }, { key: 'sale', field: 'lock_date_sale', label: '판매 잠금일' }, { key: 'purchase', field: 'lock_date_purchase', label: '구매 잠금일' }, { key: 'hard', field: 'lock_date_hard', label: '되돌릴 수 없는 잠금일' }] as const
const STATE: Record<string, { label: string; color: string }> = { active: { label: '유효', color: 'green' }, expired: { label: '기간 끝남', color: 'gray' }, revoked: { label: '철회', color: 'gray' } }

const { data, loading, error, load } = useLoad(async () => {
  const s = await rpc<Status>('erp_lock_status')
  await ensureNames(s.exceptions.map((x) => x.member_id))
  return s
})
onMounted(load)
onDataChanged(() => { void load() })
const draft = reactive<Record<string, string>>({})
// This screen rereads when anything changes, and a date someone is still typing must survive that.
watch(data, (s, before) => {
  if (!s) return
  for (const k of KINDS) if ((draft[k.field] ?? '') === (before?.[k.field] ?? '')) draft[k.field] = s[k.field] ?? ''
})
const saveError = ref('')
const busy = ref(false)
const canEdit = computed(() => isAdmin() && !writeBlock.value)
const changes = computed(() => {
  const out: State = {}
  for (const k of KINDS) if ((draft[k.field] || null) !== (data.value?.[k.field] ?? null)) out[k.field] = draft[k.field] || null
  return out
})
const dirty = computed(() => Object.keys(changes.value).length > 0)
const docOf = computed(() => catalogOf('company'))
const helpOf = (field: string) => docOf.value?.fields.find((f) => f.name === field)?.help

async function save() {
  saveError.value = ''
  let reason: string | null = null
  if ('lock_date_hard' in changes.value) {
    const answer = await ask({ title: '되돌릴 수 없는 잠금일', message: `${changes.value.lock_date_hard} 까지를 영구히 닫습니다. 넣은 뒤에는 앞당기거나 지울 수 없습니다.`, danger: true, reason: true, confirmLabel: '닫기' })
    if (!answer) return
    reason = answer.reason || null
  }
  busy.value = true
  try {
    await sendCommand({ type: 'company', id: COMPANY_ID, command: 'update', payload: changes.value, reason })
    await Promise.all([loadCompany(), load()])
    toast('저장했습니다.')
  } catch (e) {
    saveError.value = messageOf(e)
  } finally {
    busy.value = false
  }
}
async function grant() {
  const doc = catalogOf('lock_exception')
  if (!doc) return
  let values: State = {}
  let err = ''
  for (;;) {
    const answer = await ask({ title: '잠금 예외 주기', message: '정한 기간 동안만 잠금을 풉니다. 누가 왜 받았는지 이력에 남습니다.', error: err, values, fields: doc.fields.filter((f) => !f.readonly), confirmLabel: '주기', wide: true })
    if (!answer) return
    values = answer.values
    try {
      await sendCommand({ type: 'lock_exception', command: 'create', payload: values })
      toast('예외를 주었습니다.')
      await load()
      return
    } catch (e) {
      err = messageOf(e)
    }
  }
}
async function revoke(id: string) {
  const answer = await ask({ title: '예외 철회', message: '지금부터 다시 잠금일이 적용됩니다.', danger: true, confirmLabel: '철회' })
  if (!answer) return
  try {
    await sendCommand({ type: 'lock_exception', id, command: 'revoke' })
    await load()
  } catch (e) {
    toast(messageOf(e), 'error')
  }
}
</script>

<template>
  <div class="page" data-testid="locks">
    <div class="page-head">
      <h1>마감 잠금</h1>
      <div class="grow"></div>
      <button v-if="canEdit" type="button" class="btn btn-primary" :disabled="!dirty || busy" data-testid="locks-save" @click="save">저장</button>
    </div>
    <div v-if="saveError" class="banner banner-error banner-flush" role="alert" data-testid="locks-error"><Icon name="alert" /><span class="grow">{{ saveError }}</span></div>
    <LoadError :message="error" @retry="load" />
    <div v-if="data" class="page-body report-pad">
      <div class="settings-col">
        <p class="dim" data-testid="locks-next-open"><template v-if="data.next_open">문서 날짜는 <strong>{{ data.next_open }}</strong> 부터 쓸 수 있습니다.</template><template v-else>닫힌 기간이 없습니다.</template></p>
        <section class="section">
          <div v-for="k in KINDS" :key="k.key" class="field lock-row" :data-field="k.field">
            <label class="field-label" :for="`lock-${k.key}`">{{ k.label }}</label>
            <div>
              <input :id="`lock-${k.key}`" v-model="draft[k.field]" class="input" type="date" style="width: 160px" :disabled="!canEdit" :data-testid="`lock-${k.key}`" />
              <div class="hint">{{ helpOf(k.field) }}<template v-if="data.effective[k.key] && data.effective[k.key] !== data[k.field]"> · 나에게는 {{ data.effective[k.key] }} 까지 적용</template></div>
            </div>
          </div>
        </section>
        <section class="section">
          <div class="row" style="justify-content: space-between; margin-bottom: 6px"><h2>잠금 예외</h2><button v-if="canEdit" type="button" class="btn btn-sm" data-testid="exception-new" @click="grant"><Icon name="plus" :size="12" />예외 주기</button></div>
          <div class="scroll-x">
            <table v-if="data.exceptions.length" class="tbl" data-testid="exceptions-table">
              <thead><tr><th>대상</th><th>예외 동안의 잠금일</th><th>구성원</th><th>사유</th><th>끝나는 때</th><th>상태</th><th v-if="canEdit"></th></tr></thead>
              <tbody>
                <tr v-for="x in data.exceptions" :key="x.id" data-testid="exception-row">
                  <td>{{ KINDS.find((k) => k.key === x.field)?.label ?? x.field }}</td><td>{{ x.lock_date ?? '잠금 없음' }}</td><td>{{ x.member_id ? refLabel(x.member_id) : '모든 구성원' }}</td><td class="wrap">{{ x.reason }}</td><td>{{ fmtDateTime(x.end_at).slice(0, 16) }}</td>
                  <td><span class="pill" :class="`pill-${STATE[x.state]?.color ?? 'gray'}`" data-testid="exception-state">{{ STATE[x.state]?.label ?? x.state }}</span></td>
                  <td v-if="canEdit" class="num"><button v-if="x.state === 'active'" type="button" class="btn btn-sm" data-testid="exception-revoke" @click="revoke(x.id)">철회</button></td>
                </tr>
              </tbody>
            </table>
            <p v-else class="muted small">준 예외가 없습니다.</p>
          </div>
        </section>
      </div>
    </div>
    <EmptyState v-else-if="!loading && !error" title="읽지 못했습니다" />
  </div>
</template>

<style scoped>
.settings-col { max-width: 760px; }
.lock-row { margin-bottom: 8px; grid-template-columns: 160px minmax(0, 1fr); }
</style>

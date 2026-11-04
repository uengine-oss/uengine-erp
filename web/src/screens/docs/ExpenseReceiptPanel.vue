<script setup lang="ts">
// Receipts. The file goes to the company's own storage, its name to a table outside the ledger, and only its fingerprint into
// the ledger, so a file can be erased and an approved claim can still prove which file it was approved on. The database decides
// who may read: whoever cannot read the claim never reaches this panel. The same people can erase what was typed on the claim.
import { computed, ref, watch } from 'vue'
import { messageOf, toApiError } from '../../lib/api'
import { sendCommand } from '../../lib/commands'
import { db } from '../../lib/conn'
import { newId } from '../../lib/fields'
import { writeBlock } from '../../lib/mode'
import { hasRole, session } from '../../lib/session'
import type { CatalogDoc, ErpRecord, State } from '../../lib/types'
import { ask, toast } from '../../lib/ui'
import Icon from '../../components/Icon.vue'

const props = defineProps<{ record: ErpRecord | null; draft: State; doc: CatalogDoc; readonly: boolean }>()

interface Receipt { id: string; path: string; file_name: string; mime: string; size: number }
const BUCKET = 'erp-receipts'
const ACCEPT = '.jpg,.jpeg,.png,.webp,.heic,.pdf,image/jpeg,image/png,image/webp,image/heic,application/pdf'

const rows = ref<Receipt[]>([])
const busy = ref(false)
const error = ref('')
const picker = ref<HTMLInputElement | null>(null)
const state = computed(() => props.record?.state)
const status = computed(() => props.record?.status ?? '')
const editable = computed(() => ['draft', 'refused'].includes(status.value))
const mine = computed(() => !!session.me && [state.value?.employee_user_id, state.value?.filed_by_user_id].includes(session.me.user_id))
const office = computed(() => hasRole(['accounting']))
const canAdd = computed(() => !writeBlock.value && editable.value && (mine.value || office.value))
const canRemove = computed(() => !writeBlock.value && (editable.value ? (mine.value || office.value) : office.value))
const canErase = computed(() => !writeBlock.value && !!props.record && (mine.value || office.value))
const hasWords = computed(() => ['title', 'note', 'no_receipt_reason', 'refused_reason', 'cancel_reason', 'removal_reason', 'undo_reason'].some((k) => !!props.draft?.[k]))
const twins = computed<string[]>(() => state.value?.possible_duplicates ?? [])

let seq = 0
async function load() {
  const id = props.record?.id
  if (!id) { rows.value = []; return }
  const my = ++seq
  const { data, error: err, status: code } = await db().from('erp_expense_receipts').select('id,path,file_name,mime,size').eq('expense_id', id).order('uploaded_at')
  if (my !== seq) return
  if (err) { error.value = messageOf(toApiError(err, code)); return }
  rows.value = (data ?? []) as Receipt[]
}
watch(() => [props.record?.id, props.record?.version], load, { immediate: true })

async function fingerprint(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

const storageError = (m: string) => (/bucket not found/i.test(m) ? '이 프로젝트에 영수증 저장소가 없습니다. 설치 SQL 을 다시 실행하세요.'
  : /exceed|too large|payload/i.test(m) ? '영수증 파일은 10 MB 까지입니다.'
    : /mime|type/i.test(m) ? '영수증은 JPG, PNG, WEBP, HEIC, PDF 만 받습니다.'
      : `파일을 올리지 못했습니다: ${m}`)

async function upload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !props.record || busy.value) return
  busy.value = true
  error.value = ''
  const expense = props.record.id
  const id = newId()
  const path = `expense/${expense}/${id}`
  try {
    const sha256 = await fingerprint(file)
    const put = await db().storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false })
    if (put.error) { error.value = storageError(put.error.message); return }
    try {
      await sendCommand({ type: 'expense', id: expense, command: 'attach_receipt', payload: { id, sha256, mime: file.type, size: file.size, file_name: file.name } })
    } catch (e) {
      // Refused: nothing refers to the file, so it does not stay behind.
      await db().storage.from(BUCKET).remove([path])
      throw e
    }
    toast('영수증을 첨부했습니다.')
    await load()
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}

async function open(r: Receipt) {
  error.value = ''
  const { data, error: err } = await db().storage.from(BUCKET).createSignedUrl(r.path, 60)
  if (err || !data) { error.value = storageError(err?.message ?? ''); return }
  window.open(data.signedUrl, '_blank', 'noopener')
}

async function remove(r: Receipt) {
  if (busy.value || !props.record) return
  const evidence = !editable.value
  const answer = await ask({
    title: '영수증 지우기',
    message: evidence ? '신청한 경비의 증빙을 지웁니다. 파일은 되돌릴 수 없습니다. 원장에는 지웠다는 사실과 파일 지문이 남고, 사유는 원장 밖에 둡니다.' : `${r.file_name} 을 지웁니다.`,
    danger: true,
    reason: evidence,
    reasonRequired: evidence,
    confirmLabel: '지우기',
  })
  if (!answer) return
  busy.value = true
  error.value = ''
  try {
    await sendCommand({ type: 'expense', id: props.record.id, command: 'remove_receipt', payload: { id: r.id }, reason: answer.reason || null })
    const gone = await db().storage.from(BUCKET).remove([r.path])
    if (gone.error) error.value = storageError(gone.error.message)
    else toast('영수증을 지웠습니다.')
    await load()
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}

async function eraseWords() {
  if (busy.value || !props.record) return
  const answer = await ask({
    title: '적요와 메모 지우기',
    message: '이 경비에 적은 적요, 메모, 사유를 지웁니다. 되돌릴 수 없습니다. 금액과 날짜, 원장의 기록은 그대로 남습니다.',
    danger: true,
    confirmLabel: '지우기',
  })
  if (!answer) return
  busy.value = true
  error.value = ''
  try {
    await sendCommand({ type: 'expense', id: props.record.id, command: 'erase_private', payload: {} })
    toast('적요와 메모를 지웠습니다.')
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}

const sizeText = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
</script>

<template>
  <section class="receipts no-print" data-testid="receipt-panel">
    <h2><Icon name="lock" :size="13" /> 영수증 <span class="muted small">이 경비는 신청한 사람, 승인자, 대신 올린 사람, 회계 담당자만 봅니다</span></h2>
    <p v-if="!record" class="muted small" data-testid="receipt-new">저장한 뒤 첨부합니다.</p>
    <template v-else>
      <div v-if="twins.length" class="banner banner-warn" role="status" data-testid="receipt-twins"><Icon name="alert" /><span class="grow">같은 사람, 같은 날, 같은 금액의 경비가 있습니다: {{ twins.join(', ') }}</span></div>
      <p class="note small" data-testid="receipt-note">파일과 파일 이름, 적요와 메모는 원장 밖에 두어 지울 수 있습니다. 원장에는 파일 지문과 크기만 남으니, 승인한 뒤 파일이 바뀌면 알 수 있습니다. 금액은 장부를 다시 만드는 데 필요해 원장에 남지만 위의 사람들만 읽습니다.</p>
      <p v-if="error" class="err-text small" role="alert" data-testid="receipt-error">{{ error }}</p>
      <ul v-if="rows.length" class="list" data-testid="receipt-list">
        <li v-for="r in rows" :key="r.id" data-testid="receipt-row">
          <button type="button" class="linklike ellipsis" data-testid="receipt-open" @click="open(r)">{{ r.file_name }}</button>
          <span class="muted small nowrap">{{ sizeText(r.size) }}</span>
          <button v-if="canRemove" type="button" class="btn btn-sm btn-icon" aria-label="영수증 지우기" :disabled="busy" data-testid="receipt-remove" @click="remove(r)"><Icon name="trash" :size="13" /></button>
        </li>
      </ul>
      <p v-else class="muted small" data-testid="receipt-empty">첨부한 영수증이 없습니다.</p>
      <div v-if="canAdd" class="actions">
        <input ref="picker" class="hidden-file" type="file" :accept="ACCEPT" data-testid="receipt-file" @change="upload" />
        <button type="button" class="btn" :disabled="busy" data-testid="receipt-add" @click="picker?.click()"><Icon name="plus" :size="13" />{{ busy ? '올리는 중…' : '영수증 첨부' }}</button>
        <span class="muted small">JPG, PNG, WEBP, HEIC, PDF · 10 MB 까지</span>
      </div>
      <div v-if="canErase && hasWords" class="actions erase">
        <button type="button" class="btn btn-danger" :disabled="busy" data-testid="words-erase" @click="eraseWords">적요와 메모 지우기</button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.receipts { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line); }
.receipts h2 { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 13px; }
.receipts h2 .muted { font-weight: 450; }
.note { margin-bottom: 8px; padding: 6px 8px; background: var(--navy-50); border-radius: var(--radius-sm); }
.list { margin: 0 0 8px; padding: 0; list-style: none; }
.list li { display: flex; align-items: center; gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--line); }
.linklike { flex: 1 1 auto; min-width: 0; text-align: left; background: none; border: 0; padding: 0; color: var(--accent, inherit); cursor: pointer; text-decoration: underline; }
.actions { display: flex; align-items: center; gap: 8px; }
.erase { margin-top: 8px; }
.hidden-file { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; }
</style>

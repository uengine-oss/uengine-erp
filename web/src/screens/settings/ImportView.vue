<script setup lang="ts">
// A spreadsheet into the database, one step at a time: pick the type, match the columns, try it, write it. Every row runs
// the command a screen would send, so the file can say nothing a person could not.
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { messageOf, rpc } from '../../lib/api'
import { nudgeBus } from '../../lib/commands'
import { canCommand, newId } from '../../lib/fields'
import { writeBlock } from '../../lib/mode'
import { openRollback } from '../../lib/rollback'
import { catalogOf, session, isAdmin } from '../../lib/session'
import { readSheet, type Sheet } from '../../lib/spreadsheet'
import { refLabel, ensureNames } from '../../lib/refs'
import type { State } from '../../lib/types'
import { csvBlob, saveBlob, toast } from '../../lib/ui'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'

interface Column { field: string; label: string; type: string; required?: boolean; ref?: string; options?: { value: string; label: string }[]; help?: string }
interface Template { type: string; label: string; key: string[]; columns: Column[] }
interface RowResult { row: number; status: 'created' | 'updated' | 'skipped' | 'error'; id?: string; code?: string; message?: string }
interface BatchResult { written: boolean; correlation_id: string | null; total: number; processed: number; next: number | null; created: number; updated: number; skipped: number; failed: number; rows: RowResult[] }

const BATCH = 1000
const IN = '__in'
const OUT = '__out'
const route = useRoute()

const types = computed(() => {
  const list = session.catalog.filter((c) => c.module !== 'settings' && !c.hidden && canCommand(c, 'create')).map((c) => ({ value: c.type, label: c.label }))
  if (catalogOf('purchase_order')) list.push({ value: 'vendor_price', label: '공급사 가격표' })
  return list
})
const type = ref(String(route.query.type ?? ''))
const template = ref<Template | null>(null)
const sheet = ref<Sheet | null>(null)
const fileName = ref('')
const columns = reactive<Record<string, string>>({})
const keyField = ref('')
const existing = ref<'' | 'update' | 'skip'>('')
const keepGood = ref(false)
const error = ref('')
const busy = ref(false)
const progress = ref(0)
const phase = ref<'' | 'dry_run' | 'commit'>('')
const fixed = reactive<Record<string, string>>({})
const result = reactive({ created: 0, updated: 0, skipped: 0, failed: 0, processed: 0, written: 0, correlation: '' as string, stopped: false, errors: [] as RowResult[] })

const isBank = computed(() => type.value === 'bank_line')
// A bank file's journal is one choice for the whole file, not a column of it.
const FIXED_FIELDS = computed<Column[]>(() => (isBank.value ? (template.value?.columns ?? []).filter((c) => ['journal_id', 'statement_id'].includes(c.field)) : []))
const targetColumns = computed(() => (template.value?.columns ?? []).filter((c) => !FIXED_FIELDS.value.some((f) => f.field === c.field)))
const missing = computed(() => {
  const mapped = new Set(Object.values(columns))
  if (mapped.has(IN) || mapped.has(OUT)) mapped.add('amount')
  return targetColumns.value.filter((c) => c.required && !mapped.has(c.field)).map((c) => c.label)
})
// Many required fields have a default in the database, so a missing column is a remark. The trial run judges each row.
const canRun = computed(() => !!sheet.value && !!sheet.value.rows.length && !writeBlock.value && !busy.value && (!isBank.value || !!fixed.journal_id))

async function loadTemplate() {
  template.value = null
  sheet.value = null
  resetResult()
  if (!type.value) return
  try {
    template.value = await rpc<Template>('erp_import_template', { p_type: type.value })
    if (isBank.value) {
      fixed.journal_id = String(route.query.journal_id ?? '')
      fixed.statement_id = String(route.query.statement_id ?? '')
      await ensureNames([fixed.journal_id, fixed.statement_id])
    }
  } catch (e) {
    error.value = messageOf(e)
  }
}
watch(type, loadTemplate)
onMounted(() => { if (type.value) void loadTemplate() })

function resetResult() {
  Object.assign(result, { created: 0, updated: 0, skipped: 0, failed: 0, processed: 0, written: 0, correlation: '', stopped: false, errors: [] })
  phase.value = ''
  progress.value = 0
}

/** A header that says a column's name or label is that column. The rest wait for the person. */
function guess(header: string): string {
  const h = header.trim().toLowerCase()
  const hit = targetColumns.value.find((c) => c.field.toLowerCase() === h || c.label.toLowerCase() === h)
  if (hit) return hit.field
  if (isBank.value && /입금|받은|credit|deposit/i.test(header)) return IN
  if (isBank.value && /출금|지급|보낸|debit|withdraw/i.test(header)) return OUT
  return ''
}
async function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  error.value = ''
  resetResult()
  try {
    const s = await readSheet(file)
    if (!s.rows.length) { error.value = '파일에 머리글 밖의 행이 없습니다.'; return }
    sheet.value = s
    fileName.value = file.name
    for (const k of Object.keys(columns)) delete columns[k]
    for (const h of s.headers) columns[h] = guess(h)
  } catch {
    error.value = '파일을 읽지 못했습니다. CSV 또는 XLSX 인지 확인하세요.'
  }
}
function downloadTemplate() {
  if (!template.value) return
  saveBlob(csvBlob(targetColumns.value.map((c) => c.label), []), `${template.value.label}_양식.csv`)
}

// null means the cell has something in it that is not a number.
const toNumber = (s: unknown): number | null => {
  const text = String(s ?? '').replace(/[,\s원₩]/g, '')
  if (text === '') return 0
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}
/** Banks print money in and out as two columns and give no id, so both are worked out from the row as it stands. */
function rowsToSend(): State[] {
  const inCol = Object.keys(columns).find((h) => columns[h] === IN)
  const outCol = Object.keys(columns).find((h) => columns[h] === OUT)
  const seen = new Map<string, number>()
  return (sheet.value?.rows ?? []).map((r) => {
    const row: State = { ...r }
    if (inCol || outCol) {
      const money = toNumber(inCol ? r[inCol] : 0)
      const spent = toNumber(outCol ? r[outCol] : 0)
      // A cell that does not parse has to come back as an error on its row, not become a line with no money in it.
      row.amount = money === null ? String(r[inCol!]) : spent === null ? String(r[outCol!]) : money - spent
      if (inCol) delete row[inCol]
      if (outCol) delete row[outCol]
    }
    if (isBank.value) {
      for (const f of FIXED_FIELDS.value) if (fixed[f.field]) row[f.field] = fixed[f.field]
      const dateCol = Object.keys(columns).find((h) => columns[h] === 'date') ?? 'date'
      const refCol = Object.keys(columns).find((h) => columns[h] === 'payment_ref') ?? 'payment_ref'
      const amountCol = Object.keys(columns).find((h) => columns[h] === 'amount') ?? 'amount'
      const base = `${r[dateCol] ?? ''}|${row.amount ?? r[amountCol] ?? ''}|${r[refCol] ?? ''}`
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      // The same file twice must not make the same lines twice: two equal lines on one day stay two, in file order.
      if (!Object.values(columns).includes('import_id')) row.import_id = `${base}|${n}`
    }
    return row
  })
}
function options(): State {
  const map: State = {}
  for (const [h, f] of Object.entries(columns)) map[h] = f && f !== IN && f !== OUT ? f : null
  const out: State = { columns: map }
  if (keyField.value) out.key = [keyField.value]
  if (existing.value) out.existing = existing.value
  return out
}

async function run(mode: 'dry_run' | 'commit') {
  error.value = ''
  resetResult()
  phase.value = mode
  busy.value = true
  const all = rowsToSend()
  const corr = newId()
  const base = { ...options(), keep_good: keepGood.value, correlation_id: corr }
  try {
    for (let at = 0; at < all.length; at += BATCH) {
      const chunk = all.slice(at, at + BATCH)
      let start = 0
      for (;;) {
        const r = await rpc<BatchResult>('erp_import', { p_type: type.value, p_rows: chunk, p_mode: mode, p_options: { ...base, start } })
        result.created += r.created
        result.updated += r.updated
        result.skipped += r.skipped
        result.failed += r.failed
        result.processed += r.processed
        progress.value = at + start + r.processed
        result.errors.push(...r.rows.filter((x) => x.status === 'error').map((x) => ({ ...x, row: x.row + at })))
        if (mode === 'commit' && r.written) { result.written += r.created + r.updated; result.correlation = corr }
        if (mode === 'commit' && !r.written) { result.stopped = true; return }
        if (r.next === null || r.next === undefined) break
        start = r.next
      }
    }
    if (mode === 'commit') {
      nudgeBus()
      toast(`${result.written.toLocaleString('ko-KR')}행을 썼습니다.`)
    }
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}
async function undo() {
  if (result.correlation) await openRollback('correlation', { correlation_id: result.correlation }, '이 가져오기 되돌리기', `방금 쓴 ${result.written}행을 되돌립니다.`)
}
const rowNo = (r: RowResult) => r.row + 2
const preview = computed(() => sheet.value?.rows.slice(0, 5) ?? [])
const unmapped = computed(() => (sheet.value?.headers ?? []).filter((h) => !columns[h]))
const fixedLabel = (id: string) => (id ? refLabel(id) : '')
const bankChoice = ref<State[]>([])
watch(isBank, async (on) => {
  if (!on) return
  const { db } = await import('../../lib/conn')
  const { data } = await db().from('erp_records').select('id,name').eq('type', 'journal').eq('active', true).in('state->>journal_type', ['bank', 'cash', 'credit']).order('name')
  bankChoice.value = data ?? []
}, { immediate: true })
</script>

<template>
  <div class="page" data-testid="import">
    <div class="page-head">
      <h1>표 파일 가져오기</h1>
      <div class="grow"></div>
      <button v-if="template" type="button" class="btn" data-testid="import-template" @click="downloadTemplate"><Icon name="download" :size="13" />양식 내려받기</button>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert" data-testid="import-error"><Icon name="alert" /><span class="grow">{{ error }}</span></div>
    <div class="page-body report-pad">
      <div class="stack import-col">
        <section class="report-section">
          <h2>1. 무엇을 가져오나요</h2>
          <div class="row-wrap">
            <select v-model="type" class="select" style="width: 200px" aria-label="가져올 유형" data-testid="import-type"><option value="">유형을 고르세요</option><option v-for="t in types" :key="t.value" :value="t.value">{{ t.label }}</option></select>
            <input v-if="template" class="input" style="width: 280px" type="file" accept=".csv,.tsv,.txt,.xlsx" aria-label="파일" data-testid="import-file" @change="onFile" />
          </div>
          <p class="hint" style="margin-top: 4px">CSV 와 XLSX 를 읽습니다. XLSX 는 첫 번째 시트만 읽고 수식은 저장된 값으로 읽습니다. 파일은 이 브라우저 안에서 읽습니다.</p>
          <div v-if="isBank" class="row-wrap" style="margin-top: 6px">
            <label class="field-inline">분개장 <select v-model="fixed.journal_id" class="select" style="width: 180px" data-testid="import-journal"><option value="">선택</option><option v-for="j in bankChoice" :key="j.id" :value="j.id">{{ j.name }}</option></select></label>
            <span v-if="fixed.statement_id" class="small dim">명세서 {{ fixedLabel(fixed.statement_id) }} 에 넣습니다</span>
          </div>
        </section>

        <section v-if="sheet" class="report-section" data-testid="import-mapping">
          <h2>2. 열 맞추기 <span class="muted small">{{ fileName }} · {{ sheet.rows.length.toLocaleString('ko-KR') }}행</span></h2>
          <div class="scroll-x">
            <table class="tbl">
              <thead><tr><th>파일의 열</th><th>예시</th><th style="width: 220px">넣을 항목</th></tr></thead>
              <tbody>
                <tr v-for="h in sheet.headers" :key="h" data-testid="import-column" :data-header="h">
                  <td>{{ h }}</td><td class="muted">{{ preview[0]?.[h] }}</td>
                  <td><select v-model="columns[h]" class="select" :aria-label="`${h} 을 넣을 항목`" data-testid="import-target"><option value="">가져오지 않음</option><option v-if="isBank" :value="IN">입금 (금액에 더함)</option><option v-if="isBank" :value="OUT">출금 (금액에서 뺌)</option><option v-for="c in targetColumns" :key="c.field" :value="c.field">{{ c.label }}{{ c.required ? ' *' : '' }}</option></select></td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="missing.length" class="hint" style="margin-top: 4px" data-testid="import-missing">맞춘 열이 없는 필수 항목: {{ missing.join(', ') }}. 기본값이 없으면 시험 실행에서 행마다 알려 줍니다.</p>
          <p v-if="unmapped.length" class="muted small" style="margin-top: 4px">가져오지 않을 열: {{ unmapped.join(', ') }}</p>
          <div class="row-wrap" style="margin-top: 8px">
            <label class="field-inline">이미 있는 행을 찾는 기준
              <select v-model="keyField" class="select" style="width: 160px" data-testid="import-key"><option value="">{{ template?.key?.length ? template.key.map((k) => template?.columns.find((c) => c.field === k)?.label ?? k).join(' + ') : '찾지 않음' }}</option><option v-for="c in targetColumns" :key="c.field" :value="c.field">{{ c.label }}</option></select>
            </label>
            <label class="field-inline">찾으면
              <select v-model="existing" class="select" style="width: 120px" data-testid="import-existing"><option value="">기본</option><option value="update">고치기</option><option value="skip">건너뛰기</option></select>
            </label>
          </div>
        </section>

        <section v-if="sheet" class="report-section" data-testid="import-run">
          <h2>3. 시험하고 쓰기</h2>
          <div class="row-wrap">
            <button type="button" class="btn btn-primary" :disabled="!canRun" data-testid="import-dry-run" @click="run('dry_run')">시험 실행</button>
            <button type="button" class="btn" :disabled="!canRun || !phase || (phase === 'dry_run' && result.failed > 0 && !keepGood)" data-testid="import-commit" @click="run('commit')">쓰기</button>
            <label class="check small dim"><input v-model="keepGood" type="checkbox" data-testid="import-keep-good" />틀린 행만 빼고 쓰기</label>
            <span v-if="busy" class="waiting" data-testid="import-progress"><span class="spin"></span>{{ progress.toLocaleString('ko-KR') }} / {{ sheet.rows.length.toLocaleString('ko-KR') }}행</span>
          </div>
          <p class="hint" style="margin-top: 4px">1000행씩 나누어 보냅니다. 틀린 행이 있는 묶음은 통째로 쓰지 않으며, 앞 묶음은 이미 쓰인 채로 멈춥니다.</p>
          <div v-if="phase && !busy" class="stat-row" style="margin-top: 8px" data-testid="import-summary" :data-phase="phase">
            <div class="stat"><span class="stat-label">{{ phase === 'dry_run' ? '새로 만들 행' : '새로 만든 행' }}</span><span class="stat-value" data-testid="import-created">{{ result.created }}</span></div>
            <div class="stat"><span class="stat-label">{{ phase === 'dry_run' ? '고칠 행' : '고친 행' }}</span><span class="stat-value" data-testid="import-updated">{{ result.updated }}</span></div>
            <div class="stat"><span class="stat-label">건너뛸 행</span><span class="stat-value" data-testid="import-skipped">{{ result.skipped }}</span></div>
            <div class="stat" :class="{ 'stat-bad': result.failed }"><span class="stat-label">틀린 행</span><span class="stat-value" data-testid="import-failed">{{ result.failed }}</span></div>
          </div>
          <div v-if="phase === 'dry_run' && !busy && !error && !result.failed" class="banner banner-ok" style="margin-top: 8px" data-testid="import-dry-ok"><Icon name="check" /><span>모두 쓸 수 있습니다. 아직 아무것도 쓰지 않았습니다.</span></div>
          <div v-if="phase === 'commit' && !busy && result.stopped" class="banner banner-warn" style="margin-top: 8px" role="alert" data-testid="import-stopped"><Icon name="alert" /><span>틀린 행이 있는 묶음에서 멈췄습니다. 쓰인 행 {{ result.written }}개. 고친 뒤 같은 파일을 다시 올리세요.</span></div>
          <div v-if="phase === 'commit' && !busy && result.written && !result.stopped" class="banner banner-ok" style="margin-top: 8px" data-testid="import-done"><Icon name="check" /><span class="grow">{{ result.written.toLocaleString('ko-KR') }}행을 썼습니다.</span><button v-if="isAdmin()" type="button" class="btn btn-sm" data-testid="import-undo" @click="undo">되돌리기</button></div>
          <div v-if="result.errors.length" class="scroll-x" style="margin-top: 8px">
            <table class="tbl" data-testid="import-errors">
              <thead><tr><th class="num" style="width: 70px">파일 행</th><th>문제</th></tr></thead>
              <tbody><tr v-for="r in result.errors.slice(0, 500)" :key="r.row" data-testid="import-error-row" :data-row="rowNo(r)"><td class="num">{{ rowNo(r) }}</td><td class="wrap">{{ r.message }}</td></tr></tbody>
            </table>
            <p v-if="result.errors.length > 500" class="muted small">앞의 500건만 보입니다.</p>
          </div>
        </section>
        <EmptyState v-if="!type" title="가져올 유형을 고르세요" text="연락처, 제품, 은행 거래 같은 것을 표 파일로 한 번에 넣습니다. 쓰기 전에 시험 실행으로 행마다 확인합니다." />
      </div>
    </div>
  </div>
</template>

<style scoped>
.import-col { max-width: 860px; }
</style>

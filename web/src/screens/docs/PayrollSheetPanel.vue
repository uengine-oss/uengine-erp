<script setup lang="ts">
// The register itself. One person's amounts live outside the ledger, so they are read and written here rather than through
// the form above. The database does every sum; a person's change is marked and stays through a recalculation.
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { messageOf, rpc } from '../../lib/api'
import { sendCommand } from '../../lib/commands'
import { fmtMoney } from '../../lib/format'
import { rows as readRows } from '../../lib/load'
import { writeBlock } from '../../lib/mode'
import { db } from '../../lib/conn'
import { hasRole } from '../../lib/session'
import type { CatalogDoc, ErpRecord, Field, State } from '../../lib/types'
import { ask, saveBlob, toast } from '../../lib/ui'
import Icon from '../../components/Icon.vue'
import { CELL_LABEL, NOTE_LABEL, transferFile, type BankFormat } from '../payroll/payroll'

interface Slip extends State { employee_id: string; name: string; employee_no: string; edited: string[]; notes: { code: string; item?: string; fields?: string[] }[] }
interface Sheet { run: State; slips: Slip[]; totals: State; data: { rates: State | null; tax_table: State | null } }

const props = defineProps<{ record: ErpRecord | null; draft: State; doc: CatalogDoc; readonly: boolean }>()
const router = useRouter()
const route = useRoute()

const allowed = computed(() => hasRole(['hr', 'payroll']))
const sheet = ref<Sheet | null>(null)
const error = ref('')
const busy = ref(false)
const formats = ref<BankFormat[]>([])
const formatId = ref('')
const state = computed(() => props.record?.status ?? '')
const isDraft = computed(() => state.value === 'draft')
const isConfirmed = computed(() => state.value === 'posted' || state.value === 'paid')
const canWrite = computed(() => allowed.value && !writeBlock.value)
const isReversal = computed(() => !!props.record?.state.reversal_of)

let seq = 0
async function load() {
  const id = props.record?.id
  if (!allowed.value || !id) return
  const my = ++seq
  error.value = ''
  try {
    const res = await rpc<Sheet>('erp_payroll_sheet', { p_run: id })
    if (my === seq) sheet.value = res
  } catch (e) {
    if (my === seq) error.value = messageOf(e)
  }
}
watch(() => [props.record?.id, props.record?.version], load, { immediate: true })

async function loadFormats() {
  if (!allowed.value || !isConfirmed.value) return
  try {
    const list = await readRows<{ id: string; name: string; state: State }>(db().from('erp_records').select('id,name,state').eq('type', 'payroll_bank_format').eq('active', true).order('name'))
    formats.value = list.map((f) => ({ id: f.id, name: f.name, delimiter: f.state.delimiter, with_header: f.state.with_header, columns: f.state.columns ?? [] }))
    if (!formats.value.some((f) => f.id === formatId.value)) formatId.value = formats.value[0]?.id ?? ''
  } catch (e) {
    error.value = messageOf(e)
  }
}
watch(() => state.value, loadFormats, { immediate: true })

async function act(run: () => Promise<unknown>, done?: string) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await run()
    if (done) toast(done)
    await load()
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}

const recalc = () => act(() => sendCommand({ type: 'payroll_run', id: props.record!.id, command: 'recalc' }), '다시 계산했습니다.')

function isEdited(s: Slip, cell: string) { return s.edited?.includes(cell) }

const STATUTORY = ['income_tax', 'local_tax', 'pension', 'health', 'ltc', 'employment']

async function editSlip(s: Slip) {
  if (!isDraft.value || !canWrite.value) return
  const earnings = (s.earnings as State[]) ?? []
  const others = (s.other_deductions as State[]) ?? []
  const fields: Field[] = [
    ...earnings.filter((e) => e.calc !== 'overtime_hours').map((e) => ({ name: `earning:${e.item_id}`, label: e.name, type: 'money' as const })),
    ...others.map((e) => ({ name: `deduction:${e.item_id}`, label: e.name, type: 'money' as const })),
    { name: 'worked_hours', label: '근무 시간', type: 'number', help: s.hours_source === 'attendance' ? '근태 마감에서 가져왔습니다.' : '근태가 없으면 직접 적습니다.' },
    { name: 'overtime_hours', label: '초과근무 시간', type: 'number' },
    { name: 'family_count', label: '공제대상 가족 수(본인 포함)', type: 'integer' },
    { name: 'child_count', label: '8세 이상 20세 이하 자녀 수', type: 'integer' },
    { name: 'tax_ratio', label: '세액 비율(%)', type: 'enum', options: [{ value: '100', label: '100%' }, { value: '80', label: '80%' }, { value: '120', label: '120%' }] },
    { name: 'income_code', label: '소득 구분', type: 'enum', options: [{ value: 'A01', label: 'A01 간이세액' }, { value: 'A02', label: 'A02 중도퇴사' }, { value: 'A03', label: 'A03 일용근로' }] },
    ...STATUTORY.map((c) => ({ name: c, label: CELL_LABEL[c], type: 'money' as const, help: isEdited(s, c) ? '손으로 고친 값입니다. 비우면 다시 계산합니다.' : undefined })),
  ]
  const values: State = {
    worked_hours: s.worked_hours, overtime_hours: s.overtime_hours, family_count: s.family_count, child_count: s.child_count, tax_ratio: String(s.tax_ratio), income_code: s.income_code,
  }
  for (const e of earnings) values[`earning:${e.item_id}`] = e.amount
  for (const e of others) values[`deduction:${e.item_id}`] = e.amount
  for (const c of STATUTORY) values[c] = s[c]
  const answer = await ask({ title: `${s.name} 명세서 고치기`, message: '고친 칸은 대장에 표시됩니다. 금액은 원장 밖에 저장하고, 원장에는 어느 칸을 누가 고쳤는지만 남습니다.', fields, values, confirmLabel: '저장', wide: true })
  if (!answer) return
  const payload: State = { employee_id: s.employee_id }
  const same = (a: unknown, b: unknown) => (a === null || a === undefined || a === '' ? null : Number(a)) === (b === null || b === undefined || b === '' ? null : Number(b))
  const earningChanges: State = {}
  const otherChanges: State = {}
  for (const e of earnings) if (e.calc !== 'overtime_hours' && !same(answer.values[`earning:${e.item_id}`], e.amount)) earningChanges[e.item_id] = answer.values[`earning:${e.item_id}`] ?? 0
  for (const e of others) if (!same(answer.values[`deduction:${e.item_id}`], e.amount)) otherChanges[e.item_id] = answer.values[`deduction:${e.item_id}`] ?? 0
  if (Object.keys(earningChanges).length) payload.earnings = earningChanges
  if (Object.keys(otherChanges).length) payload.other_deductions = otherChanges
  for (const c of [...STATUTORY, 'worked_hours', 'overtime_hours']) if (!same(answer.values[c], s[c])) payload[c] = answer.values[c] === '' ? null : answer.values[c] ?? null
  for (const c of ['family_count', 'child_count']) if (!same(answer.values[c], s[c]) && answer.values[c] !== null) payload[c] = answer.values[c]
  if (String(answer.values.tax_ratio) !== String(s.tax_ratio)) payload.tax_ratio = Number(answer.values.tax_ratio)
  if (answer.values.income_code !== s.income_code) payload.income_code = answer.values.income_code
  if (Object.keys(payload).length === 1) return
  await act(() => sendCommand({ type: 'payroll_run', id: props.record!.id, command: 'set_slip', payload }), '명세서를 고쳤습니다.')
}

async function removeSlip(s: Slip) {
  const answer = await ask({ title: '대장에서 빼기', message: `${s.name}을(를) 이 대장에서 뺍니다.`, confirmLabel: '빼기' })
  if (answer) await act(() => sendCommand({ type: 'payroll_run', id: props.record!.id, command: 'remove_slip', payload: { employee_id: s.employee_id } }))
}

async function cancelDraft() {
  const answer = await ask({ title: '초안 취소', message: '이 초안의 명세서를 모두 지웁니다. 확정한 일이 없으므로 전표는 생기지 않습니다.', danger: true, confirmLabel: '취소하기', cancelLabel: '닫기' })
  if (answer) await act(() => sendCommand({ type: 'payroll_run', id: props.record!.id, command: 'reverse' }), '초안을 취소했습니다.')
}

async function correct() {
  const answer = await ask({
    title: '정정 대장 만들기',
    message: '이 대장은 그대로 남습니다. 같은 금액을 음수로 하는 취소 대장을 확정하고, 같은 줄로 새 초안을 만듭니다. 전표도 그만큼 상쇄됩니다.\n앱은 돈을 옮기지 않습니다. 이미 이체한 돈은 회사가 직접 돌려받아야 합니다.\n사유는 원장에 남습니다. 금액이나 번호를 적지 마세요.',
    danger: true, reason: true, reasonRequired: true, confirmLabel: '정정 대장 만들기', cancelLabel: '닫기',
  })
  if (!answer) return
  await act(async () => {
    const res = await sendCommand<{ id: string }>({ type: 'payroll_run', id: props.record!.id, command: 'correct', reason: answer.reason })
    toast('정정 대장을 만들었습니다.')
    await router.push({ name: 'record', params: { type: 'payroll_run', id: res.id } })
  })
}

async function eraseSlip(s: Slip) {
  const answer = await ask({
    title: '명세서 지우기',
    message: `${s.name}의 이 명세서를 지웁니다. 되돌릴 수 없습니다. 회사 합계와 원천세 집계는 그대로 남습니다.\n세법과 노동법에는 보존 기간이 있습니다. 지워도 되는지 회사가 확인하세요.`,
    danger: true, reason: true, reasonRequired: true, confirmLabel: '지우기', cancelLabel: '닫기',
  })
  if (answer) await act(() => sendCommand({ type: 'payroll_run', id: props.record!.id, command: 'erase_slip', payload: { employee_id: s.employee_id }, reason: answer.reason }), '명세서를 지웠습니다.')
}

async function exportTransfer() {
  const format = formats.value.find((f) => f.id === formatId.value)
  if (!format || !props.record) return
  await act(async () => {
    const rows = await rpc<State[]>('erp_payroll_transfer_rows', { p_run: props.record!.id })
    const missing = rows.filter((r) => r.missing_account).map((r) => r.name)
    if (missing.length) {
      const go = await ask({ title: '계좌가 없는 직원', message: `계좌번호가 없어 빈 칸으로 나갑니다: ${missing.join(', ')}\n직원 급여 정보에서 넣은 뒤 내려받으면 빈 칸이 없습니다.`, confirmLabel: '그래도 내려받기', cancelLabel: '닫기' })
      if (!go) return
    }
    await sendCommand({ type: 'payroll_run', id: props.record!.id, command: 'log_transfer', payload: { format_id: format.id, format_name: format.name, rows: rows.length } })
    saveBlob(transferFile(format, rows), `급여이체_${props.record!.state.number?.replace(/\//g, '-')}.csv`)
    toast('이체 파일을 내려받았습니다. 은행에서 이체한 뒤 지급 완료를 누르세요.')
  })
}
</script>

<template>
  <section v-if="allowed && record" class="sheet" data-testid="payroll-sheet">
    <h2>급여 대장</h2>
    <p class="banner banner-warn small" data-testid="payroll-review-note"><Icon name="alert" /><span>전문가 검수 전입니다. 세액과 공제의 확인과 신고 책임은 회사에 있습니다. 앱은 돈을 옮기지 않고 어디에도 전송하지 않습니다.</span></p>
    <p v-if="error" class="err-text small" role="alert" data-testid="payroll-error">{{ error }}</p>
    <template v-if="sheet">
      <dl class="kv small" data-testid="payroll-data-used">
        <dt>4대보험 요율</dt>
        <dd data-testid="payroll-rates-used">
          <template v-if="sheet.data.rates">{{ sheet.data.rates.name }} · {{ sheet.data.rates.valid_from }}부터 · 출처 {{ sheet.data.rates.source }}<template v-if="sheet.data.rates.checked_on"> · {{ sheet.data.rates.checked_on }} 확인</template></template>
          <span v-else class="err-text" data-testid="payroll-no-rates">효력이 있는 자료가 없습니다. 자료를 넣거나 칸을 직접 입력하세요.</span>
        </dd>
        <dt>간이세액표</dt>
        <dd data-testid="payroll-table-used">
          <template v-if="sheet.data.tax_table">{{ sheet.data.tax_table.name }} · {{ sheet.data.tax_table.valid_from }}부터 · 출처 {{ sheet.data.tax_table.source }}<template v-if="sheet.data.tax_table.checked_on"> · {{ sheet.data.tax_table.checked_on }} 확인</template></template>
          <span v-else class="err-text" data-testid="payroll-no-table">효력이 있는 자료가 없습니다. 자료를 넣거나 칸을 직접 입력하세요.</span>
        </dd>
      </dl>
      <p v-if="isConfirmed && !isReversal" class="small dim" data-testid="payroll-frozen">이 대장의 값은 확정 때의 자료로 고정되어 있습니다. 요율이 바뀌어도 움직이지 않습니다.</p>
      <p v-if="isReversal" class="small dim" data-testid="payroll-reversal-note">다른 대장을 상쇄하는 취소 대장입니다. 금액이 음수입니다.</p>
      <div class="scroll-x">
        <table class="tbl" data-testid="payroll-grid">
          <thead>
            <tr>
              <th>사번</th><th>이름</th><th>구분</th><th class="num">지급 합계</th><th class="num">비과세</th><th class="num">소득세</th><th class="num">지방소득세</th>
              <th class="num">국민연금</th><th class="num">건강보험</th><th class="num">장기요양</th><th class="num">고용보험</th><th class="num">그 밖의 공제</th><th class="num">공제 합계</th><th class="num">차인지급액</th><th class="no-print"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in sheet.slips" :key="s.employee_id" data-testid="payroll-row" :data-name="s.name" :class="{ clickable: isDraft && canWrite }" @click="editSlip(s)">
              <td>{{ s.employee_no }}</td>
              <td>{{ s.name }}
                <div v-if="s.notes?.length" class="small note-list"><span v-for="(n, i) in s.notes" :key="i" class="pill" :class="n.code === 'missing' ? 'pill-red' : 'pill-amber'" data-testid="payroll-note" :data-code="n.code">{{ NOTE_LABEL[n.code] ?? n.code }}<template v-if="n.item"> ({{ n.item }})</template></span></div>
              </td>
              <td>{{ s.income_code }}</td>
              <td class="num" :class="{ edited: s.edited?.some((c) => c.startsWith('earning:')) }" data-col="gross">{{ fmtMoney(s.gross) }}</td>
              <td class="num" data-col="nontaxable">{{ fmtMoney(s.nontaxable) }}</td>
              <td v-for="c in STATUTORY" :key="c" class="num" :class="{ edited: isEdited(s, c) }" :data-col="c" :data-edited="isEdited(s, c) ? 'true' : null">{{ fmtMoney(s[c]) }}</td>
              <td class="num" data-col="other_deduction">{{ fmtMoney(s.other_deduction) }}</td>
              <td class="num" data-col="deductions">{{ fmtMoney(s.deductions) }}</td>
              <td class="num" data-col="net"><strong>{{ fmtMoney(s.net) }}</strong></td>
              <td class="no-print">
                <button v-if="isDraft && canWrite" type="button" class="btn btn-sm" data-testid="payroll-remove" @click.stop="removeSlip(s)">빼기</button>
                <button v-if="isConfirmed && canWrite" type="button" class="btn btn-sm" data-testid="payroll-erase-slip" @click.stop="eraseSlip(s)">지우기</button>
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr data-testid="payroll-totals">
              <th colspan="3">합계 {{ sheet.totals.headcount }}명</th>
              <td class="num" data-col="gross">{{ fmtMoney(sheet.totals.gross) }}</td><td class="num">{{ fmtMoney(sheet.totals.nontaxable) }}</td>
              <td class="num" data-col="income_tax">{{ fmtMoney(sheet.totals.income_tax) }}</td><td class="num" data-col="local_tax">{{ fmtMoney(sheet.totals.local_tax) }}</td>
              <td class="num">{{ fmtMoney(sheet.totals.pension) }}</td><td class="num">{{ fmtMoney(sheet.totals.health) }}</td><td class="num">{{ fmtMoney(sheet.totals.ltc) }}</td><td class="num">{{ fmtMoney(sheet.totals.employment) }}</td>
              <td class="num">{{ fmtMoney(sheet.totals.other) }}</td><td class="num">{{ fmtMoney(sheet.totals.deductions) }}</td><td class="num" data-col="net"><strong>{{ fmtMoney(sheet.totals.net) }}</strong></td><td class="no-print"></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p v-if="isDraft" class="small dim">칸을 고치려면 줄을 누르세요. 월 중 입사·퇴사의 일할 계산은 하지 않습니다. 금액을 직접 고치세요.</p>
      <div class="actions no-print">
        <button v-if="isDraft && canWrite" type="button" class="btn" :disabled="busy" data-testid="payroll-recalc" @click="recalc">다시 계산</button>
        <button v-if="isDraft && canWrite" type="button" class="btn" :disabled="busy" data-testid="payroll-cancel" @click="cancelDraft">초안 취소</button>
        <template v-if="isConfirmed && !record.state.reversed_by && !isReversal">
          <select v-model="formatId" class="select" aria-label="이체 양식" data-testid="payroll-format" style="width: 180px">
            <option v-if="!formats.length" value="">양식 없음</option>
            <option v-for="f in formats" :key="f.id" :value="f.id">{{ f.name }}</option>
          </select>
          <button type="button" class="btn" :disabled="busy || !formatId || !allowed" data-testid="payroll-transfer" @click="exportTransfer"><Icon name="download" :size="13" /> 이체 파일 내려받기</button>
          <router-link v-if="!formats.length" class="small" :to="{ name: 'list', params: { type: 'payroll_bank_format' } }" data-testid="payroll-format-link">은행 이체 양식을 먼저 만드세요</router-link>
          <button v-if="canWrite" type="button" class="btn" :disabled="busy" data-testid="payroll-correct" @click="correct">정정 대장 만들기</button>
        </template>
        <router-link v-if="record.state.reversed_by" class="small" :to="{ name: 'record', params: { type: 'payroll_run', id: record.state.reversed_by } }" data-testid="payroll-reversed-link">이 대장을 상쇄한 취소 대장 보기</router-link>
      </div>
    </template>
  </section>
  <p v-else-if="allowed && route.params.id" class="muted small" data-testid="payroll-past">명세서는 원장에 없으므로 지난 시점의 값을 보여 줄 수 없습니다. 회사 합계는 위와 이력에 있습니다.</p>
</template>

<style scoped>
.sheet { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line); }
.sheet h2 { font-size: 13px; margin-bottom: 8px; }
.sheet .banner { margin-bottom: 8px; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
.clickable { cursor: pointer; }
.note-list { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 2px; }
td.edited { background: var(--amber-bg); box-shadow: inset 0 0 0 1px var(--amber-line); }
.kv { margin-bottom: 8px; }
</style>

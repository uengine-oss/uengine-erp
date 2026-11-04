<script setup lang="ts">
// A file someone downloaded by hand becomes voucher candidates. No login, no scraping: the file is read here, each row is
// checked by the database, and what is kept runs the same command as the voucher screen. No column layout ships with
// the app, because none has been compared with a real file. People arrange the columns and save the arrangement.
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { nudgeBus, sendCommand } from '../../lib/commands'
import { db } from '../../lib/conn'
import { fmtMoney } from '../../lib/format'
import { rows as readRows } from '../../lib/load'
import { writeBlock } from '../../lib/mode'
import { catalogOf } from '../../lib/session'
import { readSheet, type Sheet } from '../../lib/spreadsheet'
import type { State } from '../../lib/types'
import { toast } from '../../lib/ui'
import Icon from '../../components/Icon.vue'
import RefSelect from '../../components/RefSelect.vue'

interface Candidate { row: number; partner_id?: string; partner_by?: string; new_partner?: { name?: string; tax_id?: string }; duplicate_of?: { id?: string; number?: string; by: string; row?: number }; suggested_account_id?: string; supply: number; tax: number; total: number; problems?: string[] }
interface Profile { id: string; state: State }

const SOURCES: Record<string, { label: string; move_type: string; evidence: string; way: string }> = {
  tax_invoice_sale: { label: '매출 세금계산서', move_type: 'out_invoice', evidence: 'tax_invoice', way: 'credit' },
  tax_invoice_purchase: { label: '매입 세금계산서', move_type: 'in_invoice', evidence: 'tax_invoice', way: 'credit' },
  card_purchase: { label: '카드 매입', move_type: 'in_invoice', evidence: 'credit_card', way: 'card' },
  cash_receipt_purchase: { label: '현금영수증 매입', move_type: 'in_invoice', evidence: 'cash_receipt', way: 'cash' },
  bank: { label: '은행 거래', move_type: 'in_invoice', evidence: 'none', way: 'bank' },
  other: { label: '그 밖의 파일', move_type: 'in_invoice', evidence: 'other_receipt', way: 'credit' },
}
const TARGETS = [
  { field: 'date', label: '날짜', required: true }, { field: 'partner_name', label: '거래처 상호' }, { field: 'partner_tax_id', label: '사업자등록번호' },
  { field: 'supply', label: '공급가액' }, { field: 'tax', label: '세액' }, { field: 'total', label: '합계(공급가액이 없을 때)' }, { field: 'approval_no', label: '승인번호' }, { field: 'item', label: '품목' },
]

const source = ref('tax_invoice_purchase')
const moveType = ref('in_invoice')
const profiles = ref<Profile[]>([])
const profileId = ref('')
const profileName = ref('')
const sheet = ref<Sheet | null>(null)
const fileName = ref('')
const columns = reactive<Record<string, string>>({})
const candidates = ref<Candidate[]>([])
const keep = reactive<Record<number, boolean>>({})
const accounts = reactive<Record<number, string | null>>({})
const error = ref('')
const busy = ref(false)
const done = ref<{ written: number; failed: { row: number; message: string }[] } | null>(null)
const hasBooks = computed(() => !!catalogOf('journal_entry'))
const spec = computed(() => SOURCES[source.value])
const profilesOf = computed(() => profiles.value.filter((p) => p.state.source === source.value))
const needsNew = computed(() => candidates.value.filter((c) => !c.partner_id && c.new_partner?.name && keep[c.row]))

const loadProfiles = async () => { profiles.value = await readRows<Profile>(db().from('erp_records').select('id,state').eq('type', 'voucher_import_profile').order('name')) }
onMounted(loadProfiles)
watch(source, (s) => { moveType.value = SOURCES[s].move_type; profileId.value = ''; candidates.value = []; done.value = null })
watch(profileId, (id) => {
  const p = profiles.value.find((x) => x.id === id)
  if (!p) return
  profileName.value = String(p.state.name)
  for (const k of Object.keys(columns)) delete columns[k]
  Object.assign(columns, p.state.columns ?? {})
})

async function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  error.value = ''
  candidates.value = []
  done.value = null
  try {
    const s = await readSheet(file)
    if (!s.rows.length) { error.value = '파일에 머리글 밖의 행이 없습니다.'; return }
    sheet.value = s
    fileName.value = file.name
  } catch {
    error.value = '파일을 읽지 못했습니다. CSV 또는 XLSX 인지 확인하세요.'
  }
}
async function saveProfile() {
  error.value = ''
  try {
    const mapped = Object.fromEntries(Object.entries(columns).filter(([, h]) => h))
    if (profileId.value) await sendCommand({ type: 'voucher_import_profile', id: profileId.value, command: 'update', payload: { name: profileName.value, columns: mapped } })
    else profileId.value = (await sendCommand({ type: 'voucher_import_profile', command: 'create', payload: { name: profileName.value, source: source.value, columns: mapped } })).id
    await loadProfiles()
    toast('열 배치를 저장했습니다.')
  } catch (e) {
    error.value = messageOf(e)
  }
}
const toNumber = (s: unknown) => { const t = String(s ?? '').replace(/[,\s원₩]/g, ''); return t === '' ? null : Number.isFinite(Number(t)) ? Number(t) : t }
const toSend = () => (sheet.value?.rows ?? []).map((r) => {
  const pick = (f: string) => (columns[f] ? r[columns[f]] : undefined)
  return { date: pick('date'), partner_name: pick('partner_name'), partner_tax_id: pick('partner_tax_id'), supply: toNumber(pick('supply')), tax: toNumber(pick('tax')), total: toNumber(pick('total')), approval_no: pick('approval_no'), item: pick('item') }
})
async function check() {
  error.value = ''
  done.value = null
  busy.value = true
  try {
    const r = await rpc<{ rows: Candidate[] }>('erp_voucher_candidates', { p_move_type: moveType.value, p_evidence: spec.value.evidence, p_rows: toSend() })
    candidates.value = r.rows
    for (const c of r.rows) {
      keep[c.row] = !c.duplicate_of && !c.problems?.length
      accounts[c.row] = c.suggested_account_id ?? null
    }
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}
async function registerPartners() {
  busy.value = true
  error.value = ''
  try {
    const seen = new Set<string>()
    for (const c of needsNew.value) {
      const key = `${c.new_partner?.tax_id ?? ''}|${c.new_partner?.name ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      await sendCommand({ type: 'partner', command: 'create', payload: { name: c.new_partner?.name, ...(c.new_partner?.tax_id ? { tax_id: c.new_partner.tax_id } : {}) } })
    }
    toast(`거래처 ${seen.size}곳을 등록했습니다.`)
    await check()
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}
async function write() {
  busy.value = true
  error.value = ''
  try {
    const raw = toSend()
    const chosen = candidates.value.filter((c) => keep[c.row] && c.partner_id)
    const rows_ = chosen.map((c) => ({
      voucher: true, move_type: moveType.value, partner_id: c.partner_id, invoice_date: String(raw[c.row].date), evidence_type: spec.value.evidence, payment_way: spec.value.way,
      ...(raw[c.row].approval_no ? { approval_no: raw[c.row].approval_no } : {}),
      lines: [{ name: raw[c.row].item || '가져온 전표', qty: 1, price_unit: c.supply, ...(c.tax !== null && spec.value.evidence !== 'none' && spec.value.evidence !== 'other_receipt' ? { tax_override: c.tax } : {}), ...(accounts[c.row] ? { account_id: accounts[c.row] } : {}) }],
    }))
    const r = await rpc<{ written: boolean; created: number; failed: number; rows: { row: number; status: string; message?: string }[] }>('erp_import', { p_type: 'account_move', p_rows: rows_, p_mode: 'commit', p_options: { keep_good: true } })
    const result = { written: r.written ? r.created : 0, failed: r.rows.filter((x) => x.status === 'error').map((x) => ({ row: chosen[x.row].row, message: String(x.message) })) }
    nudgeBus()
    await check()
    done.value = result
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}
const rowNo = (n: number) => n + 2
const raw = (n: number, f: string) => { const h = columns[f]; return h ? sheet.value?.rows[n]?.[h] : '' }
const canWrite = computed(() => !writeBlock.value && !busy.value && candidates.value.some((c) => keep[c.row] && c.partner_id))
</script>

<template>
  <div class="page" data-testid="voucher-import">
    <div class="page-head">
      <h1>전표 파일 가져오기</h1>
      <div class="grow"></div>
      <router-link class="btn" :to="{ name: 'voucher' }">전표 입력으로</router-link>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert" data-testid="vimport-error"><Icon name="alert" /><span class="grow">{{ error }}</span></div>
    <div class="page-body report-pad">
      <p class="hint" data-testid="vimport-promise">사람이 내려받은 파일만 받습니다. 금융 ID, 비밀번호, 공동인증서를 받지 않고 스크래핑도 하지 않습니다. 파일은 이 브라우저 안에서 읽습니다.</p>
      <section class="report-section">
        <h2>1. 어떤 자료인가요</h2>
        <div class="row-wrap">
          <select v-model="source" class="select" style="width: 180px" aria-label="자료" data-testid="vimport-source"><option v-for="(s, k) in SOURCES" :key="k" :value="k">{{ s.label }}</option></select>
          <select v-if="source === 'bank' || source === 'other'" v-model="moveType" class="select" style="width: 100px" aria-label="거래구분" data-testid="vimport-side"><option value="in_invoice">매입</option><option value="out_invoice">매출</option></select>
          <span class="pill pill-amber" data-testid="vimport-unverified">확인 안 됨</span>
          <input class="input" style="width: 280px" type="file" accept=".csv,.tsv,.txt,.xlsx" aria-label="파일" data-testid="vimport-file" @change="onFile" />
        </div>
        <p class="hint" style="margin-top: 4px">이 자료의 실제 파일 양식을 대조하지 못했습니다. 열을 직접 맞추세요. 맞춘 배치는 저장해 다음에 씁니다.</p>
      </section>

      <section v-if="sheet" class="report-section" data-testid="vimport-mapping">
        <h2>2. 열 맞추기 <span class="muted small">{{ fileName }} · {{ sheet.rows.length }}행</span></h2>
        <div class="row-wrap" style="margin-bottom: 6px">
          <select v-model="profileId" class="select" style="width: 180px" aria-label="저장한 배치" data-testid="vimport-profile"><option value="">새 배치</option><option v-for="p in profilesOf" :key="p.id" :value="p.id">{{ p.state.name }}</option></select>
          <input v-model="profileName" class="input" style="width: 180px" placeholder="배치 이름" aria-label="배치 이름" data-testid="vimport-profile-name" />
          <button type="button" class="btn" :disabled="!profileName.trim() || !!writeBlock" data-testid="vimport-profile-save" @click="saveProfile">배치 저장</button>
        </div>
        <table class="tbl">
          <thead><tr><th>넣을 항목</th><th style="width: 240px">파일의 열</th></tr></thead>
          <tbody>
            <tr v-for="t in TARGETS" :key="t.field" data-testid="vimport-target" :data-field="t.field">
              <td>{{ t.label }}{{ t.required ? ' *' : '' }}</td>
              <td><select v-model="columns[t.field]" class="select" :aria-label="`${t.label} 열`" data-testid="vimport-column"><option value="">없음</option><option v-for="h in sheet.headers" :key="h" :value="h">{{ h }}</option></select></td>
            </tr>
          </tbody>
        </table>
        <div class="row-wrap" style="margin-top: 8px"><button type="button" class="btn btn-primary" :disabled="busy || !columns.date" data-testid="vimport-check" @click="check">후보 보기</button></div>
      </section>

      <section v-if="candidates.length" class="report-section" data-testid="vimport-candidates">
        <h2>3. 전표 후보</h2>
        <div v-if="needsNew.length" class="banner banner-warn" data-testid="vimport-new-partners"><Icon name="info" /><span class="grow">없는 거래처 {{ needsNew.length }}건이 있습니다.</span><button type="button" class="btn btn-sm" :disabled="busy || !!writeBlock" data-testid="vimport-register" @click="registerPartners">거래처 등록</button></div>
        <div class="scroll-x">
          <table class="tbl">
            <thead><tr><th style="width: 30px"></th><th class="num">파일 행</th><th>날짜</th><th>거래처</th><th>승인번호</th><th class="num">공급가액</th><th class="num">세액</th><th v-if="hasBooks" style="width: 170px">계정</th><th>상태</th></tr></thead>
            <tbody>
              <tr v-for="c in candidates" :key="c.row" data-testid="vimport-row" :data-row="rowNo(c.row)">
                <td><input v-model="keep[c.row]" type="checkbox" :disabled="!!c.problems?.length" :aria-label="`${rowNo(c.row)}행 넣기`" data-testid="vimport-keep" /></td>
                <td class="num">{{ rowNo(c.row) }}</td><td>{{ raw(c.row, 'date') }}</td>
                <td>{{ raw(c.row, 'partner_name') }} <span class="muted small">{{ raw(c.row, 'partner_tax_id') }}</span></td>
                <td class="muted">{{ raw(c.row, 'approval_no') }}</td><td class="num">{{ fmtMoney(c.supply) }}</td><td class="num">{{ fmtMoney(c.tax) }}</td>
                <td v-if="hasBooks"><RefSelect v-model="accounts[c.row]" ref-type="account" data-testid="vimport-account" /></td>
                <td class="wrap" data-testid="vimport-status">
                  <span v-if="c.problems?.length" class="pill pill-red">{{ c.problems.join(', ') }}</span>
                  <span v-else-if="c.duplicate_of" class="pill pill-amber" data-testid="vimport-duplicate">{{ c.duplicate_of.by === 'same_file' ? `${rowNo(c.duplicate_of.row ?? 0)}행과 중복` : `이미 있음 ${c.duplicate_of.number ?? ''}` }}</span>
                  <span v-else-if="!c.partner_id" class="pill pill-blue">새 거래처</span>
                  <span v-else-if="c.suggested_account_id" class="pill pill-green" data-testid="vimport-suggested">지난번 계정</span>
                  <span v-else class="muted small">새 전표</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="row-wrap" style="margin-top: 8px"><button type="button" class="btn btn-primary" :disabled="!canWrite" data-testid="vimport-write" @click="write">고른 행을 전표로</button></div>
        <div v-if="done" class="banner banner-ok" style="margin-top: 8px" data-testid="vimport-done"><Icon name="check" /><span>전표 {{ done.written }}건을 게시했습니다.</span></div>
        <ul v-if="done?.failed.length" class="small" data-testid="vimport-failed"><li v-for="f in done.failed" :key="f.row">{{ rowNo(f.row) }}행: {{ f.message }}</li></ul>
      </section>
    </div>
  </div>
</template>

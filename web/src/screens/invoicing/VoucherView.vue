<script setup lang="ts">
// The evidence on one screen. It writes no document of its own: saving sends one command that makes, posts and pays an
// ordinary invoice. Every default and every figure comes from the database's preview.
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { nudgeBus, onDataChanged, sendCommand } from '../../lib/commands'
import { db } from '../../lib/conn'
import { fmtDay, fmtMoney } from '../../lib/format'
import { rows as readRows, useLoad } from '../../lib/load'
import { writeBlock } from '../../lib/mode'
import { ensureNames, refLabel } from '../../lib/refs'
import { catalogOf } from '../../lib/session'
import type { CommandResult, State } from '../../lib/types'
import { csvBlob, saveBlob, toast } from '../../lib/ui'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'
import LoadError from '../../components/LoadError.vue'
import NumberInput from '../../components/NumberInput.vue'
import RefSelect from '../../components/RefSelect.vue'

interface Line { key: number; variant_id: string | null; account_id: string | null; name: string; qty: number | null; price_unit: number | null; tax_override: number | null; fixed_asset: boolean }
interface BookRow { account_id: string; account_name: string; name: string; debit: number; credit: number }

const EVIDENCE = [
  { value: 'tax_invoice', label: '세금계산서' }, { value: 'exempt_invoice', label: '계산서' }, { value: 'credit_card', label: '신용카드' },
  { value: 'cash_receipt', label: '현금영수증' }, { value: 'other_receipt', label: '그 밖의 영수증' }, { value: 'none', label: '없음' },
]
const WAYS = [{ value: 'credit', label: '외상' }, { value: 'cash', label: '현금' }, { value: 'bank', label: '보통예금' }, { value: 'card', label: '카드' }]
const REASONS = (catalogOf('account_move')?.fields.find((f) => f.name === 'non_deduct_reason')?.options ?? []) as { value: string; label: string }[]

const today = fmtDay(new Date().toISOString())
let nextKey = 1
const newLine = (): Line => ({ key: nextKey++, variant_id: null, account_id: null, name: '', qty: 1, price_unit: null, tax_override: null, fixed_asset: false })
const form = reactive({
  move_type: 'in_invoice', evidence_type: 'tax_invoice', partner_id: null as string | null, invoice_date: today, approval_no: '',
  payment_way: 'credit', deductible: true, non_deduct_reason: '', card_kind: 'business', stock_reflect: false, tax_id: '', allow_duplicate: false,
})
const lines = ref<Line[]>([newLine()])
const taxes = ref<{ id: string; name: string; scope: string }[]>([])
const hasStock = computed(() => !!catalogOf('picking'))
const hasBooks = computed(() => !!catalogOf('journal_entry'))
const buying = computed(() => form.move_type === 'in_invoice')
const partnerTaxId = ref('')
const preview = ref<State | null>(null)
const books = ref<BookRow[]>([])
const error = ref('')
const saving = ref(false)
const saved = ref<CommandResult | null>(null)

const lineRows = () => lines.value.filter((l) => l.variant_id || l.name.trim() || l.price_unit).map((l) => ({
  ...(l.variant_id ? { variant_id: l.variant_id } : {}), ...(l.name.trim() ? { name: l.name.trim() } : {}), ...(l.account_id ? { account_id: l.account_id } : {}),
  qty: l.qty ?? 1, ...(l.price_unit !== null ? { price_unit: l.price_unit } : {}),
  ...(form.tax_id ? { tax_ids: [form.tax_id] } : {}), ...(l.tax_override !== null ? { tax_override: l.tax_override } : {}), ...(l.fixed_asset && buying.value ? { fixed_asset: true } : {}),
}))
const payload = (): State => ({
  voucher: true, move_type: form.move_type, evidence_type: form.evidence_type, partner_id: form.partner_id, invoice_date: form.invoice_date, payment_way: form.payment_way, lines: lineRows(),
  ...(form.approval_no.trim() ? { approval_no: form.approval_no.trim() } : {}),
  ...(buying.value && !form.deductible ? { deductible: false, ...(form.non_deduct_reason ? { non_deduct_reason: form.non_deduct_reason } : {}) } : {}),
  ...(form.evidence_type === 'credit_card' ? { card_kind: form.card_kind } : {}),
  ...(form.stock_reflect && hasStock.value ? { stock_reflect: true } : {}), ...(form.allow_duplicate ? { allow_duplicate: true } : {}),
})

// A receipt starts with no deduction and a tax invoice with one, by what the database says each evidence allows.
watch(() => [form.evidence_type, form.move_type], () => { form.deductible = ['tax_invoice', 'credit_card', 'cash_receipt'].includes(form.evidence_type); form.tax_id = '' })

let timer: ReturnType<typeof setTimeout> | undefined
let seq = 0
async function refresh() {
  const my = ++seq
  if (!lineRows().length) { preview.value = null; books.value = []; return }
  try {
    const p = await rpc<State>('erp_preview', { p_type: 'account_move', p_payload: payload() })
    if (my !== seq) return
    preview.value = p
    error.value = ''
    if (hasBooks.value && form.partner_id && p?.facts) {
      const b = await rpc<{ rows: BookRow[] }>('erp_preview', { p_type: 'journal_entry', p_payload: p.facts })
      if (my === seq) books.value = b.rows
    } else books.value = []
  } catch (e) {
    if (my === seq) { error.value = messageOf(e); books.value = [] }
  }
}
watch([form, lines], () => { clearTimeout(timer); timer = setTimeout(refresh, 250) }, { deep: true })
onBeforeUnmount(() => clearTimeout(timer))

watch(() => form.partner_id, async (id) => {
  partnerTaxId.value = ''
  if (!id) return
  const found = await readRows<{ state: State }>(db().from('erp_records').select('state').eq('id', id))
  partnerTaxId.value = String(found[0]?.state.tax_id ?? '')
})

const taxOptions = computed(() => taxes.value.filter((t) => t.scope === (buying.value ? 'purchase' : 'sale')))
const canSave = computed(() => !writeBlock.value && !saving.value && !!form.partner_id && !!form.invoice_date && lineRows().length > 0 && !preview.value?.problem)
async function save() {
  error.value = ''
  saving.value = true
  try {
    const res = await sendCommand({ type: 'account_move', command: 'create', payload: payload() })
    saved.value = res
    toast(`전표 ${res.state.number} 을(를) 게시했습니다.`)
    lines.value = [newLine()]
    Object.assign(form, { approval_no: '', stock_reflect: false, allow_duplicate: false })
    preview.value = null
    books.value = []
    nudgeBus()
    void recent.load()
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    saving.value = false
  }
}

const recent = useLoad(() => readRows<{ id: string; name: string; status: string; state: State }>(
  db().from('erp_records').select('id,name,status,state').eq('type', 'account_move').eq('state->>voucher', 'true').order('created_at', { ascending: false }).limit(20)))
onMounted(async () => {
  void recent.load()
  taxes.value = (await readRows<{ id: string; state: State }>(db().from('erp_records').select('id,state').eq('type', 'tax').eq('active', true).order('name')))
    .map((t) => ({ id: t.id, name: String(t.state.name), scope: String(t.state.scope) }))
})
onDataChanged(() => { void recent.load() })
watch(() => recent.data.value, (r) => { if (r?.length) void ensureNames(r.map((x) => x.state.partner_id)) })
const labelOf = (v: unknown) => EVIDENCE.find((e) => e.value === v)?.label ?? ''

// What the tax office's bulk issue screen would want. Its own layout has not been compared with a real file.
const exportFrom = ref(`${today.slice(0, 7)}-01`)
const exportTo = ref(today)
async function exportBulk() {
  try {
    const data = await rpc<State[]>('erp_tax_invoice_rows', { p_from: exportFrom.value, p_to: exportTo.value })
    if (!data.length) { toast('그 기간에 게시한 매출 세금계산서가 없습니다.', 'error'); return }
    const cell = (value: unknown, numeric = false) => ({ value, numeric })
    saveBlob(csvBlob(['작성일자', '공급받는자 사업자등록번호', '공급받는자 상호', '공급가액', '세액', '품목', '번호', '승인번호', '수정 사유', '처음 작성일'], data.map((r) => [
      cell(r.date), cell(r.partner_tax_id), cell(r.partner_name), cell(Number(r.supply) * (String(r.move_type).endsWith('refund') ? -1 : 1), true), cell(Number(r.tax) * (String(r.move_type).endsWith('refund') ? -1 : 1), true),
      cell(r.item), cell(r.number), cell(r.approval_no), cell(r.amend_reason), cell(r.original_date)])), `세금계산서_${exportFrom.value}_${exportTo.value}.csv`)
  } catch (e) {
    toast(messageOf(e), 'error')
  }
}
</script>

<template>
  <div class="page" data-testid="voucher">
    <div class="page-head">
      <h1>매입매출 전표</h1>
      <div class="grow"></div>
      <router-link class="btn" :to="{ name: 'voucher-import' }" data-testid="voucher-to-import"><Icon name="download" :size="13" />파일로 가져오기</router-link>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert" data-testid="voucher-error"><Icon name="alert" /><span class="grow">{{ error }}</span></div>
    <div class="page-body report-pad">
      <div v-if="saved" class="banner banner-ok" data-testid="voucher-saved">
        <Icon name="check" />
        <span class="grow">{{ saved.state.number }} 게시 완료.<span v-if="saved.state.voucher_payment_id"> 결제까지 처리했습니다.</span> 장부와 재고는 곧 뒤따릅니다.</span>
        <router-link class="btn btn-sm" :to="{ name: 'record', params: { type: 'account_move', id: saved.id } }" data-testid="voucher-open">전표 보기</router-link>
      </div>

      <section class="report-section">
        <div class="voucher-grid">
          <label class="field-inline">거래구분
            <select v-model="form.move_type" class="select" data-testid="voucher-side"><option value="in_invoice">매입</option><option value="out_invoice">매출</option></select>
          </label>
          <label class="field-inline">증빙유형
            <select v-model="form.evidence_type" class="select" data-testid="voucher-evidence"><option v-for="e in EVIDENCE" :key="e.value" :value="e.value">{{ e.label }}</option></select>
          </label>
          <label class="field-inline">증빙 일자 <input v-model="form.invoice_date" type="date" class="input" data-testid="voucher-date" /></label>
          <label class="field-inline">승인번호 <input v-model="form.approval_no" class="input" data-testid="voucher-approval" placeholder="있으면 적습니다" /></label>
          <div class="field-inline voucher-partner">거래처 <RefSelect v-model="form.partner_id" ref-type="partner" data-testid="voucher-partner" /></div>
          <span class="small dim" data-testid="voucher-partner-tax">{{ form.partner_id ? (partnerTaxId ? `사업자등록번호 ${partnerTaxId}` : '사업자등록번호 없음') : '' }}</span>
          <label class="field-inline">결제방법
            <select v-model="form.payment_way" class="select" data-testid="voucher-way"><option v-for="w in WAYS" :key="w.value" :value="w.value">{{ w.label }}</option></select>
          </label>
          <label class="field-inline">세금
            <select v-model="form.tax_id" class="select" data-testid="voucher-tax"><option value="">증빙에 맞게</option><option v-for="t in taxOptions" :key="t.id" :value="t.id">{{ t.name }}</option></select>
          </label>
          <label v-if="form.evidence_type === 'credit_card' && buying" class="field-inline">카드
            <select v-model="form.card_kind" class="select" data-testid="voucher-card"><option value="business">사업용 신용카드</option><option value="other">그 밖의 신용카드</option></select>
          </label>
          <label v-if="buying" class="check small"><input v-model="form.deductible" type="checkbox" data-testid="voucher-deductible" />매입세액 공제</label>
          <label v-if="buying && !form.deductible" class="field-inline">불공제 사유
            <select v-model="form.non_deduct_reason" class="select" data-testid="voucher-reason"><option value="">선택</option><option v-for="r in REASONS" :key="r.value" :value="r.value">{{ r.label }}</option></select>
          </label>
          <label v-if="hasStock" class="check small"><input v-model="form.stock_reflect" type="checkbox" data-testid="voucher-stock" />재고 반영</label>
        </div>
      </section>

      <section class="report-section">
        <h2>품목 또는 계정</h2>
        <div class="scroll-x">
          <table class="tbl" data-testid="voucher-lines">
            <thead><tr><th style="width: 200px">제품</th><th v-if="hasBooks" style="width: 170px">계정</th><th>적요</th><th class="num" style="width: 70px">수량</th><th class="num" style="width: 110px">단가</th><th class="num" style="width: 110px">공급가액</th><th class="num" style="width: 110px">세액</th><th v-if="buying" style="width: 60px">고정자산</th><th style="width: 30px"></th></tr></thead>
            <tbody>
              <tr v-for="(l, i) in lines" :key="l.key" data-testid="voucher-line">
                <td><RefSelect v-model="l.variant_id" ref-type="variant" data-testid="voucher-line-product" /></td>
                <td v-if="hasBooks"><RefSelect v-model="l.account_id" ref-type="account" data-testid="voucher-line-account" /></td>
                <td><input v-model="l.name" class="input" aria-label="적요" data-testid="voucher-line-name" /></td>
                <td><NumberInput v-model="l.qty" kind="number" data-testid="voucher-line-qty" /></td>
                <td><NumberInput v-model="l.price_unit" kind="money" data-testid="voucher-line-price" /></td>
                <td class="num" data-testid="voucher-line-subtotal">{{ fmtMoney(preview?.lines?.[i]?.subtotal ?? 0) }}</td>
                <td><NumberInput v-model="l.tax_override" kind="money" :placeholder="fmtMoney(preview?.lines?.[i]?.tax_amount ?? 0)" data-testid="voucher-line-tax" /></td>
                <td v-if="buying"><input v-model="l.fixed_asset" type="checkbox" aria-label="고정자산" data-testid="voucher-line-fixed" /></td>
                <td><button v-if="lines.length > 1" type="button" class="btn btn-ghost btn-sm" aria-label="줄 빼기" @click="lines.splice(i, 1)"><Icon name="x" :size="12" /></button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <button type="button" class="btn btn-sm" style="margin-top: 6px" data-testid="voucher-add-line" @click="lines.push(newLine())"><Icon name="plus" :size="12" />줄 더하기</button>
        <p class="hint" style="margin-top: 4px">세액을 비우면 세율로 계산합니다. 증빙에 적힌 세액이 다르면 적으세요.</p>
      </section>

      <div v-if="preview?.problem" class="banner banner-warn" data-testid="voucher-problem" role="alert"><Icon name="alert" /><span>{{ preview.problem }}</span></div>
      <div v-if="preview?.duplicate_of" class="banner banner-warn" data-testid="voucher-duplicate" role="alert">
        <Icon name="alert" /><span class="grow">{{ preview.duplicate_of.by === 'approval_no' ? '같은 승인번호의' : '거래처·날짜·금액이 같은' }} 전표 {{ preview.duplicate_of.number }} 이(가) 이미 있습니다.</span>
        <label v-if="preview.duplicate_of.by !== 'approval_no'" class="check small"><input v-model="form.allow_duplicate" type="checkbox" data-testid="voucher-allow-duplicate" />따로 넣습니다</label>
      </div>
      <div v-if="Number(preview?.tax_gap ?? 0) !== 0" class="banner banner-warn" data-testid="voucher-tax-gap"><Icon name="info" /><span>적은 세액이 세율로 계산한 값과 {{ fmtMoney(preview?.tax_gap) }} 다릅니다. 증빙대로 저장합니다.</span></div>

      <div v-if="preview" class="stat-row" data-testid="voucher-totals">
        <div class="stat"><span class="stat-label">공급가액</span><span class="stat-value" data-testid="voucher-untaxed">{{ fmtMoney(preview.amount_untaxed) }}</span></div>
        <div class="stat"><span class="stat-label">세액</span><span class="stat-value" data-testid="voucher-tax-amount">{{ fmtMoney(preview.amount_tax) }}</span></div>
        <div class="stat"><span class="stat-label">합계</span><span class="stat-value" data-testid="voucher-total">{{ fmtMoney(preview.amount_total) }}</span></div>
      </div>

      <section v-if="books.length" class="report-section" data-testid="voucher-books">
        <h2>저장하면 생길 분개</h2>
        <table class="tbl">
          <thead><tr><th>계정</th><th>적요</th><th class="num">차변</th><th class="num">대변</th></tr></thead>
          <tbody><tr v-for="(b, i) in books" :key="i" data-testid="voucher-book-row" :data-account="b.account_name"><td>{{ b.account_name }}</td><td class="muted">{{ b.name }}</td><td class="num">{{ fmtMoney(b.debit) }}</td><td class="num">{{ fmtMoney(b.credit) }}</td></tr></tbody>
        </table>
      </section>
      <p v-else-if="preview && !hasBooks" class="muted small" data-testid="voucher-no-books">회계 모듈이 꺼져 있습니다. 켜면 이 전표로 분개를 다시 만듭니다.</p>

      <div class="row-wrap" style="margin-top: 10px">
        <button type="button" class="btn btn-primary" :disabled="!canSave" data-testid="voucher-save" @click="save"><span v-if="saving" class="spin"></span>저장하고 게시</button>
      </div>

      <section class="report-section" style="margin-top: 18px">
        <h2>최근 전표</h2>
        <LoadError :message="recent.error.value" @retry="recent.load" />
        <div v-if="recent.data.value?.length" class="scroll-x">
          <table class="tbl" data-testid="voucher-recent">
            <thead><tr><th>번호</th><th>일자</th><th>구분</th><th>증빙</th><th>거래처</th><th>승인번호</th><th class="num">공급가액</th><th class="num">세액</th></tr></thead>
            <tbody>
              <tr v-for="r in recent.data.value" :key="r.id" data-testid="voucher-recent-row" :data-number="r.state.number">
                <td><router-link :to="{ name: 'record', params: { type: 'account_move', id: r.id } }">{{ r.state.number ?? '초안' }}</router-link></td>
                <td>{{ r.state.invoice_date }}</td><td>{{ String(r.state.move_type).startsWith('in_') ? '매입' : '매출' }}{{ String(r.state.move_type).endsWith('refund') ? ' 정정' : '' }}</td><td>{{ labelOf(r.state.evidence_type) }}</td>
                <td>{{ refLabel(r.state.partner_id) }}</td><td class="muted">{{ r.state.approval_no }}</td><td class="num">{{ fmtMoney(r.state.amount_untaxed) }}</td><td class="num">{{ fmtMoney(r.state.amount_tax) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <EmptyState v-else-if="!recent.loading.value" title="아직 전표가 없습니다" />
      </section>

      <section class="report-section" data-testid="voucher-export">
        <h2>세금계산서 내보내기</h2>
        <div class="row-wrap">
          <label class="field-inline">시작 <input v-model="exportFrom" type="date" class="input" data-testid="voucher-export-from" /></label>
          <label class="field-inline">끝 <input v-model="exportTo" type="date" class="input" data-testid="voucher-export-to" /></label>
          <button type="button" class="btn" data-testid="voucher-export-csv" @click="exportBulk"><Icon name="download" :size="13" />일괄 발급용 CSV</button>
        </div>
        <p class="hint" style="margin-top: 4px">홈택스 일괄 발급 양식과 대조하지 못했습니다(확인 안 됨). 열을 맞춘 뒤 올리세요. 전자 발행은 대행 계약이 있어야 해서 이 앱이 하지 않습니다.</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.voucher-grid { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; }
.voucher-partner { min-width: 280px; }
.voucher-partner :deep(.combo) { width: 220px; }
</style>

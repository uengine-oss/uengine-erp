<script setup lang="ts">
// The return in the form's order, with the documents behind each line. Figures come from the database; what it does
// not fill it says so. This prepares what a person files: nothing here files, issues or transmits.
import { computed, onMounted, ref, watch } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { nudgeBus, onDataChanged, sendCommand } from '../../lib/commands'
import { db } from '../../lib/conn'
import { fmtDay, fmtMoney } from '../../lib/format'
import { rows as readRows, useLoad } from '../../lib/load'
import { writeBlock } from '../../lib/mode'
import { catalogOf, isAdmin } from '../../lib/session'
import type { State } from '../../lib/types'
import { ask, csvBlob, saveBlob, toast } from '../../lib/ui'
import { makeZip } from '../../lib/zip'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'
import LoadError from '../../components/LoadError.vue'

interface Line { no: string; group: string; label: string; rate?: string; handled: boolean; sum?: boolean; mark?: string; amount: number | null; tax: number | null; rate_tax?: number | null; count: number }
interface Entry { id: string; number: string; date: string; invoice_date: string; move_type: string; partner_name: string; partner_tax_id: string; evidence_type: string; approval_no: string; amend_reason: string; cell: string; amount: number; tax: number }
interface Report {
  year: number; term: number; kind: string; from: string; to: string; due: string; preliminary_filed: boolean; lines: Line[]; pending: boolean; stuck: string | null; review: string; form: string
  totals: { ga: number; na: number; da: number; prior_refund: number; payable: number; payable_rounded: number }
  unclassified: { id: string; number: string; date: string; partner_name: string; amount: number; tax: number }[]
  no_cell: { amount: number; tax: number; count: number }
  exceptions: { date_outside: { id: string; number: string; date: string; invoice_date: string }[]; missing_tax_id: { id: string; number: string; partner_name: string }[] }
  filed: { id: string; at: string; from: string; to: string; totals: Report['totals'] } | null
}
interface Period { term: number; kind: string; from: string; to: string; due: string; state: string; label: string }
interface SummaryPart { partners: number; sheets: number; amount: number; tax: number }
interface Summary { form: string; total: SummaryPart; electronic: SummaryPart; other: SummaryPart; rows: { tax_id: string; partner_name: string; electronic: boolean; sheets: number; amount: number; tax: number }[] }
interface CardPart { count: number; amount: number; tax: number }
interface CardStatement { form: string; total: CardPart; cash_receipt: CardPart; business: CardPart; other: CardPart; other_rows: { tax_id: string; partner_name: string; count: number; amount: number; tax: number }[] }

const STATE: Record<string, { label: string; color: string }> = { filed: { label: '마감', color: 'green' }, overdue: { label: '기한 지남', color: 'red' }, to_file: { label: '신고 대기', color: 'blue' }, open: { label: '진행 중', color: 'gray' } }
const EVIDENCE: Record<string, string> = { tax_invoice: '세금계산서', exempt_invoice: '계산서', credit_card: '신용카드', cash_receipt: '현금영수증', other_receipt: '그 밖의 영수증', none: '없음' }
const today = fmtDay(new Date().toISOString())
const year = ref(Number(today.slice(0, 4)))
const term = ref(Number(today.slice(5, 7)) <= 6 ? 1 : 2)
const kind = ref<'preliminary' | 'final'>(Number(today.slice(5, 7)) % 6 >= 1 && Number(today.slice(5, 7)) % 6 <= 3 ? 'preliminary' : 'final')
const asFiled = ref(false)
const tab = ref<'return' | 'sale' | 'purchase' | 'card' | 'register'>('return')
const opened = ref<string | null>(null)
const entries = ref<Entry[]>([])
const closing = ref(false)
const error = ref('')

const args = () => ({ p_year: year.value, p_term: term.value, p_kind: kind.value })
const periods = useLoad(() => rpc<{ periods: Period[] }>('erp_krtax_periods', { p_year: year.value }))
const report = useLoad(() => rpc<Report>('erp_krtax_return', { ...args(), p_at: asFiledAt.value }))
const asFiledAt = ref<string | null>(null)
const sale = useLoad(() => rpc<Summary>('erp_krtax_invoice_summary', { ...args(), p_side: 'sale', p_at: asFiledAt.value }))
const purchase = useLoad(() => rpc<Summary>('erp_krtax_invoice_summary', { ...args(), p_side: 'purchase', p_at: asFiledAt.value }))
const card = useLoad(() => rpc<CardStatement>('erp_krtax_card_statement', { ...args(), p_at: asFiledAt.value }))
const register = useLoad(() => rpc<State[]>('erp_krtax_register', { ...args(), p_at: asFiledAt.value }))
const reload = () => { opened.value = null; void report.load(); void periods.load(); void sale.load(); void purchase.load(); void card.load(); void register.load() }
watch([year, term, kind], () => { asFiled.value = false; asFiledAt.value = null; reload() })
watch(asFiled, (on) => { asFiledAt.value = on ? report.data.value?.filed?.at ?? null : null; reload() })
onMounted(reload)
onDataChanged(() => { if (!asFiled.value) { void report.load(); void sale.load(); void purchase.load(); void card.load(); void register.load() } })

const r = computed(() => report.data.value)
const grouped = computed(() => {
  const out: { group: string; lines: Line[] }[] = []
  for (const l of r.value?.lines ?? []) {
    const last = out[out.length - 1]
    if (last?.group === l.group) last.lines.push(l)
    else out.push({ group: l.group, lines: [l] })
  }
  return out
})
const notHandled = computed(() => (r.value?.lines ?? []).filter((l) => !l.handled))
const periodLabel = computed(() => `${year.value}년 제${term.value}기 ${kind.value === 'preliminary' ? '예정' : '확정'}`)
const periodState = computed(() => periods.data.value?.periods.find((p) => p.term === term.value && p.kind === kind.value)?.state ?? 'open')
const opensDocs = (l: Line) => l.handled && l.no !== '23'

async function open(cell: string) {
  if (opened.value === cell) { opened.value = null; return }
  try {
    entries.value = await rpc<Entry[]>('erp_krtax_cell', { ...args(), p_cell: cell, p_at: asFiledAt.value })
    opened.value = cell
  } catch (e) {
    toast(messageOf(e), 'error')
  }
}
async function file() {
  const answer = await ask({ title: `${periodLabel.value} 마감`, message: `이 값을 신고한 것으로 남기고 ${r.value?.to} 까지 세금 잠금일을 겁니다. 그 기간의 증빙 문서는 게시·취소할 수 없게 됩니다. 앱이 국세청에 보내는 것은 없습니다. 신고는 홈택스에서 직접 합니다.`, confirmLabel: '마감', cancelLabel: '취소', danger: true })
  if (!answer) return
  closing.value = true
  error.value = ''
  try {
    const made = await sendCommand({ type: 'vat_return', command: 'create', payload: { year: year.value, term: String(term.value), kind: kind.value } })
    await sendCommand({ type: 'vat_return', id: made.id, command: 'file', payload: {} })
    toast('마감했습니다.')
    reload()
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    closing.value = false
  }
}
async function reopen() {
  if (!r.value?.filed) return
  const answer = await ask({ title: '마감 풀기', message: '이 기간의 마감 표시를 풉니다. 세금 잠금일은 그대로이니 마감 잠금 화면에서 따로 고칩니다. 이미 낸 신고를 고치는 일은 수정 신고로 직접 합니다.', confirmLabel: '풀기', cancelLabel: '취소', danger: true,
    fields: [{ name: 'reason', label: '사유', type: 'text', required: true }] })
  if (!answer) return
  try {
    await sendCommand({ type: 'vat_return', id: r.value.filed.id, command: 'reopen', payload: { reason: answer.values.reason }, reason: String(answer.values.reason) })
    asFiled.value = false
    reload()
  } catch (e) {
    toast(messageOf(e), 'error')
  }
}
const cell = (value: unknown, numeric = false) => ({ value, numeric })
function exportReturn() {
  saveBlob(csvBlob(['칸', '항목', '금액', '세율', '세액', '비고'], (r.value?.lines ?? []).map((l) => [cell(`(${l.no})`), cell(l.label), cell(l.amount, true), cell(l.rate ?? ''), cell(l.tax, true), cell(l.handled ? '' : '다루지 않음')])), `부가세신고서_${periodLabel.value}.csv`)
}
const summaryCsv = (s: Summary | null) => csvBlob(['사업자등록번호', '상호', '구분', '매수', '공급가액', '세액'], (s?.rows ?? []).map((x) => [cell(x.tax_id), cell(x.partner_name), cell(x.electronic ? '승인번호 있음' : '승인번호 없음'), cell(x.sheets, true), cell(x.amount, true), cell(x.tax, true)]))
const registerCsv = () => csvBlob(['일자', '증빙일', '번호', '구분', '증빙', '거래처', '사업자등록번호', '승인번호', '공급가액', '세액', '합계', '칸'], (register.data.value ?? []).map((x) => {
  const s = Number(x.sign)
  return [cell(x.date), cell(x.invoice_date), cell(x.number), cell(x.move_type), cell(EVIDENCE[String(x.evidence_type)] ?? '미분류'), cell(x.partner_name), cell(x.partner_tax_id), cell(x.approval_no), cell(Number(x.amount) * s, true), cell(Number(x.tax) * s, true), cell(Number(x.total) * s, true), cell((x.cells ?? []).join(' '))]
}))
// What a tax accountant asks for. The journal comes along only if the books are on, read as any screen would read them.
async function exportBundle() {
  try {
    const files = [
      { name: '매입매출장.csv', text: await registerCsv().text() },
      { name: '매출처별_세금계산서합계표.csv', text: await summaryCsv(sale.data.value).text() },
      { name: '매입처별_세금계산서합계표.csv', text: await summaryCsv(purchase.data.value).text() },
    ]
    if (catalogOf('journal_entry') && r.value) {
      const journal = await readRows<State>(db().from('erp_gl_lines').select('date,move_id,account_id,partner_id,name,debit,credit').gte('date', r.value.from).lte('date', r.value.to).order('date').order('event_seq'))
      const names = await readRows<{ id: string; name: string }>(db().from('erp_records').select('id,name').eq('type', 'account'))
      const nameOf = new Map(names.map((n) => [n.id, n.name]))
      files.push({ name: '분개장.csv', text: await csvBlob(['일자', '계정', '적요', '차변', '대변'], journal.map((j) => [cell(j.date), cell(nameOf.get(String(j.account_id)) ?? j.account_id), cell(j.name), cell(j.debit, true), cell(j.credit, true)])).text() })
    }
    saveBlob(makeZip(files), `세무사자료_${periodLabel.value}.zip`)
  } catch (e) {
    toast(messageOf(e), 'error')
  }
}
const nudge = () => { nudgeBus(); setTimeout(reload, 800) }
</script>

<template>
  <div class="page" data-testid="vat">
    <div class="page-head">
      <h1>부가세 신고</h1>
      <span class="pill pill-amber" data-testid="vat-review">전문가 검수 전</span>
      <div class="grow"></div>
      <button type="button" class="btn" :disabled="!r" data-testid="vat-csv" @click="exportReturn"><Icon name="download" :size="13" />옮겨 적을 값</button>
      <button type="button" class="btn" :disabled="!r" data-testid="vat-bundle" @click="exportBundle"><Icon name="download" :size="13" />세무사 자료 묶음</button>
      <button v-if="r && !r.filed && !writeBlock" type="button" class="btn btn-primary" :disabled="closing" data-testid="vat-file" @click="file"><Icon name="lock" :size="13" />신고 마감</button>
      <button v-if="r?.filed && isAdmin() && !writeBlock" type="button" class="btn" data-testid="vat-reopen" @click="reopen">마감 풀기</button>
    </div>
    <div class="toolbar chip-row">
      <label class="field-inline">연도 <input v-model.number="year" class="input" type="number" style="width: 84px" data-testid="vat-year" /></label>
      <button v-for="t in [1, 2]" :key="t" type="button" class="toggle" :class="{ on: term === t }" :aria-pressed="term === t" data-testid="vat-term" :data-term="t" @click="term = t">제{{ t }}기</button>
      <button v-for="k in (['preliminary', 'final'] as const)" :key="k" type="button" class="toggle" :class="{ on: kind === k }" :aria-pressed="kind === k" data-testid="vat-kind" :data-kind="k" @click="kind = k">{{ k === 'preliminary' ? '예정' : '확정' }}</button>
      <span v-if="r" class="small dim" data-testid="vat-period">{{ r.from }} ~ {{ r.to }} · 기한 {{ r.due }}</span>
      <span class="pill" :class="`pill-${STATE[periodState]?.color}`" data-testid="vat-state">{{ STATE[periodState]?.label }}</span>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert" data-testid="vat-error"><Icon name="alert" /><span class="grow">{{ error }}</span></div>
    <LoadError :message="report.error.value" @retry="reload" />
    <div class="page-body report-pad">
      <div class="banner banner-warn" data-testid="vat-notice"><Icon name="info" /><span>{{ r?.review ?? '전문가 검수 전입니다. 신고의 책임은 회사에 있습니다.' }} 일반과세자만 다룹니다. 전자신고 파일은 만들지 않습니다. 홈택스에 직접 옮겨 적으세요.</span></div>
      <template v-if="r">
        <div v-if="r.pending" class="banner banner-warn" data-testid="vat-pending"><Icon name="refresh" /><span class="grow">아직 집계하지 못한 전표가 있습니다.</span><button type="button" class="btn btn-sm" @click="nudge">다시 보기</button></div>
        <div v-if="r.stuck" class="banner banner-error" data-testid="vat-stuck"><Icon name="alert" /><span>집계가 멈췄습니다: {{ r.stuck }}</span></div>
        <div v-if="r.filed" class="banner banner-ok" data-testid="vat-filed">
          <Icon name="check" /><span class="grow">{{ fmtDay(r.filed.at) }} 에 마감했습니다.</span>
          <label class="check small"><input v-model="asFiled" type="checkbox" data-testid="vat-as-filed" />마감 시점으로 보기</label>
        </div>
        <div v-if="r.unclassified.length" class="banner banner-error" data-testid="vat-unclassified">
          <Icon name="alert" /><span>증빙이 없어 칸을 정하지 못한 전표 {{ r.unclassified.length }}건은 어느 칸에도 들어가지 않았습니다. 전표에서 증빙을 적으세요.
            <router-link v-for="u in r.unclassified" :key="u.id" :to="{ name: 'record', params: { type: 'account_move', id: u.id } }" class="vat-link" data-testid="vat-unclassified-doc">{{ u.number }}</router-link></span>
        </div>
        <div v-if="r.exceptions.date_outside.length" class="banner banner-warn" data-testid="vat-date-outside"><Icon name="alert" /><span>증빙 일자가 이 기간 밖인 전표가 있습니다(예정신고 누락분 후보, 직접 확인): {{ r.exceptions.date_outside.map((x) => x.number).join(', ') }}</span></div>
        <div v-if="r.exceptions.missing_tax_id.length" class="banner banner-warn" data-testid="vat-missing-tax-id"><Icon name="alert" /><span>사업자등록번호가 없는 세금계산서 거래처: {{ r.exceptions.missing_tax_id.map((x) => x.partner_name).join(', ') }}</span></div>

        <div class="stat-row">
          <div class="stat"><span class="stat-label">매출세액 ㉮</span><span class="stat-value" data-testid="vat-ga">{{ fmtMoney(r.totals.ga) }}</span></div>
          <div class="stat"><span class="stat-label">매입세액 ㉯</span><span class="stat-value" data-testid="vat-na">{{ fmtMoney(r.totals.na) }}</span></div>
          <div class="stat"><span class="stat-label">납부(환급)세액 ㉰</span><span class="stat-value" data-testid="vat-da">{{ fmtMoney(r.totals.da) }}</span></div>
          <div class="stat"><span class="stat-label">차감 후 (30)*</span><span class="stat-value" data-testid="vat-payable">{{ fmtMoney(r.totals.payable) }}</span></div>
        </div>
        <p class="hint">* 예정신고 미환급세액만 뺀 값입니다. 경감·공제, 예정고지, 가산세는 넣지 않았습니다.<span v-if="r.totals.payable > 0 && Number(r.totals.payable_rounded) !== Number(r.totals.payable)" data-testid="vat-rounded"> 납부서에는 국고금 끝수 규칙으로 {{ fmtMoney(r.totals.payable_rounded) }} 이 될 수 있습니다.</span></p>

        <div class="toolbar chip-row" style="margin-top: 8px">
          <button v-for="t in ([['return', '신고서'], ['sale', '매출처별 합계표'], ['purchase', '매입처별 합계표'], ['card', '신용카드 수령 명세'], ['register', '매입매출장']] as const)" :key="t[0]" type="button" class="toggle" :class="{ on: tab === t[0] }" data-testid="vat-tab" :data-tab="t[0]" @click="tab = t[0]">{{ t[1] }}</button>
        </div>

        <section v-if="tab === 'return'" class="report-section" data-testid="vat-return">
          <p class="muted small">{{ r.form }}. 금액이 있는 줄을 누르면 그 전표가 나옵니다.</p>
          <div class="scroll-x">
            <table class="tbl vat-table">
              <template v-for="g in grouped" :key="g.group">
                <thead><tr><th colspan="2">{{ g.group }}</th><th class="num">금액</th><th>세율</th><th class="num">세액</th></tr></thead>
                <tbody>
                  <template v-for="l in g.lines" :key="l.no">
                    <tr data-testid="vat-line" :data-no="l.no" :class="{ 'vat-sum': l.sum, 'vat-off': !l.handled, 'vat-open': opensDocs(l) }" @click="opensDocs(l) && open(l.no)">
                      <td class="muted" style="width: 46px">({{ l.no }})</td>
                      <td>{{ l.label }} <span v-if="l.mark" class="muted">{{ l.mark }}</span></td>
                      <template v-if="l.handled">
                        <td class="num" data-testid="vat-amount">{{ l.no === '23' ? '' : fmtMoney(l.amount) }}</td><td class="muted">{{ l.rate }}</td><td class="num" data-testid="vat-tax">{{ fmtMoney(l.tax) }}<span v-if="l.rate_tax !== null && l.rate_tax !== undefined && Number(l.rate_tax) !== Number(l.tax)" class="muted small" data-testid="vat-rate-tax"> (금액×세율 {{ fmtMoney(l.rate_tax) }})</span></td>
                      </template>
                      <td v-else colspan="3" class="muted small" data-testid="vat-off">다루지 않음</td>
                    </tr>
                    <tr v-if="opened === l.no" data-testid="vat-docs"><td colspan="5">
                      <table class="tbl">
                        <thead><tr><th>칸</th><th>번호</th><th>일자</th><th>증빙</th><th>거래처</th><th>승인번호</th><th class="num">금액</th><th class="num">세액</th></tr></thead>
                        <tbody><tr v-for="(e, i) in entries" :key="i" data-testid="vat-doc" :data-number="e.number"><td class="muted">({{ e.cell }})</td><td><router-link :to="{ name: 'record', params: { type: 'account_move', id: e.id } }" data-testid="vat-doc-link">{{ e.number }}</router-link></td><td>{{ e.date }}</td><td>{{ EVIDENCE[e.evidence_type] ?? '' }}</td><td>{{ e.partner_name }}</td><td class="muted">{{ e.approval_no }}</td><td class="num">{{ fmtMoney(e.amount) }}</td><td class="num">{{ fmtMoney(e.tax) }}</td></tr></tbody>
                      </table>
                      <EmptyState v-if="!entries.length" title="이 칸의 전표가 없습니다" />
                    </td></tr>
                  </template>
                </tbody>
              </template>
            </table>
          </div>
          <p v-if="r.no_cell.count" class="small dim" style="margin-top: 6px" data-testid="vat-no-cell">신고서에 칸이 없는 전표(불공제 카드, 그 밖의 영수증) {{ r.no_cell.count }}건, 금액 {{ fmtMoney(r.no_cell.amount) }}, 세액 {{ fmtMoney(r.no_cell.tax) }}. <a href="#" data-testid="vat-no-cell-open" @click.prevent="open('no_cell')">보기</a></p>
          <table v-if="opened === 'no_cell'" class="tbl" data-testid="vat-docs"><tbody><tr v-for="(e, i) in entries" :key="i"><td><router-link :to="{ name: 'record', params: { type: 'account_move', id: e.id } }">{{ e.number }}</router-link></td><td>{{ e.partner_name }}</td><td class="num">{{ fmtMoney(e.amount) }}</td><td class="num">{{ fmtMoney(e.tax) }}</td></tr></tbody></table>
          <details class="small dim" style="margin-top: 8px" data-testid="vat-not-handled"><summary>다루지 않는 칸 {{ notHandled.length }}개</summary><p>{{ notHandled.map((l) => `(${l.no}) ${l.label}`).join(', ') }}. 해당되면 홈택스에서 직접 넣고 세무 전문가와 확인하세요.</p></details>
        </section>

        <section v-for="s in (['sale', 'purchase'] as const)" v-show="tab === s" :key="s" class="report-section" :data-testid="`vat-summary-${s}`">
          <template v-if="(s === 'sale' ? sale : purchase).data.value">
            <p class="muted small">{{ (s === 'sale' ? sale : purchase).data.value?.form }}. 승인번호가 있으면 전자 발급으로 봅니다. 다음 달 11일까지 전송됐는지는 앱이 알 수 없습니다. 주민등록번호 발급분은 다루지 않습니다.</p>
            <table class="tbl">
              <thead><tr><th>구분</th><th class="num">거래처 수</th><th class="num">매수</th><th class="num">공급가액</th><th class="num">세액</th></tr></thead>
              <tbody>
                <tr v-for="row in ([['합계', 'total'], ['승인번호 있음(전자)', 'electronic'], ['그 밖의 발급분', 'other']] as const)" :key="row[1]" data-testid="vat-summary-part" :data-part="row[1]"><td>{{ row[0] }}</td><td class="num">{{ (s === 'sale' ? sale : purchase).data.value?.[row[1]].partners }}</td><td class="num">{{ (s === 'sale' ? sale : purchase).data.value?.[row[1]].sheets }}</td><td class="num">{{ fmtMoney((s === 'sale' ? sale : purchase).data.value?.[row[1]].amount) }}</td><td class="num">{{ fmtMoney((s === 'sale' ? sale : purchase).data.value?.[row[1]].tax) }}</td></tr>
              </tbody>
            </table>
            <table class="tbl" style="margin-top: 8px">
              <thead><tr><th>사업자등록번호</th><th>상호</th><th>구분</th><th class="num">매수</th><th class="num">공급가액</th><th class="num">세액</th></tr></thead>
              <tbody><tr v-for="(x, i) in (s === 'sale' ? sale : purchase).data.value?.rows" :key="i" data-testid="vat-summary-row" :data-tax-id="x.tax_id"><td>{{ x.tax_id }}</td><td>{{ x.partner_name }}</td><td class="muted small">{{ x.electronic ? '전자' : '그 밖' }}</td><td class="num">{{ x.sheets }}</td><td class="num">{{ fmtMoney(x.amount) }}</td><td class="num">{{ fmtMoney(x.tax) }}</td></tr></tbody>
            </table>
          </template>
        </section>

        <section v-if="tab === 'card' && card.data.value" class="report-section" data-testid="vat-card">
          <p class="muted small">{{ card.data.value.form }}. 화물운전자복지카드는 다루지 않습니다. 카드번호는 저장하지 않으니 옮겨 적을 때 채우세요.</p>
          <table class="tbl">
            <thead><tr><th>구분</th><th class="num">거래건수</th><th class="num">공급가액</th><th class="num">세액</th></tr></thead>
            <tbody>
              <tr v-for="row in ([['④ 합계', 'total'], ['⑤ 현금영수증', 'cash_receipt'], ['⑦ 사업용 신용카드', 'business'], ['⑧ 그 밖의 신용카드', 'other']] as const)" :key="row[1]" data-testid="vat-card-part" :data-part="row[1]"><td>{{ row[0] }}</td><td class="num">{{ card.data.value[row[1]].count }}</td><td class="num">{{ fmtMoney(card.data.value[row[1]].amount) }}</td><td class="num">{{ fmtMoney(card.data.value[row[1]].tax) }}</td></tr>
            </tbody>
          </table>
          <table v-if="card.data.value.other_rows.length" class="tbl" style="margin-top: 8px">
            <thead><tr><th>가맹점 사업자등록번호</th><th>상호</th><th class="num">건수</th><th class="num">공급가액</th><th class="num">세액</th></tr></thead>
            <tbody><tr v-for="(x, i) in card.data.value.other_rows" :key="i"><td>{{ x.tax_id }}</td><td>{{ x.partner_name }}</td><td class="num">{{ x.count }}</td><td class="num">{{ fmtMoney(x.amount) }}</td><td class="num">{{ fmtMoney(x.tax) }}</td></tr></tbody>
          </table>
        </section>

        <section v-if="tab === 'register'" class="report-section" data-testid="vat-register">
          <div class="scroll-x">
            <table class="tbl">
              <thead><tr><th>일자</th><th>번호</th><th>증빙</th><th>거래처</th><th>승인번호</th><th class="num">공급가액</th><th class="num">세액</th><th>칸</th></tr></thead>
              <tbody><tr v-for="x in register.data.value ?? []" :key="String(x.id)" data-testid="vat-register-row"><td>{{ x.date }}</td><td><router-link :to="{ name: 'record', params: { type: 'account_move', id: String(x.id) } }">{{ x.number }}</router-link></td><td>{{ EVIDENCE[String(x.evidence_type)] ?? '미분류' }}</td><td>{{ x.partner_name }}</td><td class="muted">{{ x.approval_no }}</td><td class="num">{{ fmtMoney(Number(x.amount) * Number(x.sign)) }}</td><td class="num">{{ fmtMoney(Number(x.tax) * Number(x.sign)) }}</td><td class="muted small">{{ (x.cells ?? []).join(' ') }}</td></tr></tbody>
            </table>
          </div>
          <EmptyState v-if="!register.data.value?.length" title="이 기간의 전표가 없습니다" />
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.vat-table .vat-sum td { font-weight: 600; }
.vat-table .vat-off td { color: var(--ink-400); }
.vat-table .vat-open { cursor: pointer; }
.vat-table .vat-open:hover td { background: var(--ink-50); }
.vat-link { margin-left: 6px; }
</style>

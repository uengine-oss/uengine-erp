<script setup lang="ts">
// The figures of the withholding return for a month paid, one sheet per month earned, as the form asks. Nothing is filed from here:
// a person copies these to Hometax and Wetax, and closing the month leaves that it happened and with what.
import { computed, ref, watch } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { sendCommand } from '../../lib/commands'
import { fmtDay, fmtMoney, fmtNumber } from '../../lib/format'
import { useLoad } from '../../lib/load'
import { timeView, writeBlock } from '../../lib/mode'
import type { State } from '../../lib/types'
import { ask, csvBlob, saveBlob, toast } from '../../lib/ui'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'
import LoadError from '../../components/LoadError.vue'
import { kindLabel } from './payroll'

interface Line { code: string; label: string; people: number; gross: number; income_tax: number; rural_tax: number; penalty: number; runs?: State[] }
interface Sheet { period_month: string; pay_month: string; lines: Line[]; total: Line; local: { label: string; people: number; base: number; tax: number } }
interface Report { pay_month: string; sheets: Sheet[]; filing: State | null; drafts: number }

const month = ref(fmtDay(new Date().toISOString()).slice(0, 7))
const report = useLoad(() => rpc<Report>('erp_withholding_report', { p_pay_month: month.value }))
watch(month, () => { if (month.value) void report.load() }, { immediate: true })
const open = ref('')
const error = ref('')
const canWrite = computed(() => !writeBlock.value)
const filed = computed(() => report.data.value?.filing?.state === 'filed')
const previous = computed(() => (report.data.value?.filing?.previous_sheets ?? null) as Sheet[] | null)

async function file() {
  const answer = await ask({
    title: `${month.value} 지급분 마감`,
    message: '지금 숫자로 마감합니다. 그 뒤에는 이 지급 월의 대장을 확정하거나 정정할 수 없습니다. 앱은 어디에도 전송하지 않습니다. 홈택스와 위택스에는 회사가 신고합니다.',
    confirmLabel: '마감', cancelLabel: '닫기',
  })
  if (!answer) return
  error.value = ''
  try {
    await sendCommand({ type: 'withholding_filing', command: 'create', payload: { pay_month: month.value } })
    toast('마감했습니다.')
    await report.load()
  } catch (e) {
    error.value = messageOf(e)
  }
}

async function reopen() {
  const id = report.data.value?.filing?.id
  const answer = await ask({
    title: '마감 해제',
    message: '해제한 사실과 사유가 남습니다. 신고한 값이 달라지면 수정신고가 필요합니다. 이 앱은 수정신고서를 만들지 않습니다.',
    danger: true, reason: true, reasonRequired: true, confirmLabel: '해제', cancelLabel: '닫기',
  })
  if (!answer) return
  error.value = ''
  try {
    await sendCommand({ type: 'withholding_filing', id, command: 'reopen', reason: answer.reason })
    await report.load()
  } catch (e) {
    error.value = messageOf(e)
  }
}

function exportCsv() {
  const rows = (report.data.value?.sheets ?? []).flatMap((s) => [...s.lines, s.total].map((l) => [
    { value: s.period_month, numeric: false }, { value: s.pay_month, numeric: false }, { value: l.code, numeric: false }, { value: l.label, numeric: false },
    { value: l.people, numeric: true }, { value: l.gross, numeric: true }, { value: l.income_tax, numeric: true }, { value: 0, numeric: true }, { value: 0, numeric: true },
  ]).concat([[
    { value: s.period_month, numeric: false }, { value: s.pay_month, numeric: false }, { value: '지방소득세', numeric: false }, { value: s.local.label, numeric: false },
    { value: s.local.people, numeric: true }, { value: s.local.base, numeric: true }, { value: s.local.tax, numeric: true }, { value: 0, numeric: true }, { value: 0, numeric: true },
  ]]))
  saveBlob(csvBlob(['귀속연월', '지급연월', '코드', '소득 구분', '인원', '총지급액·과세표준', '소득세 등·지방소득세', '농어촌특별세', '가산세'], rows), `원천세_${month.value}.csv`)
}
</script>

<template>
  <div class="page" data-testid="withholding">
    <div class="page-head"><h1>원천세</h1><span v-if="filed" class="pill pill-green" data-testid="withholding-state">마감 {{ report.data.value?.filing?.revision }}회차</span><span v-else-if="report.data.value?.filing" class="pill pill-amber" data-testid="withholding-state">마감 해제</span></div>
    <p class="banner banner-warn banner-flush small" data-testid="withholding-note"><Icon name="alert" /><span>전문가 검수 전입니다. 신고 책임은 회사에 있습니다. 전자신고 파일을 만들지 않고, 옮겨 적을 값을 내보냅니다. <strong>연말정산은 다루지 않습니다.</strong> 근로소득 외의 소득, 환급 조정, 수정신고 세액은 이 화면에 없습니다.</span></p>
    <div class="toolbar">
      <label class="small dim" for="wh-month">지급 월</label>
      <input id="wh-month" v-model="month" class="input" type="month" style="width: 160px" data-testid="withholding-month" />
      <button type="button" class="btn" :disabled="!report.data.value?.sheets.length" data-testid="withholding-export" @click="exportCsv"><Icon name="download" :size="13" /> 옮겨 적을 값 내보내기</button>
      <button v-if="!filed" type="button" class="btn btn-primary" :disabled="!canWrite || !report.data.value?.sheets.length" data-testid="withholding-file" @click="file">이 달 마감</button>
      <button v-else type="button" class="btn" :disabled="!canWrite" data-testid="withholding-reopen" @click="reopen">마감 해제</button>
    </div>
    <p v-if="timeView.at" class="small dim" data-testid="withholding-now" style="padding: 0 16px">시점 보기와 상관없이 지금 값입니다. 그때 마감한 값은 마감 기록의 이력에 있습니다.</p>
    <p v-if="error" class="err-text small" role="alert" data-testid="withholding-error" style="padding: 0 16px">{{ error }}</p>
    <LoadError v-if="report.error.value" :message="report.error.value" @retry="report.load" />
    <div class="page-body page-pad">
      <p v-if="report.data.value?.drafts" class="banner banner-warn small" data-testid="withholding-drafts"><Icon name="alert" /><span>이 지급 월에 초안 대장 {{ report.data.value.drafts }}건이 있습니다. 초안은 집계에 들어가지 않습니다.</span></p>
      <EmptyState v-if="report.data.value && !report.data.value.sheets.length" title="이 지급 월에 확정한 대장이 없습니다" text="대장을 확정하면 지급일의 달로 집계합니다." />
      <section v-for="s in report.data.value?.sheets" :key="s.period_month" class="panel" data-testid="withholding-sheet" :data-period="s.period_month">
        <h2>귀속 {{ s.period_month }} · 지급 {{ s.pay_month }}</h2>
        <p class="small dim">귀속 월이 다르면 서식을 따로 작성합니다(별지 제21호서식 작성방법).</p>
        <div class="scroll-x">
          <table class="tbl" data-testid="withholding-form">
            <thead><tr><th>소득 구분</th><th>코드</th><th class="num">④ 인원</th><th class="num">⑤ 총지급액</th><th class="num">⑥ 소득세 등</th><th class="num">⑦ 농어촌특별세</th><th class="num">⑧ 가산세</th></tr></thead>
            <tbody>
              <template v-for="l in s.lines" :key="l.code">
                <tr class="clickable" data-testid="withholding-line" :data-code="l.code" @click="open = open === s.period_month + l.code ? '' : s.period_month + l.code">
                  <td>{{ l.label }} <Icon :name="open === s.period_month + l.code ? 'chevron-down' : 'chevron-right'" :size="11" /></td><td>{{ l.code }}</td><td class="num" data-col="people">{{ fmtNumber(l.people) }}</td><td class="num" data-col="gross">{{ fmtMoney(l.gross) }}</td><td class="num" data-col="income_tax">{{ fmtMoney(l.income_tax) }}</td><td class="num">0</td><td class="num">0</td>
                </tr>
                <tr v-if="open === s.period_month + l.code" data-testid="withholding-runs"><td colspan="7">
                  <ul class="runs small">
                    <li v-for="r in l.runs" :key="r.id" data-testid="withholding-run">
                      <router-link :to="{ name: 'record', params: { type: 'payroll_run', id: r.id } }">{{ r.number }}</router-link> {{ kindLabel(r.kind) }} · {{ fmtNumber(r.people) }}명 · 총지급 {{ fmtMoney(r.gross) }} · 소득세 {{ fmtMoney(r.income_tax) }}
                    </li>
                  </ul>
                </td></tr>
              </template>
            </tbody>
            <tfoot><tr data-testid="withholding-total"><th>{{ s.total.label }}</th><td>{{ s.total.code }}</td><td class="num" data-col="people">{{ fmtNumber(s.total.people) }}</td><td class="num" data-col="gross">{{ fmtMoney(s.total.gross) }}</td><td class="num" data-col="income_tax">{{ fmtMoney(s.total.income_tax) }}</td><td class="num">0</td><td class="num">0</td></tr></tfoot>
          </table>
        </div>
        <h3>지방소득세 특별징수</h3>
        <table class="tbl" data-testid="withholding-local">
          <thead><tr><th>구분</th><th class="num">인원</th><th class="num">과세표준(원천징수 소득세)</th><th class="num">지방소득세</th></tr></thead>
          <tbody><tr><td>{{ s.local.label }}</td><td class="num">{{ fmtNumber(s.local.people) }}</td><td class="num" data-col="base">{{ fmtMoney(s.local.base) }}</td><td class="num" data-col="tax">{{ fmtMoney(s.local.tax) }}</td></tr></tbody>
        </table>
        <p class="small dim">사람별로 10원 미만을 버린 금액의 합입니다. 근무지가 여러 지방자치단체이면 나누는 것은 회사의 일입니다.</p>
      </section>
      <section v-if="previous" class="panel" data-testid="withholding-previous">
        <h2>이전 회차에 마감한 값</h2>
        <p class="small dim">신고한 값이 달라졌다면 수정신고 대상일 수 있습니다. 세무 전문가에게 확인하세요.</p>
        <table class="tbl">
          <thead><tr><th>귀속 월</th><th class="num">인원</th><th class="num">총지급액</th><th class="num">소득세 등</th><th class="num">지방소득세</th></tr></thead>
          <tbody><tr v-for="p in previous" :key="p.period_month" data-testid="withholding-previous-row"><td>{{ p.period_month }}</td><td class="num">{{ fmtNumber(p.total.people) }}</td><td class="num">{{ fmtMoney(p.total.gross) }}</td><td class="num" data-col="income_tax">{{ fmtMoney(p.total.income_tax) }}</td><td class="num">{{ fmtMoney(p.local.tax) }}</td></tr></tbody>
        </table>
      </section>
    </div>
  </div>
</template>

<style scoped>
.panel { padding: 12px 14px; margin-bottom: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); max-width: 860px; }
.panel h2 { margin-bottom: 4px; }
.panel h3 { margin: 12px 0 6px; font-size: 13px; }
.clickable { cursor: pointer; }
.runs { margin: 0; padding: 0; list-style: none; }
</style>

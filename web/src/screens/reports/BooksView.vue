<script setup lang="ts">
// The three statements. Dates are the business dates on the entries. All the sums are the database's.
import { computed, onMounted, ref, watch } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { fmtDay, fmtMoney } from '../../lib/format'
import { timeView } from '../../lib/mode'
import { onLedgerEvent } from '../../lib/realtime'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'

const props = defineProps<{ report: 'trial-balance' | 'profit-loss' | 'balance-sheet' }>()

interface Amount { account_id: string; code: string; name: string; amount: number }
interface Trial { rows: { account_id: string; code: string; name: string; account_type: string; opening: number; debit: number; credit: number; closing: number }[]; totals: { opening: number; debit: number; credit: number; closing: number } }
interface Pnl { income: Amount[]; expense: Amount[]; total_income: number; total_expense: number; net_income: number }
interface Sheet { assets: Amount[]; liabilities: Amount[]; equity: Amount[]; current_earnings: number; total_assets: number; total_liabilities: number; total_equity: number }

const TITLES = { 'trial-balance': '시산표', 'profit-loss': '손익계산서', 'balance-sheet': '재무상태표' }
const title = computed(() => TITLES[props.report])

const today = () => timeView.date || fmtDay(new Date().toISOString())
const from = ref(`${today().slice(0, 4)}-01-01`)
const to = ref(today())
const data = ref<unknown>(null)
const loading = ref(true)
const error = ref('')
let seq = 0

async function load() {
  const my = ++seq
  error.value = ''
  loading.value = true
  try {
    const res = props.report === 'balance-sheet'
      ? await rpc('erp_balance_sheet', { p_at: to.value || null })
      : await rpc(props.report === 'trial-balance' ? 'erp_trial_balance' : 'erp_profit_loss', { p_from: from.value || null, p_to: to.value || null })
    if (my === seq) data.value = res
  } catch (e) {
    if (my === seq) { data.value = null; error.value = messageOf(e) }
  } finally {
    if (my === seq) loading.value = false
  }
}
onMounted(load)
watch(() => [props.report, from.value, to.value], load)
watch(() => timeView.date, () => { to.value = today(); from.value = `${to.value.slice(0, 4)}-01-01` })
let timer: ReturnType<typeof setTimeout> | undefined
onLedgerEvent((ev) => { if ((ev.data?.effects as Record<string, unknown> | undefined)?.gl) { clearTimeout(timer); timer = setTimeout(load, 500) } })

const trial = computed(() => (props.report === 'trial-balance' ? (data.value as Trial | null) : null))
const pnl = computed(() => (props.report === 'profit-loss' ? (data.value as Pnl | null) : null))
const sheet = computed(() => (props.report === 'balance-sheet' ? (data.value as Sheet | null) : null))
const balanced = computed(() => (trial.value ? Math.abs(trial.value.totals.debit - trial.value.totals.credit) < 0.005 : true))
const liabilityEquity = computed(() => (sheet.value ? sheet.value.total_liabilities + sheet.value.total_equity : 0))
const isEmpty = computed(() => (trial.value ? !trial.value.rows.length : pnl.value ? !pnl.value.income.length && !pnl.value.expense.length : sheet.value ? !sheet.value.assets.length && !sheet.value.liabilities.length && !sheet.value.equity.length : false))
</script>

<template>
  <div class="page" :data-testid="report">
    <div class="page-head"><h1>{{ title }}</h1></div>
    <div class="toolbar">
      <template v-if="report !== 'balance-sheet'">
        <input v-model="from" class="input" type="date" style="width: 130px" aria-label="시작일" data-testid="books-from" /><span class="muted">~</span>
      </template>
      <span v-else class="small dim">기준일</span>
      <input v-model="to" class="input" type="date" style="width: 130px" :aria-label="report === 'balance-sheet' ? '기준일' : '종료일'" data-testid="books-to" />
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert" data-testid="books-error"><Icon name="alert" /><span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" @click="load">다시 시도</button></div>
    <div class="page-body" style="background: var(--surface)">
      <EmptyState v-if="data && isEmpty && !loading" title="이 기간의 전표가 없습니다" text="청구서를 게시하거나 입출고를 처리하면 회계 모듈이 전표를 만듭니다." />

      <template v-else-if="trial">
        <p class="check-line small" :class="balanced ? 'ok' : 'bad'" data-testid="trial-balanced"><Icon :name="balanced ? 'check' : 'alert'" :size="13" />{{ balanced ? '차변과 대변이 맞습니다.' : '차변과 대변이 맞지 않습니다.' }}</p>
        <table class="tbl" data-testid="trial-table">
          <thead><tr><th style="width: 80px">코드</th><th>계정</th><th class="num">기초</th><th class="num">차변</th><th class="num">대변</th><th class="num">기말</th></tr></thead>
          <tbody><tr v-for="r in trial.rows" :key="r.account_id" class="clickable" tabindex="0" data-testid="trial-row" :data-code="r.code" @click="$router.push({ name: 'general-ledger', params: { account: r.account_id }, query: { from: from || undefined, to: to || undefined } })" @keydown.enter="$router.push({ name: 'general-ledger', params: { account: r.account_id }, query: { from: from || undefined, to: to || undefined } })">
            <td>{{ r.code }}</td><td>{{ r.name }}</td><td class="num">{{ fmtMoney(r.opening) }}</td><td class="num">{{ fmtMoney(r.debit) }}</td><td class="num">{{ fmtMoney(r.credit) }}</td><td class="num">{{ fmtMoney(r.closing) }}</td>
          </tr></tbody>
          <tfoot><tr class="foot"><td colspan="2">합계</td><td class="num">{{ fmtMoney(trial.totals.opening) }}</td><td class="num" data-testid="trial-debit">{{ fmtMoney(trial.totals.debit) }}</td><td class="num" data-testid="trial-credit">{{ fmtMoney(trial.totals.credit) }}</td><td class="num">{{ fmtMoney(trial.totals.closing) }}</td></tr></tfoot>
        </table>
      </template>

      <table v-else-if="pnl" class="tbl statement" data-testid="pnl-table">
        <tbody>
          <tr class="group"><td colspan="2">수익</td></tr>
          <tr v-for="r in pnl.income" :key="r.account_id"><td class="indent">{{ r.code }} {{ r.name }}</td><td class="num">{{ fmtMoney(r.amount) }}</td></tr>
          <tr class="foot"><td>수익 합계</td><td class="num" data-testid="pnl-income">{{ fmtMoney(pnl.total_income) }}</td></tr>
          <tr class="group"><td colspan="2">비용</td></tr>
          <tr v-for="r in pnl.expense" :key="r.account_id"><td class="indent">{{ r.code }} {{ r.name }}</td><td class="num">{{ fmtMoney(r.amount) }}</td></tr>
          <tr class="foot"><td>비용 합계</td><td class="num" data-testid="pnl-expense">{{ fmtMoney(pnl.total_expense) }}</td></tr>
          <tr class="net"><td>순이익</td><td class="num" data-testid="pnl-net">{{ fmtMoney(pnl.net_income) }}</td></tr>
        </tbody>
      </table>

      <table v-else-if="sheet" class="tbl statement" data-testid="sheet-table">
        <tbody>
          <tr class="group"><td colspan="2">자산</td></tr>
          <tr v-for="r in sheet.assets" :key="r.account_id"><td class="indent">{{ r.code }} {{ r.name }}</td><td class="num">{{ fmtMoney(r.amount) }}</td></tr>
          <tr class="foot"><td>자산 합계</td><td class="num" data-testid="sheet-assets">{{ fmtMoney(sheet.total_assets) }}</td></tr>
          <tr class="group"><td colspan="2">부채</td></tr>
          <tr v-for="r in sheet.liabilities" :key="r.account_id"><td class="indent">{{ r.code }} {{ r.name }}</td><td class="num">{{ fmtMoney(r.amount) }}</td></tr>
          <tr class="foot"><td>부채 합계</td><td class="num">{{ fmtMoney(sheet.total_liabilities) }}</td></tr>
          <tr class="group"><td colspan="2">자본</td></tr>
          <tr v-for="r in sheet.equity" :key="r.account_id"><td class="indent">{{ r.code }} {{ r.name }}</td><td class="num">{{ fmtMoney(r.amount) }}</td></tr>
          <tr><td class="indent">아직 자본으로 옮기지 않은 손익</td><td class="num">{{ fmtMoney(sheet.current_earnings) }}</td></tr>
          <tr class="foot"><td>자본 합계</td><td class="num">{{ fmtMoney(sheet.total_equity) }}</td></tr>
          <tr class="net"><td>부채와 자본 합계</td><td class="num" data-testid="sheet-liabilities-equity">{{ fmtMoney(liabilityEquity) }}</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.check-line { display: flex; align-items: center; gap: 6px; padding: 6px 16px; border-bottom: 1px solid var(--line); }
.ok { color: var(--green-fg); }
.bad { color: var(--red-fg); font-weight: 600; }
.foot td { font-weight: 650; border-top: 1px solid var(--line-strong); }
.statement { max-width: 640px; }
.group td { padding-top: 10px; font-weight: 650; color: var(--text-2); border-bottom: 0; }
.indent { padding-left: 24px; }
.net td { font-size: 14px; font-weight: 650; border-top: 2px solid var(--line-strong); }
</style>

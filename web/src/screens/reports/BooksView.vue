<script setup lang="ts">
// The three statements. Dates are the business dates on the entries. All the sums are the database's.
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { messageOf, rpc } from '../../lib/api'
import { fmtDay, fmtMoney } from '../../lib/format'
import { timeView } from '../../lib/mode'
import { onLedgerEvent } from '../../lib/realtime'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'
import ReviewNotice from '../../components/ReviewNotice.vue'

const props = defineProps<{ report: 'trial-balance' | 'profit-loss' | 'balance-sheet' }>()
const router = useRouter()

interface Trial { rows: { account_id: string; code: string; name: string; account_type: string; opening: number; debit: number; credit: number; closing: number }[]; totals: { opening: number; debit: number; credit: number; closing: number } }
interface FsRow { level: number; kind: string; label: string; amount: number; prior: number; key?: string; account_id?: string; code?: string }
interface Pnl { from: string; to: string; prior_from: string; prior_to: string; rows: FsRow[]; sales: number; net_income: number }
interface Sheet { at: string; prior_at: string; rows: FsRow[]; total_assets: number; total_liabilities: number; total_equity: number; balanced: boolean }

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
      ? await rpc('erp_financial_position', { p_at: to.value || null })
      : props.report === 'profit-loss'
        ? await rpc('erp_income_statement', { p_from: from.value || null, p_to: to.value || null })
        : await rpc('erp_trial_balance', { p_from: from.value || null, p_to: to.value || null })
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
const statement = computed<FsRow[]>(() => pnl.value?.rows ?? sheet.value?.rows ?? [])
const isEmpty = computed(() => (trial.value ? !trial.value.rows.length : statement.value.length ? !statement.value.some((r) => r.kind === 'account' || r.kind === 'earnings' || r.kind === 'link') : false))
// The figures other screens and tests point at, whatever the statement's own labels are.
const TESTIDS: Record<string, string> = { sales: 'pnl-income', net_income: 'pnl-net', total_assets: 'sheet-assets', total_liabilities_equity: 'sheet-liabilities-equity', total_liabilities: 'sheet-liabilities', total_equity: 'sheet-equity' }
const period = computed(() => (pnl.value ? { now: `${pnl.value.from} ~ ${pnl.value.to}`, prior: `${pnl.value.prior_from} ~ ${pnl.value.prior_to}` } : sheet.value ? { now: `${sheet.value.at} 현재`, prior: `${sheet.value.prior_at} 현재` } : null))
const open = (r: FsRow) => { if (r.account_id) void router.push({ name: 'general-ledger', params: { account: r.account_id }, query: { from: pnl.value?.from || undefined, to: pnl.value?.to ?? sheet.value?.at } }) }
const goManufacturing = () => router.push({ name: 'cost-statement', query: { from: from.value || undefined, to: to.value || undefined } })
</script>

<template>
  <div class="page" :data-testid="report">
    <div class="page-head"><h1>{{ title }}</h1></div>
    <ReviewNotice v-if="report !== 'trial-balance'" />
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

      <div v-else-if="statement.length" class="scroll-x">
        <p v-if="sheet" class="check-line small" :class="sheet.balanced ? 'ok' : 'bad'" data-testid="sheet-balanced"><Icon :name="sheet.balanced ? 'check' : 'alert'" :size="13" />{{ sheet.balanced ? '자산과 부채·자본 합계가 맞습니다.' : '자산과 부채·자본 합계가 맞지 않습니다.' }}</p>
        <table class="tbl statement" :data-testid="pnl ? 'pnl-table' : 'sheet-table'">
          <thead><tr><th>과목</th><th class="num">당기<div class="small dim" data-testid="fs-period">{{ period?.now }}</div></th><th class="num">전기<div class="small dim" data-testid="fs-prior-period">{{ period?.prior }}</div></th></tr></thead>
          <tbody>
            <tr v-for="(r, i) in statement" :key="`${r.label}-${i}`" :class="[`lv${r.level}`, r.kind, { clickable: r.account_id || r.key === 'manufacturing' }]" data-testid="fs-row" :data-key="r.key" :data-kind="r.kind" :tabindex="r.account_id ? 0 : undefined" @click="r.key === 'manufacturing' ? goManufacturing() : open(r)" @keydown.enter="open(r)">
              <td>{{ r.label }}</td>
              <td class="num" :data-testid="r.key && TESTIDS[r.key] ? TESTIDS[r.key] : undefined">{{ r.kind === 'head' ? '' : fmtMoney(r.amount) }}</td>
              <td class="num" data-testid="fs-prior">{{ r.kind === 'head' ? '' : fmtMoney(r.prior) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="pnl" class="small dim note" data-testid="pnl-note">매출원가는 재고 모듈이 잡은 원가를 그대로 보여 줍니다. 그래서 양식의 기초·기말 재고 칸이 없습니다. 사업연도는 달력 연도로 봅니다.</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.check-line { display: flex; align-items: center; gap: 6px; padding: 6px 16px; border-bottom: 1px solid var(--line); }
.ok { color: var(--green-fg); }
.bad { color: var(--red-fg); font-weight: 600; }
.foot td { font-weight: 650; border-top: 1px solid var(--line-strong); }
.statement { max-width: 760px; }
.head td { padding-top: 12px; font-weight: 650; color: var(--text-2); border-bottom: 0; }
.lv0.section td, .lv1 td { font-weight: 650; }
.lv2 td:first-child { padding-left: 24px; font-weight: 550; }
.lv3 td:first-child { padding-left: 40px; }
.total td { font-weight: 650; border-top: 1px solid var(--line-strong); }
.note { padding: 8px 16px; max-width: 760px; }
</style>

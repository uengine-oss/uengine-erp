<script setup lang="ts">
// The year-end steps in order, each showing its entry before it is booked. Depreciation belongs to the asset module, so it
// is asked for only when that module is on. Accounting itself never hears of assets except through what they publish.
import { computed, ref, watch } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { onDataChanged, sendCommand } from '../../lib/commands'
import { fmtDay, fmtMoney } from '../../lib/format'
import { useLoad } from '../../lib/load'
import { timeView, writeBlock } from '../../lib/mode'
import { catalogOf, isAdmin, loadCompany } from '../../lib/session'
import { COMPANY_ID } from '../../lib/types'
import { ask, toast } from '../../lib/ui'
import Icon from '../../components/Icon.vue'
import LoadError from '../../components/LoadError.vue'
import ReviewNotice from '../../components/ReviewNotice.vue'

interface EntryRow { account_id: string; code: string; name: string; debit: number; credit: number }
interface Status {
  year: number; from: string; to: string; locked: string | null; lock_date_all: string | null; closed_later: number | null
  close: { id: string; number: string; state: string; net_income: number } | null
  transfer: { rows: EntryRow[]; net_income: number; unclosed_before: number; total_debit: number; total_credit: number }
  bad_debt: { state: string; reason: string | null; receivable: number; prior_receivable: number; write_offs: number; rate: number | null; estimate: number | null; allowance: number; amount: number | null; entry: EntryRow[] }
  inventory: { state: string; reason: string; in_transit: number }
}
interface RunPreview { through: string; total: number; locked: string | null; active_assets: number; lines: { asset_name: string; from_month: string; to_month: string; amount: number }[]; entry: EntryRow[] }

const year = ref(Number((timeView.date || fmtDay(new Date().toISOString())).slice(0, 4)))
const hasAssets = computed(() => !!catalogOf('asset'))
const { data, error, load } = useLoad(async () => {
  const [status, run] = await Promise.all([
    rpc<Status>('erp_closing_status', { p_year: year.value }),
    hasAssets.value ? rpc<RunPreview>('erp_depreciation_preview', { p_through: `${year.value}-12-31` }) : Promise.resolve(null),
  ])
  return { status, run }
})
watch(year, load, { immediate: true })
onDataChanged(() => { void load() })
const s = computed(() => data.value?.status ?? null)
const run = computed(() => data.value?.run ?? null)
const busy = ref(false)
const failure = ref('')
const canWrite = computed(() => !writeBlock.value && !busy.value && !s.value?.locked)
const closed = computed(() => s.value?.close?.state === 'closed')
const canLock = computed(() => isAdmin() && !writeBlock.value && !busy.value && !!s.value && (s.value.lock_date_all ?? '') < s.value.to && closed.value)

async function act(fn: () => Promise<void>, done: string) {
  busy.value = true
  failure.value = ''
  try {
    await fn()
    toast(done)
    await load()
  } catch (e) {
    failure.value = messageOf(e)
  } finally {
    busy.value = false
  }
}
const runDepreciation = () => act(async () => { await sendCommand({ type: 'depreciation_run', command: 'create', payload: { through: `${year.value}-12-31` } }) }, '감가상각을 실행했습니다.')
const bookBadDebt = () => act(async () => {
  await sendCommand({ type: 'journal_entry', command: 'create', payload: { date: s.value!.to, ref: `대손 추정 ${year.value}`, post: true, lines: s.value!.bad_debt.entry.map((e) => ({ account_id: e.account_id, name: '대손 추정', debit: e.debit, credit: e.credit })) } })
}, '대손 추정 전표를 게시했습니다.')
const closeYear = () => act(async () => { await sendCommand({ type: 'fiscal_close', command: 'create', payload: { year: year.value } }) }, '손익을 옮겼습니다.')
async function reopen() {
  const answer = await ask({ title: '결산 취소', message: `${year.value}년 손익 대체를 취소합니다. 수익과 비용 잔액이 그대로 돌아옵니다.`, confirmLabel: '결산 취소', danger: true })
  if (!answer) return
  await act(async () => { await sendCommand({ type: 'fiscal_close', id: s.value!.close!.id, command: 'reopen' }) }, '결산을 취소했습니다.')
}
async function lockYear() {
  const answer = await ask({ title: '이 연도 잠그기', message: `전체 잠금일을 ${s.value!.to} 로 정합니다. 이 날짜까지의 문서와 전표는 게시하거나 되돌릴 수 없습니다. 결산 취소도 잠금을 푼 뒤에만 됩니다.`, confirmLabel: '잠그기', danger: true })
  if (!answer) return
  await act(async () => {
    await sendCommand({ type: 'company', id: COMPANY_ID, command: 'update', payload: { lock_date_all: s.value!.to } })
    await loadCompany()
  }, '잠금일을 정했습니다.')
}
</script>

<template>
  <div class="page" data-testid="closing">
    <div class="page-head"><h1>결산</h1></div>
    <ReviewNotice />
    <div class="toolbar row-wrap">
      <label class="field-inline">사업연도 <input v-model.number="year" class="input" type="number" style="width: 84px" data-testid="closing-year" /></label>
      <span v-if="s" class="small dim">{{ s.from }} ~ {{ s.to }}. 사업연도는 달력 연도로 봅니다.</span>
    </div>
    <LoadError :message="error" @retry="load" />
    <div v-if="failure" class="banner banner-error banner-flush" role="alert" data-testid="closing-error"><Icon name="alert" /><span class="grow">{{ failure }}</span></div>
    <div v-if="s?.locked" class="banner banner-flush" data-testid="closing-locked"><Icon name="lock" /><span class="grow">{{ s.locked }}</span></div>
    <div v-if="s" class="page-body report-pad steps">

      <section class="step" data-testid="step-depreciation">
        <h2><span class="num-badge">1</span> 감가상각 반영</h2>
        <template v-if="!hasAssets"><p class="dim" data-testid="dep-off">고정자산 모듈이 꺼져 있습니다. 자산이 있으면 모듈을 켜거나 수동 전표로 넣으세요.</p></template>
        <template v-else-if="run">
          <p v-if="!run.lines.length" class="dim" data-testid="dep-done">{{ s.to }} 까지 더 상각할 금액이 없습니다. 상각 중인 자산 {{ run.active_assets }}건.</p>
          <template v-else>
            <p class="dim">아직 상각하지 않은 달을 모아 {{ s.to }} 자로 한 번에 잡습니다.</p>
            <div class="scroll-x">
              <table class="tbl" data-testid="dep-lines">
                <thead><tr><th>자산</th><th>기간</th><th class="num">감가상각비</th></tr></thead>
                <tbody><tr v-for="l in run.lines" :key="l.asset_name" data-testid="dep-line"><td>{{ l.asset_name }}</td><td>{{ l.from_month }} ~ {{ l.to_month }}</td><td class="num">{{ fmtMoney(l.amount) }}</td></tr></tbody>
                <tfoot><tr class="foot"><td colspan="2">합계</td><td class="num" data-testid="dep-total">{{ fmtMoney(run.total) }}</td></tr></tfoot>
              </table>
            </div>
            <div class="scroll-x"><table class="tbl entry" data-testid="dep-entry"><thead><tr><th>이 실행이 만들 전표</th><th class="num">차변</th><th class="num">대변</th></tr></thead><tbody><tr v-for="e in run.entry" :key="e.account_id"><td>{{ e.code }} {{ e.name }}</td><td class="num">{{ fmtMoney(e.debit) }}</td><td class="num">{{ fmtMoney(e.credit) }}</td></tr></tbody></table></div>
            <button type="button" class="btn btn-primary" :disabled="!canWrite" data-testid="dep-run" @click="runDepreciation">감가상각 실행</button>
          </template>
        </template>
      </section>

      <section class="step" data-testid="step-bad-debt">
        <h2><span class="num-badge">2</span> 대손 추정</h2>
        <p v-if="s.bad_debt.state !== 'ready'" class="dim" data-testid="bad-debt-skipped">넣지 않았습니다. {{ s.bad_debt.reason }}</p>
        <template v-else>
          <p class="dim" data-testid="bad-debt-basis">올해 대손 {{ fmtMoney(s.bad_debt.write_offs) }} ÷ 작년 말 외상매출금 {{ fmtMoney(s.bad_debt.prior_receivable) }} = {{ ((s.bad_debt.rate ?? 0) * 100).toFixed(2) }}%. 올해 말 외상매출금 {{ fmtMoney(s.bad_debt.receivable) }} 에 곱한 {{ fmtMoney(s.bad_debt.estimate) }} 에서 충당금 잔액 {{ fmtMoney(s.bad_debt.allowance) }} 을 뺍니다.</p>
          <div class="scroll-x"><table class="tbl entry" data-testid="bad-debt-entry"><thead><tr><th>이 추정이 만들 전표</th><th class="num">차변</th><th class="num">대변</th></tr></thead><tbody><tr v-for="e in s.bad_debt.entry" :key="e.account_id"><td>{{ e.code }} {{ e.name }}</td><td class="num">{{ fmtMoney(e.debit) }}</td><td class="num">{{ fmtMoney(e.credit) }}</td></tr></tbody></table></div>
          <button type="button" class="btn" :disabled="!canWrite" data-testid="bad-debt-book" @click="bookBadDebt">대손 추정 전표 게시</button>
        </template>
      </section>

      <section class="step" data-testid="step-inventory">
        <h2><span class="num-badge">3</span> 기말 재고 정리</h2>
        <p class="dim" data-testid="inventory-skipped">{{ s.inventory.reason }}</p>
        <p v-if="s.inventory.in_transit" class="small dim" data-testid="in-transit">미착품 잔액이 {{ fmtMoney(s.inventory.in_transit) }} 남아 있습니다. 입고 원가와 청구 단가의 차이일 수 있으니 확인하세요.</p>
      </section>

      <section class="step" data-testid="step-transfer">
        <h2><span class="num-badge">4</span> 손익 대체</h2>
        <p v-if="s.closed_later" class="dim" data-testid="closed-later">{{ s.closed_later }}년 결산이 남아 있어 이 해를 바꿀 수 없습니다. 그 결산을 먼저 취소하세요.</p>
        <p v-if="closed" class="ok-line" data-testid="closed-state"><Icon name="check" :size="13" /> {{ s.close?.number }}. 손익 {{ fmtMoney(s.close?.net_income) }} 을 이월이익잉여금으로 옮겼습니다.</p>
        <template v-if="s.transfer.rows.length">
          <p class="dim">올해 손익 {{ fmtMoney(s.transfer.net_income) }}<template v-if="s.transfer.unclosed_before">, 지난해까지 옮기지 않은 손익 {{ fmtMoney(s.transfer.unclosed_before) }} 도 함께</template> 이월이익잉여금으로 옮깁니다. 전표 날짜는 {{ s.to }} 입니다.</p>
          <div class="scroll-x">
            <table class="tbl entry" data-testid="transfer-entry">
              <thead><tr><th>이 대체가 만들 전표</th><th class="num">차변</th><th class="num">대변</th></tr></thead>
              <tbody><tr v-for="e in s.transfer.rows" :key="e.account_id" data-testid="transfer-row"><td>{{ e.code }} {{ e.name }}</td><td class="num">{{ fmtMoney(e.debit) }}</td><td class="num">{{ fmtMoney(e.credit) }}</td></tr></tbody>
              <tfoot><tr class="foot"><td>합계</td><td class="num" data-testid="transfer-debit">{{ fmtMoney(s.transfer.total_debit) }}</td><td class="num" data-testid="transfer-credit">{{ fmtMoney(s.transfer.total_credit) }}</td></tr></tfoot>
            </table>
          </div>
          <button type="button" class="btn btn-primary" :disabled="!canWrite || !!s.closed_later" data-testid="transfer-run" @click="closeYear">손익 대체 실행</button>
        </template>
        <p v-else-if="!closed" class="dim" data-testid="transfer-empty">옮길 손익이 없습니다.</p>
        <button v-if="closed" type="button" class="btn" :disabled="!canWrite || !!s.closed_later" data-testid="transfer-reopen" @click="reopen">결산 취소</button>
      </section>

      <section class="step" data-testid="step-lock">
        <h2><span class="num-badge">5</span> 잠그기</h2>
        <p class="dim">결산이 끝나면 숫자가 움직이지 않게 잠급니다. 지금 전체 잠금일은 <strong data-testid="lock-date">{{ s.lock_date_all ?? '없음' }}</strong> 입니다. 잠근 뒤에는 결산을 취소하거나 전표를 되돌릴 수 없습니다.</p>
        <button v-if="isAdmin()" type="button" class="btn" :disabled="!canLock" data-testid="lock-year" @click="lockYear"><Icon name="lock" :size="13" />{{ s.to }} 까지 잠그기</button>
        <p v-else class="small muted">잠금은 관리자가 합니다.</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.steps { display: flex; flex-direction: column; gap: 12px; max-width: 820px; }
.step { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 12px 14px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
.step h2 { display: flex; align-items: center; gap: 8px; }
.num-badge { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 50%; background: var(--navy-700); color: #fff; font-size: 12px; }
.step .scroll-x { align-self: stretch; }
.entry { max-width: 620px; }
.foot td { font-weight: 650; border-top: 1px solid var(--line-strong); }
.ok-line { display: flex; align-items: center; gap: 6px; color: var(--green-fg); }
</style>

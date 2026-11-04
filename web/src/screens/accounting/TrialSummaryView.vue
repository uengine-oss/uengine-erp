<script setup lang="ts">
// Trial balance of totals and balances, before the year-end transfer unless asked otherwise.
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { rpc } from '../../lib/api'
import { onDataChanged } from '../../lib/commands'
import { fmtDay, fmtMoney } from '../../lib/format'
import { useLoad } from '../../lib/load'
import { timeView } from '../../lib/mode'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'
import LoadError from '../../components/LoadError.vue'
import ReviewNotice from '../../components/ReviewNotice.vue'

interface Row { account_id: string | null; code: string | null; name: string; debit_balance: number; debit_total: number; credit_total: number; credit_balance: number; prior_balance: number }
interface Report { from: string; to: string; prior_from: string; prior_to: string; rows: Row[]; totals: { debit_balance: number; debit_total: number; credit_total: number; credit_balance: number } }

const today = () => timeView.date || fmtDay(new Date().toISOString())
const from = ref(`${today().slice(0, 4)}-01-01`)
const to = ref(today())
const after = ref(false)
const { data, loading, error, load } = useLoad(() => rpc<Report>('erp_trial_summary', { p_from: from.value || null, p_to: to.value || null, p_after_closing: after.value }))
watch([from, to, after], load, { immediate: true })
onDataChanged(() => { void load() })
const rows = computed(() => data.value?.rows ?? [])
const balanced = computed(() => !!data.value && data.value.totals.debit_total === data.value.totals.credit_total && data.value.totals.debit_balance === data.value.totals.credit_balance)
const router = useRouter()
const open = (r: Row) => { if (r.account_id) void router.push({ name: 'general-ledger', params: { account: r.account_id }, query: { from: from.value || undefined, to: to.value || undefined } }) }
</script>

<template>
  <div class="page" data-testid="trial-summary">
    <div class="page-head"><h1>합계잔액시산표</h1></div>
    <ReviewNotice />
    <div class="toolbar row-wrap">
      <label class="field-inline">부터 <input v-model="from" class="input" type="date" data-testid="ts-from" /></label>
      <label class="field-inline">까지 <input v-model="to" class="input" type="date" data-testid="ts-to" /></label>
      <label class="check small dim"><input v-model="after" type="checkbox" data-testid="ts-after" /> 손익 대체 후</label>
    </div>
    <LoadError :message="error" @retry="load" />
    <div v-if="data" class="page-body" style="background: var(--surface)">
      <p class="check-line small" :class="balanced ? 'ok' : 'bad'" data-testid="ts-balanced"><Icon :name="balanced ? 'check' : 'alert'" :size="13" />{{ balanced ? '차변과 대변이 맞습니다.' : '차변과 대변이 맞지 않습니다.' }}</p>
      <div class="scroll-x">
        <table v-if="rows.length" class="tbl" data-testid="ts-table">
          <thead><tr><th class="num">차변 잔액</th><th class="num">차변 합계</th><th>계정</th><th class="num">대변 합계</th><th class="num">대변 잔액</th><th class="num">전기 같은 날 잔액</th></tr></thead>
          <tbody><tr v-for="r in rows" :key="r.account_id ?? r.name" :class="{ clickable: r.account_id }" data-testid="ts-row" :data-code="r.code" :tabindex="r.account_id ? 0 : undefined" @click="open(r)" @keydown.enter="open(r)"><td class="num">{{ fmtMoney(r.debit_balance) }}</td><td class="num">{{ fmtMoney(r.debit_total) }}</td><td>{{ r.code }} {{ r.name }}</td><td class="num">{{ fmtMoney(r.credit_total) }}</td><td class="num">{{ fmtMoney(r.credit_balance) }}</td><td class="num">{{ fmtMoney(r.prior_balance) }}</td></tr></tbody>
          <tfoot><tr class="foot"><td class="num" data-testid="ts-debit-balance">{{ fmtMoney(data.totals.debit_balance) }}</td><td class="num" data-testid="ts-debit-total">{{ fmtMoney(data.totals.debit_total) }}</td><td>합계</td><td class="num" data-testid="ts-credit-total">{{ fmtMoney(data.totals.credit_total) }}</td><td class="num" data-testid="ts-credit-balance">{{ fmtMoney(data.totals.credit_balance) }}</td><td></td></tr></tfoot>
        </table>
        <EmptyState v-else-if="!loading" title="이 기간의 전표가 없습니다" />
      </div>
      <p class="small dim note">재무상태표 계정은 잔액을 이월하고, 손익 계정은 이 기간 것만 더합니다. 전기 잔액은 차변이 양수입니다. 전기는 {{ data.prior_from }} ~ {{ data.prior_to }} 입니다.</p>
    </div>
  </div>
</template>

<style scoped>
.check-line { display: flex; align-items: center; gap: 6px; padding: 6px 16px; border-bottom: 1px solid var(--line); }
.ok { color: var(--green-fg); }
.bad { color: var(--red-fg); font-weight: 600; }
.foot td { font-weight: 650; border-top: 1px solid var(--line-strong); }
.note { padding: 8px 16px; }
</style>

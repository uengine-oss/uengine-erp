<script setup lang="ts">
// Cash in and out with a running balance. The same stretch of last year is one line at the top.
import { computed, ref, watch } from 'vue'
import { rpc } from '../../lib/api'
import { onDataChanged } from '../../lib/commands'
import { fmtDay, fmtMoney } from '../../lib/format'
import { useLoad } from '../../lib/load'
import { timeView } from '../../lib/mode'
import EmptyState from '../../components/EmptyState.vue'
import LoadError from '../../components/LoadError.vue'
import ReviewNotice from '../../components/ReviewNotice.vue'

interface Row { date: string; number: string | null; name: string | null; move_id: string; partner_name: string | null; counter: string | null; in: number; out: number; balance: number }
interface Report { from: string; to: string; prior_from: string; prior_to: string; account_id: string; account: string; accounts: { id: string; code: string; name: string }[]; opening: number; closing: number; total_in: number; total_out: number; rows: Row[]; prior: { in: number; out: number; closing: number } }

const today = () => timeView.date || fmtDay(new Date().toISOString())
const from = ref(`${today().slice(0, 7)}-01`)
const to = ref(today())
const account = ref('')
const { data, loading, error, load } = useLoad(() => rpc<Report>('erp_cash_book', { p_from: from.value || null, p_to: to.value || null, p_account: account.value || null }))
watch([from, to, account], load, { immediate: true })
onDataChanged(() => { void load() })
const rows = computed(() => data.value?.rows ?? [])
</script>

<template>
  <div class="page" data-testid="cash-book">
    <div class="page-head"><h1>현금출납장</h1></div>
    <ReviewNotice />
    <div class="toolbar row-wrap">
      <label class="field-inline">계정
        <select v-model="account" class="select" data-testid="cash-account"><option value="">현금</option><option v-for="a in (data?.accounts ?? []).filter((x) => x.name !== '현금')" :key="a.id" :value="a.id">{{ a.name }}</option></select>
      </label>
      <label class="field-inline">부터 <input v-model="from" class="input" type="date" data-testid="cash-from" /></label>
      <label class="field-inline">까지 <input v-model="to" class="input" type="date" data-testid="cash-to" /></label>
    </div>
    <LoadError :message="error" @retry="load" />
    <div v-if="data" class="page-body report-pad">
      <div class="stat-row">
        <div class="stat"><span class="stat-label">이월</span><span class="stat-value" data-testid="cash-opening">{{ fmtMoney(data.opening) }}</span></div>
        <div class="stat"><span class="stat-label">입금</span><span class="stat-value" data-testid="cash-in">{{ fmtMoney(data.total_in) }}</span><span class="small dim">전기 {{ fmtMoney(data.prior.in) }}</span></div>
        <div class="stat"><span class="stat-label">출금</span><span class="stat-value" data-testid="cash-out">{{ fmtMoney(data.total_out) }}</span><span class="small dim">전기 {{ fmtMoney(data.prior.out) }}</span></div>
        <div class="stat"><span class="stat-label">잔액</span><span class="stat-value" data-testid="cash-closing">{{ fmtMoney(data.closing) }}</span><span class="small dim" data-testid="cash-prior-closing">전기 {{ fmtMoney(data.prior.closing) }}</span></div>
      </div>
      <p class="small dim" style="margin-top: 6px">전기는 {{ data.prior_from }} ~ {{ data.prior_to }} 입니다.</p>
      <div class="scroll-x" style="margin-top: 10px">
        <table v-if="rows.length" class="tbl" data-testid="cash-table">
          <thead><tr><th>일자</th><th>번호</th><th>적요</th><th>거래처</th><th>상대 계정</th><th class="num">입금</th><th class="num">출금</th><th class="num">잔액</th></tr></thead>
          <tbody><tr v-for="(r, i) in rows" :key="i" data-testid="cash-row"><td>{{ r.date }}</td><td>{{ r.number }}</td><td>{{ r.name }}</td><td>{{ r.partner_name }}</td><td>{{ r.counter }}</td><td class="num">{{ fmtMoney(r.in) }}</td><td class="num">{{ fmtMoney(r.out) }}</td><td class="num">{{ fmtMoney(r.balance) }}</td></tr></tbody>
        </table>
        <EmptyState v-else-if="!loading" :title="`이 기간에 ${data.account} 거래가 없습니다`" />
      </div>
    </div>
  </div>
</template>

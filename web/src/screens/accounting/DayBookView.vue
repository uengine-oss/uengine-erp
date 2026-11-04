<script setup lang="ts">
// Daily and monthly summaries: the same report over a day or a month, cash split from what moved no cash.
import { computed, ref, watch } from 'vue'
import { rpc } from '../../lib/api'
import { onDataChanged } from '../../lib/commands'
import { fmtDay, fmtMoney } from '../../lib/format'
import { thisMonth, useLoad } from '../../lib/load'
import { timeView } from '../../lib/mode'
import EmptyState from '../../components/EmptyState.vue'
import LoadError from '../../components/LoadError.vue'
import ReviewNotice from '../../components/ReviewNotice.vue'

interface Row { account_id: string; code: string; name: string; debit_total: number; debit_transfer: number; debit_cash: number; credit_cash: number; credit_transfer: number; credit_total: number; prior_debit: number; prior_credit: number }
type Totals = Omit<Row, 'account_id' | 'code' | 'name'>
interface Report { from: string; to: string; prior_from: string; prior_to: string; rows: Row[]; totals: Totals; opening_cash: number; closing_cash: number }

const today = () => timeView.date || fmtDay(new Date().toISOString())
const grain = ref<'day' | 'month'>('day')
const day = ref(today())
const month = ref(today().slice(0, 7))
const range = computed(() => (grain.value === 'day' ? { from: day.value, to: day.value } : thisMonth(`${month.value || today().slice(0, 7)}-01`)))
const { data, loading, error, load } = useLoad(() => rpc<Report>('erp_day_book', { p_from: range.value.from || null, p_to: range.value.to || null }))
watch(range, load, { immediate: true })
onDataChanged(() => { void load() })
const rows = computed(() => data.value?.rows ?? [])
const debitCol = computed(() => (data.value ? data.value.totals.debit_cash + data.value.closing_cash : 0))
const creditCol = computed(() => (data.value ? data.value.totals.credit_cash + data.value.opening_cash : 0))
</script>

<template>
  <div class="page" data-testid="day-book">
    <div class="page-head"><h1>{{ grain === 'day' ? '일계표' : '월계표' }}</h1></div>
    <ReviewNotice />
    <div class="toolbar row-wrap">
      <div class="seg" role="group" aria-label="단위">
        <button type="button" :class="{ on: grain === 'day' }" :aria-pressed="grain === 'day'" data-testid="dayb-day" @click="grain = 'day'">일계표</button>
        <button type="button" :class="{ on: grain === 'month' }" :aria-pressed="grain === 'month'" data-testid="dayb-month" @click="grain = 'month'">월계표</button>
      </div>
      <input v-if="grain === 'day'" v-model="day" class="input" type="date" style="width: 150px" aria-label="일자" data-testid="dayb-date" />
      <input v-else v-model="month" class="input" type="month" style="width: 150px" aria-label="월" data-testid="dayb-month-input" />
    </div>
    <LoadError :message="error" @retry="load" />
    <div v-if="data" class="page-body report-pad">
      <div class="scroll-x">
        <table v-if="rows.length" class="tbl day-tbl" data-testid="dayb-table">
          <thead>
            <tr><th colspan="3" class="side">차변</th><th rowspan="2" class="mid">계정</th><th colspan="3" class="side">대변</th><th colspan="2" class="side">전기 같은 기간</th></tr>
            <tr><th class="num">계</th><th class="num">대체</th><th class="num">현금</th><th class="num">현금</th><th class="num">대체</th><th class="num">계</th><th class="num">차변</th><th class="num">대변</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.account_id" data-testid="dayb-row" :data-code="r.code"><td class="num">{{ fmtMoney(r.debit_total) }}</td><td class="num">{{ fmtMoney(r.debit_transfer) }}</td><td class="num">{{ fmtMoney(r.debit_cash) }}</td><td class="mid">{{ r.name }}</td><td class="num">{{ fmtMoney(r.credit_cash) }}</td><td class="num">{{ fmtMoney(r.credit_transfer) }}</td><td class="num">{{ fmtMoney(r.credit_total) }}</td><td class="num">{{ fmtMoney(r.prior_debit) }}</td><td class="num">{{ fmtMoney(r.prior_credit) }}</td></tr>
          </tbody>
          <tfoot>
            <tr class="foot" data-testid="dayb-subtotal"><td class="num">{{ fmtMoney(data.totals.debit_total) }}</td><td class="num">{{ fmtMoney(data.totals.debit_transfer) }}</td><td class="num">{{ fmtMoney(data.totals.debit_cash) }}</td><td class="mid">소계</td><td class="num">{{ fmtMoney(data.totals.credit_cash) }}</td><td class="num">{{ fmtMoney(data.totals.credit_transfer) }}</td><td class="num">{{ fmtMoney(data.totals.credit_total) }}</td><td class="num">{{ fmtMoney(data.totals.prior_debit) }}</td><td class="num">{{ fmtMoney(data.totals.prior_credit) }}</td></tr>
            <tr><td></td><td></td><td class="num" data-testid="dayb-closing">{{ fmtMoney(data.closing_cash) }}</td><td class="mid">현금 잔액(차변: 기말, 대변: 기초)</td><td class="num" data-testid="dayb-opening">{{ fmtMoney(data.opening_cash) }}</td><td></td><td></td><td></td><td></td></tr>
            <tr class="foot"><td></td><td></td><td class="num" data-testid="dayb-debit-col">{{ fmtMoney(debitCol) }}</td><td class="mid">합계</td><td class="num" data-testid="dayb-credit-col">{{ fmtMoney(creditCol) }}</td><td></td><td></td><td></td><td></td></tr>
          </tfoot>
        </table>
        <EmptyState v-else-if="!loading" title="이 기간의 전표가 없습니다" />
      </div>
      <p class="small dim" style="margin-top: 8px">현금 칸은 현금 계정(코드 101)과 맞은편으로 잡힌 금액이고, 그 밖은 대체입니다. 손익 대체 전표는 넣지 않습니다. 전기는 {{ data.prior_from }} ~ {{ data.prior_to }} 입니다.</p>
    </div>
  </div>
</template>

<style scoped>
.side { text-align: center; }
.mid { text-align: center; white-space: nowrap; }
.foot td { font-weight: 650; border-top: 1px solid var(--line-strong); }
</style>

<script setup lang="ts">
// What each partner owes or is owed, and line by line for one of them.
import { computed, ref, watch } from 'vue'
import { rpc } from '../../lib/api'
import { onDataChanged } from '../../lib/commands'
import { fmtDay, fmtMoney } from '../../lib/format'
import { useLoad } from '../../lib/load'
import { timeView } from '../../lib/mode'
import EmptyState from '../../components/EmptyState.vue'
import LoadError from '../../components/LoadError.vue'
import ReviewNotice from '../../components/ReviewNotice.vue'

interface Partner { partner_id: string | null; name: string; opening: number; debit: number; credit: number; closing: number; prior_closing: number }
interface Line { date: string; number: string | null; name: string | null; move_id: string; debit: number; credit: number; balance: number }
interface Report { from: string; to: string; prior_to: string; partners: Partner[]; totals: Omit<Partner, 'partner_id' | 'name'>; opening: number; lines: Line[] }

const today = () => timeView.date || fmtDay(new Date().toISOString())
const kind = ref<'receivable' | 'payable'>('receivable')
const from = ref(`${today().slice(0, 4)}-01-01`)
const to = ref(today())
const picked = ref<string | null>(null)
const { data, loading, error, load } = useLoad(() => rpc<Report>('erp_partner_ledger', { p_kind: kind.value, p_partner: picked.value, p_from: from.value || null, p_to: to.value || null }))
watch([kind, from, to, picked], load, { immediate: true })
watch(kind, () => { picked.value = null })
onDataChanged(() => { void load() })
const partners = computed(() => data.value?.partners ?? [])
const pickedName = computed(() => partners.value.find((p) => p.partner_id === picked.value)?.name)
</script>

<template>
  <div class="page" data-testid="partner-ledger">
    <div class="page-head"><h1>거래처 원장</h1></div>
    <ReviewNotice />
    <div class="toolbar row-wrap">
      <div class="seg" role="group" aria-label="구분">
        <button type="button" :class="{ on: kind === 'receivable' }" :aria-pressed="kind === 'receivable'" data-testid="pl-receivable" @click="kind = 'receivable'">받을 돈</button>
        <button type="button" :class="{ on: kind === 'payable' }" :aria-pressed="kind === 'payable'" data-testid="pl-payable" @click="kind = 'payable'">줄 돈</button>
      </div>
      <label class="field-inline">부터 <input v-model="from" class="input" type="date" data-testid="pl-from" /></label>
      <label class="field-inline">까지 <input v-model="to" class="input" type="date" data-testid="pl-to" /></label>
    </div>
    <LoadError :message="error" @retry="load" />
    <div v-if="data" class="page-body report-pad">
      <section class="report-section">
        <h2>거래처별</h2>
        <div class="scroll-x">
          <table v-if="partners.length" class="tbl" data-testid="pl-partners">
            <thead><tr><th>거래처</th><th class="num">이월</th><th class="num">차변</th><th class="num">대변</th><th class="num">잔액</th><th class="num">전기 같은 날 잔액</th></tr></thead>
            <tbody><tr v-for="p in partners" :key="p.partner_id ?? 'none'" class="clickable" :class="{ on: p.partner_id === picked }" tabindex="0" data-testid="pl-partner" @click="picked = p.partner_id" @keydown.enter="picked = p.partner_id"><td>{{ p.name }}</td><td class="num">{{ fmtMoney(p.opening) }}</td><td class="num">{{ fmtMoney(p.debit) }}</td><td class="num">{{ fmtMoney(p.credit) }}</td><td class="num" data-testid="pl-closing">{{ fmtMoney(p.closing) }}</td><td class="num" data-testid="pl-prior">{{ fmtMoney(p.prior_closing) }}</td></tr></tbody>
            <tfoot><tr class="foot"><td>합계</td><td class="num">{{ fmtMoney(data.totals.opening) }}</td><td class="num">{{ fmtMoney(data.totals.debit) }}</td><td class="num">{{ fmtMoney(data.totals.credit) }}</td><td class="num">{{ fmtMoney(data.totals.closing) }}</td><td class="num">{{ fmtMoney(data.totals.prior_closing) }}</td></tr></tfoot>
          </table>
          <EmptyState v-else-if="!loading" title="이 기간의 거래가 없습니다" />
        </div>
      </section>
      <section v-if="picked" class="report-section" data-testid="pl-detail">
        <h2>{{ pickedName }}</h2>
        <div class="scroll-x">
          <table class="tbl" data-testid="pl-lines">
            <thead><tr><th>일자</th><th>번호</th><th>적요</th><th class="num">차변</th><th class="num">대변</th><th class="num">잔액</th></tr></thead>
            <tbody>
              <tr><td colspan="5" class="dim">이월</td><td class="num" data-testid="pl-opening">{{ fmtMoney(data.opening) }}</td></tr>
              <tr v-for="(l, i) in data.lines" :key="i" data-testid="pl-line"><td>{{ l.date }}</td><td>{{ l.number }}</td><td>{{ l.name }}</td><td class="num">{{ fmtMoney(l.debit) }}</td><td class="num">{{ fmtMoney(l.credit) }}</td><td class="num">{{ fmtMoney(l.balance) }}</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.foot td { font-weight: 650; border-top: 1px solid var(--line-strong); }
tr.on td { background: var(--ink-50); }
</style>

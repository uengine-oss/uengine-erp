<script setup lang="ts">
// Sales and purchases by document, with the same stretch of last year beside the totals.
import { computed, ref, watch } from 'vue'
import { rpc } from '../../lib/api'
import { onDataChanged } from '../../lib/commands'
import { fmtDay, fmtInteger, fmtMoney } from '../../lib/format'
import { useLoad } from '../../lib/load'
import { timeView } from '../../lib/mode'
import { catalogOf } from '../../lib/session'
import EmptyState from '../../components/EmptyState.vue'
import LoadError from '../../components/LoadError.vue'
import ReviewNotice from '../../components/ReviewNotice.vue'

interface Row { date: string; number: string; kind: string; move_type: string; document_id: string; partner_id: string | null; partner_name: string | null; evidence_type: string | null; untaxed: number; tax: number; total: number }
interface Totals { count: number; untaxed: number; tax: number; total: number; prior_count: number; prior_untaxed: number; prior_tax: number; prior_total: number }
interface Report { from: string; to: string; prior_from: string; prior_to: string; rows: Row[]; totals: { sale: Totals; purchase: Totals } }

const today = () => timeView.date || fmtDay(new Date().toISOString())
const from = ref(`${today().slice(0, 4)}-01-01`)
const to = ref(today())
const kind = ref<'' | 'sale' | 'purchase'>('')
const { data, loading, error, load } = useLoad(() => rpc<Report>('erp_sales_purchase_book', { p_from: from.value || null, p_to: to.value || null, p_kind: kind.value || null }))
watch([from, to, kind], load, { immediate: true })
onDataChanged(() => { void load() })
const rows = computed(() => data.value?.rows ?? [])
const KIND: Record<string, string> = { sale: '매출', purchase: '매입' }
const hasEvidence = computed(() => rows.value.some((r) => r.evidence_type))
const evidenceLabel = (v: string | null | undefined) => catalogOf('account_move')?.fields.find((f) => f.name === 'evidence_type')?.options?.find((o) => o.value === v)?.label ?? v ?? ''
</script>

<template>
  <div class="page" data-testid="sales-purchase-book">
    <div class="page-head"><h1>매입매출장</h1></div>
    <ReviewNotice />
    <div class="toolbar row-wrap">
      <label class="field-inline">부터 <input v-model="from" class="input" type="date" data-testid="spb-from" /></label>
      <label class="field-inline">까지 <input v-model="to" class="input" type="date" data-testid="spb-to" /></label>
      <div class="seg" role="group" aria-label="구분">
        <button type="button" :class="{ on: kind === '' }" :aria-pressed="kind === ''" data-testid="spb-all" @click="kind = ''">전체</button>
        <button type="button" :class="{ on: kind === 'sale' }" :aria-pressed="kind === 'sale'" data-testid="spb-sale" @click="kind = 'sale'">매출</button>
        <button type="button" :class="{ on: kind === 'purchase' }" :aria-pressed="kind === 'purchase'" data-testid="spb-purchase" @click="kind = 'purchase'">매입</button>
      </div>
    </div>
    <LoadError :message="error" @retry="load" />
    <div v-if="data" class="page-body report-pad">
      <section class="report-section">
        <h2>합계와 전기 비교</h2>
        <div class="scroll-x">
          <table class="tbl" data-testid="spb-totals">
            <thead><tr><th>구분</th><th class="num">건수</th><th class="num">공급가액</th><th class="num">세액</th><th class="num">합계</th><th class="num">전기 건수</th><th class="num">전기 공급가액</th><th class="num">전기 세액</th><th class="num">전기 합계</th></tr></thead>
            <tbody>
              <tr v-for="k in (['sale', 'purchase'] as const)" :key="k" data-testid="spb-total-row" :data-kind="k"><td>{{ KIND[k] }}</td><td class="num">{{ fmtInteger(data.totals[k].count) }}</td><td class="num" data-testid="spb-untaxed">{{ fmtMoney(data.totals[k].untaxed) }}</td><td class="num">{{ fmtMoney(data.totals[k].tax) }}</td><td class="num">{{ fmtMoney(data.totals[k].total) }}</td><td class="num">{{ fmtInteger(data.totals[k].prior_count) }}</td><td class="num" data-testid="spb-prior-untaxed">{{ fmtMoney(data.totals[k].prior_untaxed) }}</td><td class="num">{{ fmtMoney(data.totals[k].prior_tax) }}</td><td class="num">{{ fmtMoney(data.totals[k].prior_total) }}</td></tr>
            </tbody>
          </table>
        </div>
        <p class="small dim" data-testid="spb-prior-period">전기는 {{ data.prior_from }} ~ {{ data.prior_to }} 입니다.</p>
      </section>
      <section class="report-section">
        <h2>문서별</h2>
        <div class="scroll-x">
          <table v-if="rows.length" class="tbl" data-testid="spb-table">
            <thead><tr><th>일자</th><th>구분</th><th>번호</th><th>거래처</th><th v-if="hasEvidence">증빙</th><th class="num">공급가액</th><th class="num">세액</th><th class="num">합계</th></tr></thead>
            <tbody><tr v-for="r in rows" :key="r.number + r.date" class="clickable" tabindex="0" data-testid="spb-row" @click="$router.push({ name: 'record', params: { type: 'account_move', id: r.document_id } })" @keydown.enter="$router.push({ name: 'record', params: { type: 'account_move', id: r.document_id } })"><td>{{ r.date }}</td><td>{{ KIND[r.kind] }}<span v-if="r.move_type.endsWith('_refund')" class="small dim"> 대변 메모</span></td><td>{{ r.number }}</td><td>{{ r.partner_name }}</td><td v-if="hasEvidence">{{ evidenceLabel(r.evidence_type) }}</td><td class="num">{{ fmtMoney(r.untaxed) }}</td><td class="num">{{ fmtMoney(r.tax) }}</td><td class="num">{{ fmtMoney(r.total) }}</td></tr></tbody>
          </table>
          <EmptyState v-else-if="!loading" title="이 기간에 게시한 청구서가 없습니다" text="청구서를 게시하면 회계 모듈이 전표를 만들고 여기에 나타납니다." />
        </div>
      </section>
    </div>
  </div>
</template>

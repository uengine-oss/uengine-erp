<script setup lang="ts">
// Statement of appropriation of retained earnings, or of the disposition of a deficit when there is nothing to appropriate.
// Appropriation is settled at the following year's meeting, as an ordinary entry. So the figures below follow that entry.
import { computed, ref, watch } from 'vue'
import { rpc } from '../../lib/api'
import { onDataChanged } from '../../lib/commands'
import { fmtDay, fmtMoney } from '../../lib/format'
import { useLoad } from '../../lib/load'
import { timeView } from '../../lib/mode'
import LoadError from '../../components/LoadError.vue'
import ReviewNotice from '../../components/ReviewNotice.vue'

interface Item { code: string; name: string; amount: number; category?: string }
interface Calc { year: number; from: string; to: string; title: string; deficit: boolean; carried: number; policy_change: number; error_correction: number; interim_dividend: number; net_income: number; unclosed_before: number; undistributed: number; transfers_in: Item[]; transfers_in_total: number; appropriations: Item[]; appropriation_total: number; settled_on: string | null; carried_forward: number }
interface Report { year: number; current: Calc; prior: Calc }

const year = ref(Number((timeView.date || fmtDay(new Date().toISOString())).slice(0, 4)))
const { data, error, load } = useLoad(() => rpc<Report>('erp_retained_earnings', { p_year: year.value }))
watch(year, load, { immediate: true })
onDataChanged(() => { void load() })
const CATEGORY: Record<string, string> = { legal_reserve: '이익준비금', other_legal_reserve: '기타법정적립금', discount_amortization: '주식할인발행차금상각액', cash_dividend: '현금배당', stock_dividend: '주식배당', voluntary: '임의적립금 등' }
const appropriations = computed(() => {
  const d = data.value
  if (!d) return []
  const out = new Map<string, { label: string; now: number; prior: number }>()
  for (const a of d.current.appropriations) out.set(a.code, { label: `${CATEGORY[a.category ?? 'voluntary']} (${a.name})`, now: a.amount, prior: 0 })
  for (const a of d.prior.appropriations) { const s = out.get(a.code); if (s) s.prior = a.amount; else out.set(a.code, { label: `${CATEGORY[a.category ?? 'voluntary']} (${a.name})`, now: 0, prior: a.amount }) }
  return [...out.values()]
})
const deficit = computed(() => !!data.value?.current.deficit)
</script>

<template>
  <div class="page" data-testid="retained">
    <div class="page-head"><h1 data-testid="re-title">{{ data?.current.title ?? '이익잉여금처분계산서' }}</h1></div>
    <ReviewNotice />
    <div class="toolbar row-wrap">
      <label class="field-inline">사업연도 <input v-model.number="year" class="input" type="number" style="width: 84px" data-testid="re-year" /></label>
      <span v-if="data" class="small dim" data-testid="re-settled">{{ deficit ? '처리' : '처분' }} 확정일: {{ data.current.settled_on ?? '아직 없음. 다음 해에 이월이익잉여금을 차변으로 전표를 쓰면 여기에 반영됩니다' }}</span>
    </div>
    <LoadError :message="error" @retry="load" />
    <div v-if="data" class="page-body" style="background: var(--surface)">
      <div class="scroll-x">
        <table class="tbl statement" data-testid="re-table">
          <thead><tr><th>과목</th><th class="num">당기<div class="small dim">{{ data.current.from }} ~ {{ data.current.to }}</div></th><th class="num">전기<div class="small dim">{{ data.prior.from }} ~ {{ data.prior.to }}</div></th></tr></thead>
          <tbody>
            <tr class="section" data-testid="re-undistributed"><td>Ⅰ. {{ deficit ? '미처리결손금' : '미처분이익잉여금' }}</td><td class="num">{{ fmtMoney(data.current.undistributed) }}</td><td class="num">{{ fmtMoney(data.prior.undistributed) }}</td></tr>
            <tr><td class="indent">{{ data.current.carried < 0 ? '전기이월미처리결손금' : '전기이월미처분이익잉여금' }}</td><td class="num" data-testid="re-carried">{{ fmtMoney(data.current.carried) }}</td><td class="num">{{ fmtMoney(data.prior.carried) }}</td></tr>
            <tr><td class="indent">회계정책변경누적효과</td><td class="num">-</td><td class="num">-</td></tr>
            <tr><td class="indent">전기오류수정</td><td class="num">-</td><td class="num">-</td></tr>
            <tr><td class="indent">중간배당액</td><td class="num">{{ fmtMoney(data.current.interim_dividend) }}</td><td class="num">{{ fmtMoney(data.prior.interim_dividend) }}</td></tr>
            <tr><td class="indent">{{ data.current.net_income < 0 ? '당기순손실' : '당기순이익' }}</td><td class="num" data-testid="re-net">{{ fmtMoney(data.current.net_income) }}</td><td class="num">{{ fmtMoney(data.prior.net_income) }}</td></tr>
            <tr class="section"><td>Ⅱ. {{ deficit ? '결손금처리액' : '임의적립금 등의 이입액' }}</td><td class="num" data-testid="re-in">{{ fmtMoney(data.current.transfers_in_total) }}</td><td class="num">{{ fmtMoney(data.prior.transfers_in_total) }}</td></tr>
            <tr v-for="t in data.current.transfers_in" :key="t.code"><td class="indent">{{ t.name }}</td><td class="num">{{ fmtMoney(t.amount) }}</td><td class="num"></td></tr>
            <template v-if="!deficit">
              <tr class="total"><td>합계</td><td class="num">{{ fmtMoney(data.current.undistributed + data.current.transfers_in_total) }}</td><td class="num">{{ fmtMoney(data.prior.undistributed + data.prior.transfers_in_total) }}</td></tr>
              <tr class="section"><td>Ⅲ. 이익잉여금처분액</td><td class="num" data-testid="re-appropriated">{{ fmtMoney(data.current.appropriation_total) }}</td><td class="num">{{ fmtMoney(data.prior.appropriation_total) }}</td></tr>
              <tr v-for="a in appropriations" :key="a.label" data-testid="re-item"><td class="indent">{{ a.label }}</td><td class="num">{{ fmtMoney(a.now) }}</td><td class="num">{{ fmtMoney(a.prior) }}</td></tr>
            </template>
            <tr class="net"><td>{{ deficit ? 'Ⅲ. 차기이월미처리결손금' : 'Ⅳ. 차기이월미처분이익잉여금' }}</td><td class="num" data-testid="re-forward">{{ fmtMoney(data.current.carried_forward) }}</td><td class="num">{{ fmtMoney(data.prior.carried_forward) }}</td></tr>
          </tbody>
        </table>
      </div>
      <p v-if="data.current.unclosed_before" class="small dim note" data-testid="re-unclosed">전기이월에는 결산하지 않은 지난 해 손익 {{ fmtMoney(data.current.unclosed_before) }} 이 들어 있습니다.</p>
      <p class="small dim note">회계정책변경 누적효과와 전기오류수정은 아직 따로 잡지 않습니다. 중간배당은 적요에 「중간배당」이 들어간 이월이익잉여금 전표로 알아봅니다.</p>
    </div>
  </div>
</template>

<style scoped>
.statement { max-width: 760px; }
.section td { font-weight: 650; }
.total td { font-weight: 650; border-top: 1px solid var(--line-strong); }
.net td { font-size: 14px; font-weight: 650; border-top: 2px solid var(--line-strong); }
.indent { padding-left: 24px !important; }
.note { padding: 8px 16px; max-width: 760px; }
</style>

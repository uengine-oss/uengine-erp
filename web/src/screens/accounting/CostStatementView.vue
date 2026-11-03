<script setup lang="ts">
// Statement of manufacturing cost, in the order of the statutory form, with the same stretch of last year.
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { rpc } from '../../lib/api'
import { onDataChanged } from '../../lib/commands'
import { fmtDay, fmtMoney } from '../../lib/format'
import { useLoad } from '../../lib/load'
import { timeView } from '../../lib/mode'
import EmptyState from '../../components/EmptyState.vue'
import LoadError from '../../components/LoadError.vue'
import ReviewNotice from '../../components/ReviewNotice.vue'

interface Acc { account_id: string; code: string; name: string; amount: number; grp: string }
interface Figures { accounts: Acc[]; materials: number; labor: number; overhead: number; open_materials: number; close_materials: number; purchases: number; total_manufacturing: number; open_wip: number; close_wip: number; transfer_out: number; cost_of_goods_manufactured: number }
interface Report { from: string; to: string; prior_from: string; prior_to: string; current: Figures; prior: Figures }

const route = useRoute()
const today = () => timeView.date || fmtDay(new Date().toISOString())
const from = ref(String(route.query.from ?? '') || `${today().slice(0, 4)}-01-01`)
const to = ref(String(route.query.to ?? '') || today())
const { data, loading, error, load } = useLoad(() => rpc<Report>('erp_cost_statement', { p_from: from.value || null, p_to: to.value || null }))
watch([from, to], load, { immediate: true })
onDataChanged(() => { void load() })
const accounts = (grp: string) => {
  const d = data.value
  if (!d) return []
  const seen = new Map<string, { name: string; now: number; prior: number }>()
  for (const a of d.current.accounts.filter((x) => x.grp === grp)) seen.set(a.account_id, { name: a.name, now: a.amount, prior: 0 })
  for (const a of d.prior.accounts.filter((x) => x.grp === grp)) { const s = seen.get(a.account_id); if (s) s.prior = a.amount; else seen.set(a.account_id, { name: a.name, now: 0, prior: a.amount }) }
  return [...seen.entries()].map(([id, v]) => ({ id, ...v }))
}
const hasAny = computed(() => !!data.value && (data.value.current.total_manufacturing !== 0 || data.value.prior.total_manufacturing !== 0 || data.value.current.open_wip !== 0 || data.value.current.close_wip !== 0))
</script>

<template>
  <div class="page" data-testid="cost-statement">
    <div class="page-head"><h1>제조원가명세서</h1></div>
    <ReviewNotice />
    <div class="toolbar row-wrap">
      <label class="field-inline">부터 <input v-model="from" class="input" type="date" data-testid="cs-from" /></label>
      <label class="field-inline">까지 <input v-model="to" class="input" type="date" data-testid="cs-to" /></label>
    </div>
    <LoadError :message="error" @retry="load" />
    <div v-if="data" class="page-body" style="background: var(--surface)">
      <div v-if="hasAny" class="scroll-x">
        <table class="tbl statement" data-testid="cs-table">
          <thead><tr><th>과목</th><th class="num">당기<div class="small dim">{{ data.from }} ~ {{ data.to }}</div></th><th class="num">전기<div class="small dim">{{ data.prior_from }} ~ {{ data.prior_to }}</div></th></tr></thead>
          <tbody>
            <tr class="section" data-testid="cs-materials"><td>Ⅰ. 재료비</td><td class="num">{{ fmtMoney(data.current.materials) }}</td><td class="num">{{ fmtMoney(data.prior.materials) }}</td></tr>
            <tr><td class="indent">기초재료재고액</td><td class="num">{{ fmtMoney(data.current.open_materials) }}</td><td class="num">{{ fmtMoney(data.prior.open_materials) }}</td></tr>
            <tr><td class="indent">당기재료매입액</td><td class="num" data-testid="cs-purchases">{{ fmtMoney(data.current.purchases) }}</td><td class="num">{{ fmtMoney(data.prior.purchases) }}</td></tr>
            <tr><td class="indent">기말재료재고액</td><td class="num">{{ fmtMoney(data.current.close_materials) }}</td><td class="num">{{ fmtMoney(data.prior.close_materials) }}</td></tr>
            <tr class="section" data-testid="cs-labor"><td>Ⅱ. 노무비</td><td class="num">{{ fmtMoney(data.current.labor) }}</td><td class="num">{{ fmtMoney(data.prior.labor) }}</td></tr>
            <tr v-for="a in accounts('labor')" :key="a.id"><td class="indent">{{ a.name }}</td><td class="num">{{ fmtMoney(a.now) }}</td><td class="num">{{ fmtMoney(a.prior) }}</td></tr>
            <tr class="section" data-testid="cs-overhead"><td>Ⅲ. 경비</td><td class="num">{{ fmtMoney(data.current.overhead) }}</td><td class="num">{{ fmtMoney(data.prior.overhead) }}</td></tr>
            <tr v-for="a in accounts('overhead')" :key="a.id"><td class="indent">{{ a.name }}</td><td class="num">{{ fmtMoney(a.now) }}</td><td class="num">{{ fmtMoney(a.prior) }}</td></tr>
            <tr class="total" data-testid="cs-total"><td>Ⅳ. 당기총제조비용</td><td class="num">{{ fmtMoney(data.current.total_manufacturing) }}</td><td class="num">{{ fmtMoney(data.prior.total_manufacturing) }}</td></tr>
            <tr><td>Ⅴ. 기초재공품원가</td><td class="num">{{ fmtMoney(data.current.open_wip) }}</td><td class="num">{{ fmtMoney(data.prior.open_wip) }}</td></tr>
            <tr class="total"><td>Ⅵ. 합계</td><td class="num">{{ fmtMoney(data.current.total_manufacturing + data.current.open_wip) }}</td><td class="num">{{ fmtMoney(data.prior.total_manufacturing + data.prior.open_wip) }}</td></tr>
            <tr><td>Ⅶ. 기말재공품원가</td><td class="num">{{ fmtMoney(data.current.close_wip) }}</td><td class="num">{{ fmtMoney(data.prior.close_wip) }}</td></tr>
            <tr><td>Ⅷ. 타계정대체액</td><td class="num">{{ fmtMoney(data.current.transfer_out) }}</td><td class="num">{{ fmtMoney(data.prior.transfer_out) }}</td></tr>
            <tr class="net" data-testid="cs-goods"><td>Ⅸ. 당기제품제조원가</td><td class="num" data-testid="cs-cogm">{{ fmtMoney(data.current.cost_of_goods_manufactured) }}</td><td class="num">{{ fmtMoney(data.prior.cost_of_goods_manufactured) }}</td></tr>
          </tbody>
        </table>
      </div>
      <EmptyState v-else-if="!loading" title="제조 계정에 전표가 없습니다" text="계정 코드 501~600 의 전표를 모아 만듭니다. 재료비는 501~502, 노무비는 503~510, 경비는 511~600 입니다." />
      <p class="small dim note" data-testid="cs-note">재공품·제품 재고가 바뀌면 매출원가 계정을 맞은편으로 전표를 쓰세요. 제조 계정을 줄이면 Ⅳ 와 Ⅶ 에서 두 번 빠집니다. 타계정대체액은 아직 따로 잡지 않습니다.</p>
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

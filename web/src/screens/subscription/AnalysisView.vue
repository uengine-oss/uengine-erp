<script setup lang="ts">
// MRR on a chosen day and how it moved month by month, all read from the ledger (M8): every start, change, pause and close
// states the monthly figure after it and the day it took effect. The table carries every number the chart draws.
import { computed, onMounted, ref, watch } from 'vue'
import { fetchModels, type ModelRow } from '../../lib/analytics'
import { messageOf, rpc } from '../../lib/api'
import { onDataChanged } from '../../lib/commands'
import { fmtMoney } from '../../lib/format'
import { timeView } from '../../lib/mode'
import Icon from '../../components/Icon.vue'
import ColumnChart, { type ColumnRow } from '../analytics/ColumnChart.vue'
import { STATE_COLOR, STATE_LABEL, fmtPercent } from '../analytics/fmt'
import MovementChart, { type MoveMonth } from './MovementChart.vue'

interface MrrRow { subscription_id: string; number: string; partner_id: string; partner_name: string; mrr: number; since: string }
interface Mrr { on: string; mrr: number; arr: number; subscriptions: number; customers: number; rows: MrrRow[] }
interface Month extends MoveMonth { customers_start: number; customers_end: number; churned_customers: number; churn_rate: number | null; nrr: number | null }
interface Movement { from: string; to: string; months: Month[]; total: Month }

const day = ref('')
const mrr = ref<Mrr | null>(null)
const move = ref<Movement | null>(null)
const models = ref<ModelRow[]>([])
const error = ref('')
let seq = 0

const money = (v: number) => fmtMoney(Math.round(Number(v)))
const model = (id: string) => models.value.find((m) => m.id === id) ?? null
const endRows = computed<ColumnRow[]>(() => (move.value?.months ?? []).map((m) => ({ key: m.month, label: m.month.slice(2), value: Number(m.mrr_end), tip: `${m.month} 월말 ${money(m.mrr_end)}` })))

async function load() {
  const my = ++seq
  error.value = ''
  try {
    const asOf = timeView.at || null
    const on = day.value || null
    const [a, b, m] = await Promise.all([
      rpc<Mrr>('erp_subscription_mrr', { p_on: on, p_as_of: asOf }),
      rpc<Movement>('erp_subscription_movement', { p_from: null, p_to: on, p_as_of: asOf }),
      fetchModels(),
    ])
    if (my !== seq) return
    mrr.value = a
    move.value = b
    models.value = m
    if (!day.value) day.value = a.on
  } catch (e) {
    if (my === seq) error.value = messageOf(e)
  }
}
onMounted(load)
watch(() => timeView.at, () => { day.value = ''; void load() })
onDataChanged(() => { void load() })
</script>

<template>
  <div class="page" data-testid="subscription-analysis">
    <div class="page-head">
      <div class="crumbs">
        <router-link to="/analytics/models">예측·what-if</router-link><Icon class="muted" name="chevron-right" :size="12" />
        <h1>MRR 분석</h1>
      </div>
      <label class="day">기준일 <input v-model="day" type="date" class="input" data-testid="mrr-day" @change="load" /></label>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert"><Icon name="alert" /><span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" @click="load">다시 시도</button></div>
    <div class="page-body page-pad">
      <section v-if="mrr" class="tiles" data-testid="mrr-tiles">
        <div class="tile"><span class="muted small">월 반복 매출(MRR)</span><strong data-testid="mrr-now">{{ money(mrr.mrr) }}</strong><span class="muted small">{{ mrr.on }} 기준</span></div>
        <div class="tile"><span class="muted small">연 환산(ARR)</span><strong>{{ money(mrr.arr) }}</strong></div>
        <div class="tile"><span class="muted small">진행 중인 구독</span><strong data-testid="mrr-subscriptions">{{ mrr.subscriptions }}건</strong></div>
        <div class="tile"><span class="muted small">내는 고객</span><strong>{{ mrr.customers }}곳</strong></div>
      </section>

      <section v-if="move" class="panel" data-testid="mrr-movement">
        <h2>
          월별 MRR 증감
          <span v-if="model('subscription_mrr')" class="pill" :class="`pill-${STATE_COLOR[model('subscription_mrr')!.state]}`">{{ STATE_LABEL[model('subscription_mrr')!.state] }}</span>
        </h2>
        <p class="muted small">고객마다 하루 단위로 셉니다. 같은 날 작은 구독을 해지하고 큰 구독을 시작하면 확장입니다. 일시 중지도 그동안 들어오지 않는 돈이라 해지처럼 줄고, 재개하면 재개로 셉니다.</p>
        <MovementChart :months="move.months" :format="money" />
        <h3 class="sub-h">월말 MRR</h3>
        <ColumnChart :rows="endRows" :format="money" :height="140" description="월말 MRR" />
        <div class="scroll">
          <table class="tbl" data-testid="mrr-table">
            <thead><tr><th>월</th><th class="num">시작</th><th class="num">신규</th><th class="num">확장</th><th class="num">재개</th><th class="num">축소</th><th class="num">해지</th><th class="num">월말</th><th class="num">해지율</th><th class="num">순매출 유지율</th></tr></thead>
            <tbody>
              <tr v-for="m in move.months" :key="m.month" data-testid="mrr-month" :data-month="m.month">
                <td>{{ m.month }}</td><td class="num">{{ money(m.mrr_start) }}</td>
                <td class="num" data-col="new">{{ money(m.new) }}</td><td class="num" data-col="expansion">{{ money(m.expansion) }}</td><td class="num" data-col="reactivation">{{ money(m.reactivation) }}</td>
                <td class="num" data-col="contraction">{{ money(m.contraction) }}</td><td class="num" data-col="churn">{{ money(m.churn) }}</td>
                <td class="num" data-col="mrr_end">{{ money(m.mrr_end) }}</td>
                <td class="num">{{ fmtPercent(m.churn_rate, 1) }}</td><td class="num">{{ fmtPercent(m.nrr, 1) }}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr data-testid="mrr-total"><th>{{ move.from.slice(0, 7) }}~{{ move.to.slice(0, 7) }}</th><td class="num">{{ money(move.total.mrr_start) }}</td>
                <td class="num" data-col="new">{{ money(move.total.new) }}</td><td class="num" data-col="expansion">{{ money(move.total.expansion) }}</td><td class="num" data-col="reactivation">{{ money(move.total.reactivation) }}</td>
                <td class="num" data-col="contraction">{{ money(move.total.contraction) }}</td><td class="num" data-col="churn">{{ money(move.total.churn) }}</td><td class="num" data-col="mrr_end">{{ money(move.total.mrr_end) }}</td>
                <td class="num">{{ fmtPercent(move.total.churn_rate, 1) }}</td><td class="num">{{ fmtPercent(move.total.nrr, 1) }}</td></tr>
            </tfoot>
          </table>
        </div>
        <p class="muted small" data-testid="mrr-retention-note">
          해지율은 달 초에 내던 고객 가운데 달 말에 아무것도 내지 않는 고객의 비율입니다. 순매출 유지율은 그 고객들이 달 말에 내는 돈을 달 초에 내던 돈으로 나눈 값이고, 새 고객은 넣지 않습니다.
          <template v-if="model('subscription_retention') && model('subscription_retention')!.state !== 'ready'"> {{ model('subscription_retention')!.evidence.message }}.</template>
        </p>
      </section>

      <section v-if="mrr?.rows.length" class="panel" data-testid="mrr-rows">
        <h2>{{ mrr.on }}에 내는 구독</h2>
        <table class="tbl">
          <thead><tr><th>번호</th><th>고객</th><th class="num">MRR</th><th>이 금액부터</th></tr></thead>
          <tbody>
            <tr v-for="r in mrr.rows" :key="r.subscription_id" data-testid="mrr-row">
              <td><router-link :to="{ name: 'record', params: { type: 'subscription', id: r.subscription_id } }">{{ r.number }}</router-link></td>
              <td>{{ r.partner_name }}</td><td class="num">{{ money(r.mrr) }}</td><td>{{ r.since }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  </div>
</template>

<style scoped>
.page-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.day { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); white-space: nowrap; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 14px; }
.tile { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
.tile strong { font-size: 20px; font-variant-numeric: tabular-nums; }
.panel { margin-bottom: 16px; }
.panel h2 { display: flex; align-items: center; gap: 8px; }
.sub-h { margin: 12px 0 4px; font-size: 12px; color: var(--text-2); }
.scroll { overflow-x: auto; margin-top: 10px; }
.tbl td.num, .tbl th.num { font-variant-numeric: tabular-nums; }
</style>

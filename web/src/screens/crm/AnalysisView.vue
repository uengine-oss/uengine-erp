<script setup lang="ts">
// Conversion by stage, what the open deals may come to, and who is due to buy again. All from the ledger (M8). With too few decided
// deals the forecast gives the range and nothing narrower.
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { fetchModels, type ModelRow } from '../../lib/analytics'
import { messageOf, rpc } from '../../lib/api'
import { sendCommand } from '../../lib/commands'
import { fmtMoney } from '../../lib/format'
import { timeView, writeBlock } from '../../lib/mode'
import { hasRole } from '../../lib/session'
import Icon from '../../components/Icon.vue'
import { STATE_COLOR, STATE_LABEL } from '../analytics/fmt'

interface Stage { stage: string; label: string; reached: number; decided: number; won: number; lost: number; next_rate: number | null; rate: number | null; low: number | null; high: number | null }
interface Funnel { deals: number; won: number; lost: number; open: number; median_days: number | null; stages: Stage[]; lost_reasons: { reason: string; count: number }[] }
interface FStage { stage: string; label: string; deals: number; amount: number; rate?: number; low?: number; high?: number; expected?: number; expected_low?: number; expected_high?: number }
interface Forecast { ready: boolean; decided: number; need: number; open: number; pipeline: number; range: { low: number; high: number }; stages: FStage[]; expected: { mid: number; low: number; high: number } | null; by_month: { month: string | null; deals: number; amount: number }[] }
interface Candidate { partner_id: string; name: string; orders: number; last_order: string; avg_amount: number; typical_gap: number; days_since: number }
interface Repurchase { repeat_customers: number; rows: Candidate[] }

const REASONS: Record<string, string> = { price: '가격', competitor: '경쟁사', timing: '시기', budget: '예산', no_need: '필요 없어짐', no_response: '연락 두절', other: '기타' }
const router = useRouter()
const funnel = ref<Funnel | null>(null)
const forecast = ref<Forecast | null>(null)
const repurchase = ref<Repurchase | null>(null)
const models = ref<ModelRow[]>([])
const error = ref('')
let seq = 0

const model = (id: string) => models.value.find((m) => m.id === id) ?? null
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '' : `${Math.round(v * 100)}%`)
const canCreate = computed(() => !writeBlock.value && hasRole(['sales']))

async function load() {
  const my = ++seq
  error.value = ''
  try {
    const asOf = timeView.at || null
    const [f, c, r, m] = await Promise.all([
      rpc<Funnel>('erp_crm_funnel', { p_from: null, p_to: null, p_as_of: asOf }),
      rpc<Forecast>('erp_crm_forecast', { p_as_of: asOf }),
      rpc<Repurchase>('erp_crm_repurchase', { p_on: null, p_as_of: asOf }),
      fetchModels(),
    ])
    if (my !== seq) return
    funnel.value = f
    forecast.value = c
    repurchase.value = r
    models.value = m
  } catch (e) {
    if (my === seq) error.value = messageOf(e)
  }
}
onMounted(load)
watch(() => timeView.at, load)

async function startDeal(c: Candidate) {
  try {
    const res = await sendCommand<{ id: string }>({ type: 'opportunity', command: 'create', payload: { name: `${c.name} 재구매`, partner_id: c.partner_id, expected_amount: c.avg_amount } })
    await router.push({ name: 'record', params: { type: 'opportunity', id: res.id } })
  } catch (e) {
    error.value = messageOf(e)
  }
}
</script>

<template>
  <div class="page" data-testid="crm-analysis">
    <div class="page-head">
      <div class="crumbs">
        <router-link to="/analytics/models">예측·what-if</router-link><Icon class="muted" name="chevron-right" :size="12" />
        <h1>영업 분석</h1>
      </div>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert"><Icon name="alert" /><span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" @click="load">다시 시도</button></div>
    <div class="page-body page-pad">
      <section v-if="funnel" class="panel" data-testid="crm-funnel">
        <h2>단계별 전환율 <span v-if="model('crm_conversion')" class="pill" :class="`pill-${STATE_COLOR[model('crm_conversion')!.state]}`" data-testid="crm-conversion-state">{{ STATE_LABEL[model('crm_conversion')!.state] }}</span></h2>
        <p class="muted small" data-testid="crm-funnel-summary">전체 {{ funnel.deals }}건: 수주 {{ funnel.won }}, 실주 {{ funnel.lost }}, 진행 중 {{ funnel.open }}<template v-if="funnel.median_days !== null">. 수주까지 중앙값 {{ funnel.median_days }}일</template></p>
        <p v-if="model('crm_conversion')?.state !== 'ready'" class="small dim" data-testid="crm-conversion-short">{{ model('crm_conversion')?.evidence.message }}. 아래 비율은 세어 본 값이고 아직 믿을 만하지 않습니다.</p>
        <table class="tbl" data-testid="crm-funnel-table">
          <thead><tr><th>단계</th><th class="num">거친 건</th><th class="num">다음 단계로</th><th class="num">끝난 건</th><th class="num">수주율</th><th class="num">80% 구간</th></tr></thead>
          <tbody>
            <tr v-for="s in funnel.stages" :key="s.stage" data-testid="crm-funnel-row" :data-stage="s.stage">
              <td>{{ s.label }}</td><td class="num">{{ s.reached }}</td><td class="num">{{ pct(s.next_rate) }}</td><td class="num">{{ s.decided }}</td><td class="num">{{ pct(s.rate) }}</td>
              <td class="num">{{ s.rate === null ? '' : `${pct(s.low)} ~ ${pct(s.high)}` }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="funnel.lost_reasons.length" class="small dim reasons" data-testid="crm-lost-reasons">실주 사유: <span v-for="r in funnel.lost_reasons" :key="r.reason">{{ REASONS[r.reason] ?? r.reason }} {{ r.count }}건 </span></p>
      </section>

      <section v-if="forecast" class="panel" data-testid="crm-forecast">
        <h2>파이프라인 수주 전망 <span v-if="model('crm_forecast')" class="pill" :class="`pill-${STATE_COLOR[model('crm_forecast')!.state]}`" data-testid="crm-forecast-state">{{ STATE_LABEL[model('crm_forecast')!.state] }}</span></h2>
        <p class="muted small">진행 중 {{ forecast.open }}건, 예상 금액 합계 {{ fmtMoney(forecast.pipeline) }}</p>
        <p v-if="forecast.expected" class="headline" data-testid="crm-forecast-expected"><strong>{{ fmtMoney(forecast.expected.mid) }}</strong> <span class="muted small">80% 구간 {{ fmtMoney(forecast.expected.low) }} ~ {{ fmtMoney(forecast.expected.high) }}. 끝난 건 {{ forecast.decided }}건의 단계별 수주율로 셈합니다.</span></p>
        <p v-else class="headline" data-testid="crm-forecast-range"><strong>{{ fmtMoney(forecast.range.low) }} ~ {{ fmtMoney(forecast.range.high) }}</strong> <span class="muted small">끝난 건이 {{ forecast.need }}건은 있어야 수주율을 말할 수 있습니다(지금 {{ forecast.decided }}건). 그래서 범위로만 보여 줍니다.</span></p>
        <table class="tbl">
          <thead><tr><th>단계</th><th class="num">건수</th><th class="num">예상 금액</th><th class="num">수주율</th><th class="num">전망</th></tr></thead>
          <tbody>
            <tr v-for="s in forecast.stages" :key="s.stage" data-testid="crm-forecast-row"><td>{{ s.label }}</td><td class="num">{{ s.deals }}</td><td class="num">{{ fmtMoney(s.amount) }}</td><td class="num">{{ pct(s.rate) }}</td><td class="num">{{ s.expected === undefined ? '' : fmtMoney(s.expected) }}</td></tr>
          </tbody>
        </table>
      </section>

      <section v-if="repurchase" class="panel" data-testid="crm-repurchase">
        <h2>재구매 후보 <span v-if="model('crm_repurchase')" class="pill" :class="`pill-${STATE_COLOR[model('crm_repurchase')!.state]}`" data-testid="crm-repurchase-state">{{ STATE_LABEL[model('crm_repurchase')!.state] }}</span></h2>
        <p v-if="model('crm_repurchase')?.state === 'locked'" class="muted" data-testid="crm-repurchase-locked">{{ model('crm_repurchase')?.evidence.message }}</p>
        <template v-else>
          <p class="muted small">두 번 이상 주문한 고객 중, 평소 주문 간격보다 오래 주문이 없고 진행 중인 영업 기회가 없는 곳입니다. 주문 이력을 세어 본 것이지 예측이 아닙니다.</p>
          <table v-if="repurchase.rows.length" class="tbl" data-testid="crm-repurchase-table">
            <thead><tr><th>고객</th><th class="num">주문</th><th>마지막 주문</th><th class="num">평소 간격</th><th class="num">지난 일수</th><th class="num">평균 금액</th><th></th></tr></thead>
            <tbody>
              <tr v-for="c in repurchase.rows" :key="c.partner_id" data-testid="crm-repurchase-row">
                <td>{{ c.name }}</td><td class="num">{{ c.orders }}</td><td>{{ c.last_order }}</td><td class="num">{{ c.typical_gap }}일</td><td class="num">{{ c.days_since }}일</td><td class="num">{{ fmtMoney(c.avg_amount) }}</td>
                <td><button v-if="canCreate" type="button" class="btn btn-sm" data-testid="crm-repurchase-start" @click="startDeal(c)">영업 기회 만들기</button></td>
              </tr>
            </tbody>
          </table>
          <p v-else class="muted" data-testid="crm-repurchase-empty">지금 해당하는 고객이 없습니다.</p>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.crumbs { display: flex; align-items: center; gap: 6px; }
.panel { padding: 12px 14px; margin-bottom: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); max-width: 960px; }
.panel h2 { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.headline { margin: 8px 0; }
.headline strong { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; }
.reasons { margin-top: 8px; }
</style>

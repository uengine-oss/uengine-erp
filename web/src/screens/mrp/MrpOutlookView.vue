<script setup lang="ts">
// How long making takes, what it will use, and what making more would do. Everything comes from the ledger (M8) and nothing is written.
// Each of the three says for itself whether it is locked, short of evidence, or ready, and only then shows a number.
import { computed, onMounted, ref, watch } from 'vue'
import { fetchModels, type ModelRow } from '../../lib/analytics'
import { messageOf, rpc } from '../../lib/api'
import { fmtDate, fmtNumber } from '../../lib/format'
import { timeView } from '../../lib/mode'
import Icon from '../../components/Icon.vue'
import { STATE_COLOR, STATE_LABEL, fmtDays } from '../analytics/fmt'

interface Lead { orders: number; overall: { p10: number; p50: number; p90: number } | null; rows: { variant_id: string; name: string; orders: number; p10: number; p50: number; p90: number }[] }
interface Part { variant_id: string; name: string; on_hand: number; spoken_for: number; week_mean: number; expected: number; expected_low: number; expected_high: number; left_after: number; runs_out_on: string | null }
interface WhatIfPart { variant_id: string; name: string; on_hand: number; spoken_for: number; per_unit: number; week_use: number; week_use_changed: number; runs_out_on: string | null; runs_out_changed: string | null; effect_days: number | null; effect_low: number | null; effect_high: number | null; distinguishable: boolean }
interface WhatIf { name: string; factor: number; weeks: number; week_made: number; week_made_low: number; week_made_high: number; week_made_changed: number; parts: WhatIfPart[] }

const asOf = () => timeView.at || null
const models = ref<ModelRow[]>([])
const lead = ref<Lead | null>(null)
const materials = ref<Part[]>([])
const weeksSeen = ref(0)
const weeks = ref(8)
const error = ref('')
const product = ref('')
const factor = ref(1.5)
const whatif = ref<WhatIf | null>(null)
const whatifError = ref('')
let seq = 0

const model = (id: string) => models.value.find((m) => m.id === id) ?? null
const leadModel = computed(() => model('mrp_lead_time'))
const partsModel = computed(() => model('mrp_materials'))
const whatifModel = computed(() => model('whatif_production'))

async function load() {
  const my = ++seq
  error.value = ''
  try {
    const list = await fetchModels()
    if (my !== seq) return
    models.value = list
    if (leadModel.value && leadModel.value.state !== 'locked') lead.value = await rpc<Lead>('erp_mrp_lead_times', { p_as_of: asOf() })
    if (partsModel.value?.state === 'ready') {
      const r = await rpc<{ rows: Part[]; weeks_seen: number | null }>('erp_mrp_materials', { p_weeks: weeks.value, p_as_of: asOf() })
      materials.value = r.rows
      weeksSeen.value = r.weeks_seen ?? 0
    } else materials.value = []
    if (my === seq && !product.value && lead.value?.rows.length) product.value = lead.value.rows[0].variant_id
  } catch (e) {
    if (my === seq) error.value = messageOf(e)
  }
}
onMounted(load)
watch(() => timeView.at, () => { whatif.value = null; void load() })
watch(weeks, load)

async function runWhatIf() {
  whatifError.value = ''
  whatif.value = null
  if (!product.value) return
  try {
    whatif.value = await rpc<WhatIf>('erp_mrp_whatif', { p_variant_id: product.value, p_factor: factor.value, p_as_of: asOf() })
  } catch (e) {
    whatifError.value = messageOf(e)
  }
}

const effectText = (p: WhatIfPart): string => {
  if (!p.distinguishable) return '효과를 구분할 수 없음'
  const n = Number(p.effect_days)
  return `${fmtDays(Math.abs(n))} ${n < 0 ? '빨리 소진' : '늦게 소진'}`
}
</script>

<template>
  <div class="page" data-testid="mrp-outlook">
    <div class="page-head">
      <div class="crumbs">
        <router-link to="/analytics/models">예측·what-if</router-link><Icon class="muted" name="chevron-right" :size="12" />
        <h1>제조 현황</h1>
      </div>
    </div>
    <div v-if="timeView.at" class="banner banner-time banner-flush" data-testid="mrp-asof"><Icon name="history" /><span class="grow">{{ timeView.date }} 까지 원장에 기록된 것으로 계산합니다.</span></div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert"><Icon name="alert" /><span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" @click="load">다시 시도</button></div>
    <div class="page-body page-pad">
      <section class="panel" data-testid="mrp-lead">
        <header><h2>실측 제조 기간</h2><span v-if="leadModel" class="pill" :class="`pill-${STATE_COLOR[leadModel.state]}`" data-testid="mrp-lead-state">{{ STATE_LABEL[leadModel.state] }}</span></header>
        <p class="small dim" data-testid="mrp-lead-message">{{ leadModel?.evidence.message }}</p>
        <template v-if="leadModel?.state === 'ready' && lead?.overall">
          <p class="headline"><strong data-testid="mrp-lead-p50">{{ fmtDays(lead.overall.p50) }}</strong><span class="muted small">80% 구간 {{ fmtDays(lead.overall.p10) }} ~ {{ fmtDays(lead.overall.p90) }}, 완료 {{ lead.orders }}건. 시작한 때부터 완료까지입니다.</span></p>
          <div class="scroll-x">
            <table class="tbl">
              <thead><tr><th>제품</th><th class="num">완료</th><th class="num">보통</th><th class="num">빠를 때</th><th class="num">늦을 때</th></tr></thead>
              <tbody><tr v-for="r in lead.rows" :key="r.variant_id" data-testid="mrp-lead-row"><td>{{ r.name }}</td><td class="num">{{ r.orders }}</td><td class="num">{{ fmtDays(r.p50) }}</td><td class="num">{{ fmtDays(r.p10) }}</td><td class="num">{{ fmtDays(r.p90) }}</td></tr></tbody>
            </table>
          </div>
        </template>
      </section>

      <section class="panel" data-testid="mrp-materials">
        <header><h2>자재 소요 전망</h2><span v-if="partsModel" class="pill" :class="`pill-${STATE_COLOR[partsModel.state]}`" data-testid="mrp-materials-state">{{ STATE_LABEL[partsModel.state] }}</span></header>
        <p class="small dim" data-testid="mrp-materials-message">{{ partsModel?.evidence.message }}</p>
        <template v-if="partsModel?.state === 'ready'">
          <div class="row-tools">
            <label class="small dim" for="mrp-weeks">전망 기간</label>
            <select id="mrp-weeks" v-model.number="weeks" class="input" style="width: 90px" data-testid="mrp-weeks"><option :value="4">4주</option><option :value="8">8주</option><option :value="13">13주</option></select>
            <span class="muted small">확정한 지시가 쓸 양에, 지난 주들의 평균을 더합니다. 오는 입고는 세지 않으니 지금 재고가 언제까지 가는지로 읽습니다.</span>
          </div>
          <p v-if="weeksSeen > 0 && weeksSeen < 4" class="small err-text" data-testid="mrp-materials-short">기록이 {{ weeksSeen }}주뿐이라 구간이 실제보다 좁습니다.</p>
          <div class="scroll-x">
            <table class="tbl">
              <thead><tr><th>자재</th><th class="num">현재고</th><th class="num">확정 지시</th><th class="num">주 평균</th><th class="num">{{ weeks }}주 소요</th><th class="num">80% 구간</th><th>이 속도면 소진</th></tr></thead>
              <tbody>
                <tr v-for="p in materials" :key="p.variant_id" data-testid="mrp-material-row">
                  <td>{{ p.name }}</td><td class="num">{{ fmtNumber(p.on_hand) }}</td><td class="num">{{ fmtNumber(p.spoken_for) }}</td><td class="num">{{ fmtNumber(p.week_mean) }}</td>
                  <td class="num" data-testid="mrp-material-expected">{{ fmtNumber(p.expected) }}</td><td class="num">{{ fmtNumber(p.expected_low) }} ~ {{ fmtNumber(p.expected_high) }}</td>
                  <td :class="{ neg: Number(p.left_after) < 0 }" data-testid="mrp-material-out">{{ p.runs_out_on ? fmtDate(p.runs_out_on) : '-' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </section>

      <section class="panel" data-testid="mrp-whatif">
        <header><h2>생산량 변경</h2><span v-if="whatifModel" class="pill" :class="`pill-${STATE_COLOR[whatifModel.state]}`" data-testid="mrp-whatif-state">{{ STATE_LABEL[whatifModel.state] }}</span></header>
        <p class="small dim" data-testid="mrp-whatif-message">{{ whatifModel?.evidence.message }}</p>
        <template v-if="whatifModel?.state === 'ready'">
          <p class="small muted">이 계산은 원장을 바꾸지 않습니다. 한 개에 드는 양은 자재 명세가 아니라 지시들이 실제로 쓴 양입니다.</p>
          <form class="row-tools" @submit.prevent="runWhatIf">
            <label class="small dim" for="mrp-product">제품</label>
            <select id="mrp-product" v-model="product" class="input" style="max-width: 240px" data-testid="mrp-whatif-product"><option v-for="r in lead?.rows ?? []" :key="r.variant_id" :value="r.variant_id">{{ r.name }}</option></select>
            <label class="small dim" for="mrp-factor">생산량 배수</label>
            <input id="mrp-factor" v-model.number="factor" class="input" type="number" step="0.1" min="0" max="100" style="width: 90px" data-testid="mrp-whatif-factor" />
            <button type="submit" class="btn btn-primary" data-testid="mrp-whatif-run">계산</button>
          </form>
          <p v-if="whatifError" class="err-text small" role="alert" data-testid="mrp-whatif-error">{{ whatifError }}</p>
          <template v-if="whatif">
            <p class="small" data-testid="mrp-whatif-made">지난 {{ whatif.weeks }}주 평균 {{ fmtNumber(whatif.week_made) }}개를 {{ fmtNumber(whatif.week_made_changed) }}개로 만들면 (80% 구간 {{ fmtNumber(whatif.week_made_low) }} ~ {{ fmtNumber(whatif.week_made_high) }}개 기준):</p>
            <p v-if="whatif.weeks < 4" class="small err-text" data-testid="mrp-whatif-short">기록이 {{ whatif.weeks }}주뿐이라 구간이 실제보다 좁습니다.</p>
            <div class="scroll-x">
              <table class="tbl">
                <thead><tr><th>자재</th><th class="num">한 개에</th><th class="num">주 사용량</th><th>지금 소진</th><th>바꾸면 소진</th><th>효과</th></tr></thead>
                <tbody>
                  <tr v-for="p in whatif.parts" :key="p.variant_id" data-testid="mrp-whatif-row">
                    <td>{{ p.name }}</td><td class="num">{{ fmtNumber(p.per_unit) }}</td><td class="num">{{ fmtNumber(p.week_use) }} → {{ fmtNumber(p.week_use_changed) }}</td>
                    <td>{{ p.runs_out_on ? fmtDate(p.runs_out_on) : '-' }}</td><td data-testid="mrp-whatif-out">{{ p.runs_out_changed ? fmtDate(p.runs_out_changed) : '-' }}</td>
                    <td data-testid="mrp-whatif-effect">{{ effectText(p) }}<span v-if="p.distinguishable" class="muted small"> ({{ fmtNumber(p.effect_low) }} ~ {{ fmtNumber(p.effect_high) }}일)</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.crumbs { display: flex; align-items: center; gap: 6px; }
.panel { padding: 12px 14px; margin-bottom: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); max-width: 920px; }
.panel header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.headline { display: flex; align-items: baseline; flex-wrap: wrap; gap: 10px; margin: 8px 0; }
.headline strong { font-size: 24px; font-weight: 650; font-variant-numeric: tabular-nums; }
.row-tools { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
</style>

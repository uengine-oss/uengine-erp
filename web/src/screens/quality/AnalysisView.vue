<script setup lang="ts">
// How often things fail their checks: by supplier for what comes in, by product for everything, and how many orders were made right
// the first time. All from the ledger (M8), counting each thing by its first check. Small numbers come with their 80% band.
import { computed, onMounted, ref, watch } from 'vue'
import { fetchModels, type ModelRow } from '../../lib/analytics'
import { messageOf, rpc } from '../../lib/api'
import { onDataChanged } from '../../lib/commands'
import { timeView } from '../../lib/mode'
import Icon from '../../components/Icon.vue'
import { STATE_COLOR, STATE_LABEL } from '../analytics/fmt'

interface Band { rate: number | null; low: number | null; high: number | null }
interface Row extends Band { name: string; checks: number; failed: number; partner_id?: string; product_id?: string }
interface Rates extends Band { checks: number; failed: number; waiting: number; skipped: number; overall: Band; by_supplier: Row[]; by_product: Row[]; first_pass: Band & { orders: number; first_pass: number; waiting: number } }

const data = ref<Rates | null>(null)
const models = ref<ModelRow[]>([])
const from = ref('')
const to = ref('')
const error = ref('')
let seq = 0

const card = computed(() => models.value.find((m) => m.id === 'quality_defects') ?? null)
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '-' : `${(v * 100).toFixed(1)}%`)
const band = (b: Band) => (b.rate === null ? '' : `${pct(b.low)} ~ ${pct(b.high)}`)

async function load() {
  const my = ++seq
  error.value = ''
  try {
    const [r, m] = await Promise.all([
      rpc<Rates>('erp_quality_rates', { p_from: from.value || null, p_to: to.value || null, p_as_of: timeView.at || null }),
      fetchModels(),
    ])
    if (my !== seq) return
    data.value = r
    models.value = m
  } catch (e) {
    if (my === seq) error.value = messageOf(e)
  }
}
onMounted(load)
watch(() => [timeView.at, from.value, to.value], load)
onDataChanged(() => { void load() })
</script>

<template>
  <div class="page" data-testid="quality-analysis">
    <div class="page-head">
      <div class="crumbs">
        <router-link to="/analytics/models">예측·what-if</router-link><Icon class="muted" name="chevron-right" :size="12" />
        <h1>불량률</h1>
      </div>
      <div class="period">
        <label class="small muted" for="q-from">기간</label>
        <input id="q-from" v-model="from" type="date" class="input" style="width: 150px" data-testid="quality-from" />
        <span class="muted">~</span>
        <input v-model="to" type="date" class="input" style="width: 150px" aria-label="끝" data-testid="quality-to" />
      </div>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert"><Icon name="alert" /><span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" @click="load">다시 시도</button></div>
    <div class="page-body page-pad">
      <section v-if="data" class="panel" data-testid="quality-overall">
        <h2>전체 불량률 <span v-if="card" class="pill" :class="`pill-${STATE_COLOR[card.state]}`" data-testid="quality-state">{{ STATE_LABEL[card.state] }}</span></h2>
        <p class="headline" data-testid="quality-overall-rate"><strong>{{ pct(data.overall.rate) }}</strong>
          <span class="muted small">판정한 검사 {{ data.checks }}건 중 불합격 {{ data.failed }}건<template v-if="data.overall.rate !== null">, 80% 구간 {{ band(data.overall) }}</template>. 검사 대기 {{ data.waiting }}건, 표본 제외 {{ data.skipped }}건은 세지 않습니다.</span></p>
        <p v-if="card && card.state !== 'ready'" class="small dim" data-testid="quality-short">{{ card.evidence.message }}. 아래 비율은 세어 본 값이고 구간이 넓습니다.</p>
      </section>

      <section v-if="data" class="panel" data-testid="quality-suppliers">
        <h2>공급사별 불량률 <span class="muted small">입고 검사</span></h2>
        <table v-if="data.by_supplier.length" class="tbl">
          <thead><tr><th>공급사</th><th class="num">검사</th><th class="num">불합격</th><th class="num">불량률</th><th class="num">80% 구간</th></tr></thead>
          <tbody>
            <tr v-for="s in data.by_supplier" :key="s.partner_id" data-testid="quality-supplier-row">
              <td>{{ s.name }}</td><td class="num">{{ s.checks }}</td><td class="num">{{ s.failed }}</td><td class="num" data-testid="quality-supplier-rate">{{ pct(s.rate) }}</td><td class="num">{{ band(s) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">판정한 입고 검사가 없습니다.</p>
      </section>

      <section v-if="data" class="panel" data-testid="quality-products">
        <h2>제품별 불량률</h2>
        <table v-if="data.by_product.length" class="tbl">
          <thead><tr><th>제품</th><th class="num">검사</th><th class="num">불합격</th><th class="num">불량률</th><th class="num">80% 구간</th></tr></thead>
          <tbody>
            <tr v-for="p in data.by_product" :key="p.product_id" data-testid="quality-product-row">
              <td>{{ p.name }}</td><td class="num">{{ p.checks }}</td><td class="num">{{ p.failed }}</td><td class="num">{{ pct(p.rate) }}</td><td class="num">{{ band(p) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">판정한 검사가 없습니다.</p>
      </section>

      <section v-if="data" class="panel" data-testid="quality-fpy">
        <h2>제조 직행률</h2>
        <p v-if="data.first_pass.orders" class="headline"><strong data-testid="quality-fpy-rate">{{ pct(data.first_pass.rate) }}</strong>
          <span class="muted small">검사를 마친 제조 지시 {{ data.first_pass.orders }}건 중 처음 검사에 모두 합격한 {{ data.first_pass.first_pass }}건, 80% 구간 {{ band(data.first_pass) }}. 재작업 뒤 재검사에 합격해도 직행으로 세지 않습니다.</span></p>
        <p v-else class="muted">검사를 마친 제조 지시가 없습니다.<template v-if="data.first_pass.waiting"> 검사를 기다리는 지시 {{ data.first_pass.waiting }}건.</template></p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.crumbs { display: flex; align-items: center; gap: 6px; }
.page-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.period { display: flex; align-items: center; gap: 6px; }
.panel { padding: 12px 14px; margin-bottom: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); max-width: 960px; }
.panel h2 { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.headline { margin: 8px 0; }
.headline strong { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; }
</style>

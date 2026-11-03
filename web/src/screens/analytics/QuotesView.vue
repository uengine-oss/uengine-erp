<script setup lang="ts">
// Of the quotes made in a period, how many became orders. Short of the evidence this says a range and no single rate.
import { computed, onMounted, ref, watch } from 'vue'
import { fetchModels, type ModelRow } from '../../lib/analytics'
import { messageOf, rpc } from '../../lib/api'
import { fmtDay } from '../../lib/format'
import { timeView } from '../../lib/mode'
import Icon from '../../components/Icon.vue'
import { STATE_COLOR, STATE_LABEL, fmtPercent, fmtDays } from './fmt'

interface Conversion { quotes: number; won: number; lost: number; open: number; rate: number | null; low: number | null; high: number | null; decided_rate?: number | null; median_days: number | null }

const today = () => timeView.date || fmtDay(new Date().toISOString())
const yearBack = (day: string) => `${Number(day.slice(0, 4)) - 1}${day.slice(4)}`
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)
const to = ref(today())
const from = ref(yearBack(to.value))
const data = ref<Conversion | null>(null)
const model = ref<ModelRow | null>(null)
const error = ref('')
let seq = 0

async function load() {
  if (!from.value || !to.value) return
  const my = ++seq
  error.value = ''
  try {
    const [c, models] = await Promise.all([
      rpc<Conversion>('erp_quote_conversion', { p_from: from.value, p_to: nextDay(to.value), p_as_of: timeView.at || null }),
      fetchModels(),
    ])
    if (my !== seq) return
    data.value = c
    model.value = models.find((m) => m.id === 'quote_conversion') ?? null
  } catch (e) {
    if (my !== seq) return
    data.value = null
    error.value = messageOf(e)
  }
}
onMounted(load)
watch([from, to], load)
watch(() => timeView.at, () => { to.value = today(); from.value = yearBack(to.value) })

// The state follows this period's quotes as well as the company's, since a narrow period has few of them.
const need = computed(() => model.value?.evidence.need ?? 40)
const short = computed(() => model.value?.state !== 'ready' || (data.value?.quotes ?? 0) < need.value)
</script>

<template>
  <div class="page" data-testid="quotes">
    <div class="page-head">
      <div class="crumbs"><router-link to="/analytics/models">예측·what-if</router-link><Icon class="muted" name="chevron-right" :size="12" /><h1>견적 전환율</h1><span v-if="model" class="pill" :class="`pill-${STATE_COLOR[short ? (model.state === 'locked' ? 'locked' : 'insufficient') : 'ready']}`" data-testid="quotes-state">{{ STATE_LABEL[short ? (model.state === 'locked' ? 'locked' : 'insufficient') : 'ready'] }}</span></div>
    </div>
    <div class="toolbar">
      <input v-model="from" class="input" type="date" style="width: 130px" aria-label="시작일" data-testid="quotes-from" />
      <span class="muted">~</span>
      <input v-model="to" class="input" type="date" style="width: 130px" aria-label="종료일" data-testid="quotes-to" />
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert"><Icon name="alert" /><span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" @click="load">다시 시도</button></div>
    <div class="page-body page-pad">
      <section v-if="data" class="panel" data-testid="quotes-result">
        <template v-if="data.quotes">
          <p v-if="short" class="short" data-testid="quotes-short">견적 {{ need }}건이 있어야 비율을 하나로 말할 수 있습니다. 이 기간은 {{ data.quotes }}건이라 범위로만 보여 줍니다.</p>
          <div class="headline">
            <strong v-if="!short" data-testid="quotes-rate">{{ fmtPercent(data.rate, 1) }}</strong>
            <span data-testid="quotes-range" :class="{ big: short }">{{ fmtPercent(data.low, 1) }} ~ {{ fmtPercent(data.high, 1) }}</span>
            <span class="muted small">80% 구간</span>
          </div>
          <dl class="kv" data-testid="quotes-counts">
            <dt>견적</dt><dd>{{ data.quotes }}건</dd>
            <dt>주문이 됨</dt><dd>{{ data.won }}건</dd>
            <dt>취소됨</dt><dd>{{ data.lost }}건</dd>
            <dt>아직 결정 전</dt><dd>{{ data.open }}건 <span class="muted small">실패로 세면 최근 달이 낮게 읽히므로 따로 둡니다</span></dd>
            <dt>결정까지 걸린 날</dt><dd>{{ fmtDays(data.median_days) }} <span class="muted small">중앙값</span></dd>
          </dl>
        </template>
        <p v-else class="muted" data-testid="quotes-empty">이 기간에 만든 견적이 없습니다.</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.crumbs { display: flex; align-items: center; gap: 6px; }
.panel { padding: 12px 14px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); max-width: 640px; }
.short { margin-bottom: 8px; color: var(--amber-fg); }
.headline { display: flex; align-items: baseline; flex-wrap: wrap; gap: 10px; margin-bottom: 10px; }
.headline strong { font-size: 26px; font-weight: 650; font-variant-numeric: tabular-nums; }
.big { font-size: 20px; font-weight: 650; }
</style>

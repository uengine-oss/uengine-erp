<script setup lang="ts">
// The answer to a what-if. Its first sentence is the verdict: when the range holds zero nothing may read as an effect.
import { computed, ref, shallowRef } from 'vue'
import { runInWorker, ledger } from '../../lib/analytics'
import type { PnlOutcome } from '../../lib/forecast/pnl.ts'
import type { Measures } from '../../lib/forecast/context.ts'
import type { Band, ModelResult, Verdict } from '../../lib/forecast/types.ts'
import Icon from '../../components/Icon.vue'
import BandBar from './BandBar.vue'
import { fmtDelta, fmtMoneyPlain, fmtQty, fmtQtyDelta, moneyWithUnit } from './fmt'

interface Outcome { base: Measures; scenario: Measures; delta: Measures; base_reliable: boolean }

const props = defineProps<{ outcome: Outcome; verdict: Verdict | null; pnlReady?: boolean }>()

const ROWS: { key: keyof Measures; label: string; money: boolean }[] = [
  { key: 'revenue', label: '매출', money: true },
  { key: 'margin', label: '마진', money: true },
  { key: 'stockout_days', label: '품절일', money: false },
  { key: 'stock_value', label: '재고 금액', money: true },
  { key: 'lost_units', label: '못 판 수량', money: false },
]
const indistinguishable = computed(() => props.verdict?.code === 'indistinguishable')

function domain(b: Band): [number, number] {
  const edge = Math.max(Math.abs(b.p10), Math.abs(b.p90), 1) * 1.1
  return [-edge, edge]
}
const plain = (r: { money: boolean }, v: number) => (r.money ? fmtMoneyPlain(v) : fmtQty(v))
const delta = (r: { money: boolean }, v: number) => (r.money ? fmtDelta(v) : fmtQtyDelta(v))

/* What the change would do to next months' profit, on the books' own terms. */
const pnl = shallowRef<ModelResult<PnlOutcome> | null>(null)
const pnlError = ref('')
const pnlBusy = ref(false)
async function showPnl() {
  pnlBusy.value = true
  pnlError.value = ''
  try {
    pnl.value = await runInWorker<PnlOutcome>('pnl_outlook', { whatif: { margin: props.outcome.delta.margin } })
  } catch (e) {
    pnlError.value = e instanceof Error ? e.message : '계산하지 못했습니다'
  } finally {
    pnlBusy.value = false
  }
}
</script>

<template>
  <div class="answer" data-testid="whatif-result" :data-verdict="verdict?.code">
    <div v-if="indistinguishable" class="verdict verdict-none" role="status" data-testid="verdict-indistinguishable">
      <Icon name="info" />
      <div><strong>효과를 구분할 수 없습니다</strong><p>80% 구간이 0을 포함합니다. 아래 숫자로 이득이나 손해를 말할 수 없습니다.</p></div>
    </div>
    <div v-else-if="verdict" class="verdict" :class="verdict.good ? 'verdict-good' : 'verdict-bad'" role="status" data-testid="verdict">
      <Icon :name="verdict.code === 'up' ? 'arrow-up' : 'arrow-down'" />
      <div><strong>{{ verdict.text }}</strong></div>
    </div>
    <div v-if="!outcome.base_reliable" class="banner banner-warn" data-testid="base-unreliable">
      <Icon name="alert" /><span>기준 매출 자체는 믿지 마세요. 납기와 발주점을 입고 기록에서 추정한 값이라 수준이 어긋날 수 있습니다. 변화량만 보세요.</span>
    </div>

    <div class="tbl-wrap">
      <table class="tbl" data-testid="whatif-table">
        <thead>
          <tr>
            <th>항목</th>
            <th class="num" :class="{ doubtful: !outcome.base_reliable }">기준 (P50)</th>
            <th class="num">변경안 (P50)</th>
            <th class="num">변화 P10</th>
            <th class="num">변화 P50</th>
            <th class="num">변화 P90</th>
            <th style="min-width: 110px">80% 구간</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in ROWS" :key="r.key" :data-measure="r.key">
            <td>{{ r.label }}</td>
            <td class="num" :class="{ doubtful: !outcome.base_reliable }">{{ plain(r, outcome.base[r.key].p50) }}</td>
            <td class="num">{{ plain(r, outcome.scenario[r.key].p50) }}</td>
            <td class="num">{{ delta(r, outcome.delta[r.key].p10) }}</td>
            <td class="num strong">{{ delta(r, outcome.delta[r.key].p50) }}</td>
            <td class="num">{{ delta(r, outcome.delta[r.key].p90) }}</td>
            <td><BandBar :band="outcome.delta[r.key]" :min="domain(outcome.delta[r.key])[0]" :max="domain(outcome.delta[r.key])[1]" :aria-label="`${r.label} 변화의 80% 구간`" /></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="pnlReady" class="pnl">
      <button v-if="!pnl" type="button" class="btn btn-sm" :disabled="pnlBusy || ledger.phase !== 'ready'" data-testid="whatif-to-pnl" @click="showPnl">{{ pnlBusy ? '환산하는 중…' : '전표 기준 손익으로 환산' }}</button>
      <p v-if="pnlError" class="err-text small" role="alert">{{ pnlError }}</p>
      <dl v-if="pnl?.result" class="kv small" data-testid="whatif-pnl">
        <dt>앞으로 3개월 이익</dt><dd>{{ moneyWithUnit(pnl.result.profit.p50) }} ({{ fmtMoneyPlain(pnl.result.profit.p10) }} ~ {{ fmtMoneyPlain(pnl.result.profit.p90) }})</dd>
        <template v-if="pnl.result.profit_with_whatif"><dt>이 변경을 더하면</dt><dd>{{ moneyWithUnit(pnl.result.profit_with_whatif.p50) }} ({{ fmtMoneyPlain(pnl.result.profit_with_whatif.p10) }} ~ {{ fmtMoneyPlain(pnl.result.profit_with_whatif.p90) }})</dd></template>
      </dl>
      <p v-else-if="pnl" class="small dim">{{ pnl.evidence.message }}</p>
    </div>
  </div>
</template>

<style scoped>
.answer { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.verdict { display: flex; gap: 10px; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.verdict strong { font-size: 15px; }
.verdict p { margin-top: 2px; color: var(--text-2); }
.verdict svg { margin-top: 3px; }
.verdict-none { border-color: var(--line-strong); background: var(--ink-100); }
.verdict-good { border-color: var(--green-line); background: var(--green-bg); color: var(--green-fg); }
.verdict-bad { border-color: var(--red-line); background: var(--red-bg); color: var(--red-fg); }
.tbl-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.tbl-wrap .tbl th { position: static; }
.strong { font-weight: 650; }
.doubtful { color: var(--text-3); text-decoration: line-through dotted; }
.pnl { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
</style>

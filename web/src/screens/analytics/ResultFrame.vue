<script setup lang="ts">
// What every model result has around its numbers: the state, the evidence behind it and the warnings, word for word.
// Short of evidence there is no point estimate here: only what is missing, and a range when one can honestly be given.
import { computed } from 'vue'
import type { ModelResult } from '../../lib/forecast/types.ts'
import { ledger } from '../../lib/analytics'
import Icon from '../../components/Icon.vue'
import LedgerProgress from './LedgerProgress.vue'
import { CASE_LABEL, haveOfNeed, rangeValue } from './fmt'

const props = defineProps<{ result: ModelResult<any> | null; running?: boolean; seconds?: number; error?: string; idleText?: string }>()
defineEmits<{ retry: [] }>()

const evidence = computed(() => props.result?.evidence)
const percent = computed(() => {
  const e = evidence.value
  return e && e.need > 0 ? Math.min(100, Math.round((e.have / e.need) * 100)) : 0
})
const period = computed(() => {
  const e = evidence.value
  if (!e?.from && !e?.to) return ''
  return `${e?.from ?? '처음'} ~ ${e?.to ?? '지금'}`
})
// The message already gives the count the model rests on, so that one is not said twice.
const cases = computed(() => Object.entries(evidence.value?.cases ?? {})
  .filter(([, v]) => v !== evidence.value?.have)
  .map(([k, v]) => `${CASE_LABEL[k] ?? k} ${v.toLocaleString('ko-KR')}`))
</script>

<template>
  <div class="frame" data-testid="result-frame">
    <LedgerProgress />
    <p v-if="running && ledger.phase !== 'loading'" class="waiting" data-testid="computing"><span class="spin"></span>계산하는 중입니다{{ seconds ? ` (${seconds}초)` : '' }}. 화면은 그대로 쓸 수 있습니다.</p>
    <div v-if="error" class="banner banner-error" role="alert" data-testid="model-error">
      <Icon name="alert" /><span class="grow">{{ error }}</span>
      <button type="button" class="btn btn-sm" data-testid="model-retry" @click="$emit('retry')">다시 시도</button>
    </div>

    <template v-if="result">
      <section v-if="result.state === 'insufficient'" class="short" data-testid="result-insufficient">
        <h2><span class="pill pill-amber">근거 부족</span> 아직 숫자를 말할 수 없습니다</h2>
        <p data-testid="evidence-message">{{ evidence?.message }}</p>
        <div v-if="evidence && evidence.need > 0" class="row need">
          <div class="meter grow" role="progressbar" :aria-valuenow="percent" aria-valuemin="0" aria-valuemax="100"><i :style="{ width: `${percent}%` }"></i></div>
          <span class="small dim nowrap">{{ haveOfNeed(evidence.have, evidence.need, evidence.unit) }}</span>
        </div>
        <div v-if="result.range" class="range" data-testid="result-range">
          <div class="muted small">{{ result.range.unit }}, 범위로만 말할 수 있습니다</div>
          <strong>{{ rangeValue(result.range.low, result.range.unit) }} ~ {{ rangeValue(result.range.high, result.range.unit) }}</strong>
          <div class="small dim" data-testid="range-note">{{ result.range.note }}</div>
        </div>
      </section>
      <slot v-else-if="result.state === 'ready'" :result="result" />

      <ul v-if="result.warnings.length" class="warnings" data-testid="model-warnings">
        <li v-for="(w, i) in result.warnings" :key="i"><Icon name="alert" :size="13" /><span>{{ w }}</span></li>
      </ul>
      <p v-if="result.state === 'ready'" class="basis small dim" data-testid="evidence-line">
        <strong>근거</strong> {{ evidence?.message }}<template v-if="period"> · 기간 {{ period }}</template><template v-for="c in cases" :key="c"> · {{ c }}</template>
      </p>
    </template>
    <p v-else-if="!running && !error && idleText && ledger.phase !== 'loading'" class="muted">{{ idleText }}</p>
  </div>
</template>

<style scoped>
.frame { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.short { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); max-width: 640px; }
.short h2 { display: flex; align-items: center; gap: 8px; }
.need { max-width: 420px; }
.range { padding: 8px 10px; background: var(--ink-50); border-radius: var(--radius-sm); }
.range strong { font-size: 15px; font-variant-numeric: tabular-nums; }
.warnings { list-style: none; margin: 0; padding: 8px 10px; background: var(--amber-bg); border: 1px solid var(--amber-line); border-radius: var(--radius); color: var(--amber-fg); }
.warnings li { display: flex; gap: 6px; padding: 1px 0; }
.warnings svg { margin-top: 2px; }
</style>

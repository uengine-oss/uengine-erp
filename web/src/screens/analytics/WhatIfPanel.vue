<script setup lang="ts">
// The five what-ifs: a form, then the change against leaving things as they are. Nothing here writes to the ledger.
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ensureLedger, fetchModels, ledger, useModelRun } from '../../lib/analytics'
import type { TermsOutcome } from '../../lib/forecast/cash.ts'
import type { ModelId } from '../../lib/forecast/types.ts'
import type { DropOutcome, LeadOutcome, WhatIfOutcome } from '../../lib/forecast/whatif.ts'
import { timeView } from '../../lib/mode'
import { ensureNames, refLabel } from '../../lib/refs'
import Icon from '../../components/Icon.vue'
import BandBar from './BandBar.vue'
import LedgerProgress from './LedgerProgress.vue'
import ResultFrame from './ResultFrame.vue'
import WhatIfResult from './WhatIfResult.vue'
import { bandText, fmtDays, fmtDelta, fmtMoneyPlain, fmtPercent, fmtQty } from './fmt'

const props = defineProps<{ id: ModelId }>()

const { result, running, seconds, error, run, clear } = useModelRun<any>(() => props.id)

onMounted(() => { void ensureLedger() })
// A result is about the date it was computed for; the form stays filled in.
watch(() => timeView.at, () => { clear(); void ensureLedger() })
watch(() => ledger.version, () => clear())

const variants = computed(() => ledger.meta?.variants ?? [])
const warehouses = computed(() => ledger.meta?.warehouses ?? [])
const vendors = computed(() => ledger.meta?.vendors ?? [])
const terms = computed(() => ledger.meta?.terms ?? [])
watch(vendors, (v) => { void ensureNames(v).catch(() => {}) }, { immediate: true })

const days = ref(92)
// Policy
const changes = reactive<{ key: number; variant_id: string; warehouse_id: string; q_mult: number; rop_mult: number }[]>([{ key: 1, variant_id: '', warehouse_id: '', q_mult: 2, rop_mult: 2 }])
let nextKey = 2
const addChange = () => changes.push({ key: nextKey++, variant_id: '', warehouse_id: '', q_mult: 2, rop_mult: 2 })
const removeChange = (i: number) => changes.splice(i, 1)
// Realloc, drop
const variant = ref('')
const fromWarehouse = ref('')
const toWarehouse = ref('')
const fromMult = ref(0.7)
const toMult = ref(1.6)
const substitutes = ref<string[]>([])
// Lead
const toDays = ref<number | null>(7)
const vendor = ref('')
// Terms
const fromDays = ref<string>('')
const toTermDays = ref<number | null>(15)

const canRun = computed(() => {
  if (ledger.phase !== 'ready' || running.value) return false
  switch (props.id) {
    case 'whatif_policy': return changes.some((c) => c.variant_id)
    case 'whatif_realloc': return !!variant.value && !!fromWarehouse.value && !!toWarehouse.value && fromWarehouse.value !== toWarehouse.value
    case 'whatif_drop': return !!variant.value
    case 'whatif_lead': return !!toDays.value && toDays.value > 0
    case 'whatif_terms': return toTermDays.value !== null && toTermDays.value >= 0
    default: return false
  }
})

function input(): object {
  switch (props.id) {
    case 'whatif_policy':
      return { days: days.value, changes: changes.filter((c) => c.variant_id).map((c) => ({ variant_id: c.variant_id, warehouse_id: c.warehouse_id || undefined, q_mult: c.q_mult, rop_mult: c.rop_mult })) }
    case 'whatif_realloc':
      return { days: days.value, variant_id: variant.value, from_warehouse: fromWarehouse.value, to_warehouse: toWarehouse.value, from_mult: fromMult.value, to_mult: toMult.value }
    case 'whatif_drop':
      return { days: days.value, variant_id: variant.value, substitutes: substitutes.value.length ? [...substitutes.value] : undefined }
    case 'whatif_lead':
      return { days: days.value, to_days: toDays.value, vendor_id: vendor.value || undefined }
    default:
      return { days: days.value, to_days: toTermDays.value, from_days: fromDays.value === '' ? undefined : Number(fromDays.value) }
  }
}
const go = () => { void run(input()) }

const outcome = computed(() => (props.id === 'whatif_terms' ? null : (result.value?.result as WhatIfOutcome | null)))
const drop = computed(() => (props.id === 'whatif_drop' ? (result.value?.result as DropOutcome | null) : null))
const lead = computed(() => (props.id === 'whatif_lead' ? (result.value?.result as LeadOutcome | null) : null))
const termsOut = computed(() => (props.id === 'whatif_terms' ? (result.value?.result as TermsOutcome | null) : null))
const indistinguishable = computed(() => result.value?.verdict?.code === 'indistinguishable')
const termsDomain = computed<[number, number]>(() => {
  const d = termsOut.value?.delta
  const edge = d ? Math.max(Math.abs(d.p10), Math.abs(d.p90), 1) * 1.1 : 1
  return [-edge, edge]
})

const pnlReady = ref(false)
watch(result, async (r) => {
  if (!r || r.state !== 'ready') return
  try { pnlReady.value = (await fetchModels()).some((m) => m.id === 'pnl_outlook' && m.state === 'ready') } catch { pnlReady.value = false }
})
</script>

<template>
  <div class="whatif" data-testid="whatif-panel">
    <LedgerProgress />
    <form class="form" data-testid="whatif-form" @submit.prevent="go">
      <!-- Order policy -->
      <template v-if="id === 'whatif_policy'">
        <p class="small dim">발주량과 발주점을 몇 배로 바꾸면 어떻게 될지 봅니다.</p>
        <div v-for="(c, i) in changes" :key="c.key" class="change" data-testid="policy-change">
          <label class="f grow-2">제품
            <select v-model="c.variant_id" class="select" data-testid="policy-variant"><option value="">고르세요</option><option v-for="v in variants" :key="v.id" :value="v.id">{{ v.name }}</option></select>
          </label>
          <label class="f">창고
            <select v-model="c.warehouse_id" class="select" data-testid="policy-warehouse"><option value="">모든 창고</option><option v-for="w in warehouses" :key="w.id" :value="w.id">{{ w.name }}</option></select>
          </label>
          <label class="f short">발주량 배수<input v-model.number="c.q_mult" class="input num" type="number" min="0" step="0.1" data-testid="policy-q" /></label>
          <label class="f short">발주점 배수<input v-model.number="c.rop_mult" class="input num" type="number" min="0" step="0.1" data-testid="policy-rop" /></label>
          <button v-if="changes.length > 1" type="button" class="btn btn-ghost btn-sm btn-icon" aria-label="이 줄 빼기" @click="removeChange(i)"><Icon name="x" :size="12" /></button>
        </div>
        <div><button type="button" class="btn btn-sm" data-testid="policy-add" @click="addChange"><Icon name="plus" :size="12" />제품 더하기</button></div>
      </template>

      <!-- Moving stock -->
      <template v-else-if="id === 'whatif_realloc'">
        <p class="small dim">같은 제품을 한 창고에 덜 보내고 다른 창고에 더 보내면 어떻게 될지 봅니다. 크기보다 방향만 읽으세요.</p>
        <div class="grid">
          <label class="f">제품<select v-model="variant" class="select" data-testid="realloc-variant"><option value="">고르세요</option><option v-for="v in variants" :key="v.id" :value="v.id">{{ v.name }}</option></select></label>
          <label class="f">덜 보낼 창고<select v-model="fromWarehouse" class="select" data-testid="realloc-from"><option value="">고르세요</option><option v-for="w in warehouses" :key="w.id" :value="w.id">{{ w.name }}</option></select></label>
          <label class="f">더 보낼 창고<select v-model="toWarehouse" class="select" data-testid="realloc-to"><option value="">고르세요</option><option v-for="w in warehouses" :key="w.id" :value="w.id">{{ w.name }}</option></select></label>
          <label class="f short">덜 보낼 쪽 배수<input v-model.number="fromMult" class="input num" type="number" min="0" step="0.1" data-testid="realloc-from-mult" /></label>
          <label class="f short">더 보낼 쪽 배수<input v-model.number="toMult" class="input num" type="number" min="0" step="0.1" data-testid="realloc-to-mult" /></label>
        </div>
        <p v-if="fromWarehouse && fromWarehouse === toWarehouse" class="err-text small" role="alert">서로 다른 창고를 고르세요.</p>
      </template>

      <!-- Dropping a product -->
      <template v-else-if="id === 'whatif_drop'">
        <p class="small dim">제품을 그만 팔면 그 수요 중 얼마가 다른 제품으로 옮겨 갈지가 전부입니다. 그것은 그 제품이 품절됐을 때의 기록으로만 알 수 있습니다.</p>
        <div class="grid">
          <label class="f">그만 팔 제품<select v-model="variant" class="select" data-testid="drop-variant"><option value="">고르세요</option><option v-for="v in variants" :key="v.id" :value="v.id">{{ v.name }}</option></select></label>
          <label class="f">옮겨 갈 제품 (선택)
            <select v-model="substitutes" class="select multi" multiple size="3" data-testid="drop-substitutes"><option v-for="v in variants.filter((x) => x.id !== variant)" :key="v.id" :value="v.id">{{ v.name }}</option></select>
          </label>
        </div>
      </template>

      <!-- Lead time -->
      <template v-else-if="id === 'whatif_lead'">
        <p class="small dim">납기가 짧아지거나 길어지면 어떻게 될지 봅니다. 발주 방식은 그대로 둡니다.</p>
        <div class="grid">
          <label class="f short">새 납기(일)<input v-model.number="toDays" class="input num" type="number" min="1" step="1" data-testid="lead-to-days" /></label>
          <label class="f">공급사 (선택)<select v-model="vendor" class="select" data-testid="lead-vendor"><option value="">모든 공급사</option><option v-for="v in vendors" :key="v" :value="v">{{ refLabel(v) }}</option></select></label>
        </div>
      </template>

      <!-- Payment terms -->
      <template v-else-if="id === 'whatif_terms'">
        <p class="small dim">결제 조건을 바꾸면 들어오는 돈이 어떻게 달라질지 봅니다. 고객이 얼마나 따를지는 조건이 바뀐 적 있는 거래처만 말해 줍니다.</p>
        <div class="grid">
          <label class="f short">지금 조건(일)<select v-model="fromDays" class="select" data-testid="terms-from"><option value="">모든 조건</option><option v-for="t in terms" :key="t" :value="String(t)">{{ t }}일</option></select></label>
          <label class="f short">새 조건(일)<input v-model.number="toTermDays" class="input num" type="number" min="0" step="1" data-testid="terms-to" /></label>
        </div>
      </template>

      <div class="form-foot">
        <label class="f short">앞으로
          <select v-model.number="days" class="select" data-testid="whatif-days"><option v-for="d in [30, 60, 92, 180]" :key="d" :value="d">{{ d }}일</option></select>
        </label>
        <button type="submit" class="btn btn-primary" :disabled="!canRun" data-testid="whatif-run">{{ running ? '계산하는 중…' : '시험해 보기' }}</button>
      </div>
    </form>

    <ResultFrame :result="result" :running="running" :seconds="seconds" :error="error" idle-text="입력을 정하고 시험해 보세요. 계산은 이 브라우저에서 하고, 저장되는 것은 없습니다." @retry="go">
      <!-- Payment terms have one measure, and say it the same way. -->
      <div v-if="termsOut" class="answer" data-testid="whatif-result" :data-verdict="result?.verdict?.code">
        <div v-if="indistinguishable" class="verdict verdict-none" role="status" data-testid="verdict-indistinguishable">
          <Icon name="info" />
          <div><strong>효과를 구분할 수 없습니다</strong><p>80% 구간이 0을 포함합니다. 입금이 늘거나 준다고 말할 수 없습니다.</p></div>
        </div>
        <div v-else-if="result?.verdict" class="verdict" :class="result.verdict.good ? 'verdict-good' : 'verdict-bad'" role="status" data-testid="verdict"><Icon :name="result.verdict.code === 'up' ? 'arrow-up' : 'arrow-down'" /><div><strong>{{ result.verdict.text }}</strong></div></div>
        <div class="tbl-wrap">
          <table class="tbl" data-testid="terms-table">
            <thead><tr><th>앞으로 {{ days }}일 입금</th><th class="num">P10</th><th class="num">P50</th><th class="num">P90</th><th style="min-width: 110px">80% 구간</th></tr></thead>
            <tbody>
              <tr><td>지금 조건</td><td class="num">{{ fmtMoneyPlain(termsOut.base.p10) }}</td><td class="num">{{ fmtMoneyPlain(termsOut.base.p50) }}</td><td class="num">{{ fmtMoneyPlain(termsOut.base.p90) }}</td><td></td></tr>
              <tr><td>{{ termsOut.to_days }}일 조건</td><td class="num">{{ fmtMoneyPlain(termsOut.scenario.p10) }}</td><td class="num">{{ fmtMoneyPlain(termsOut.scenario.p50) }}</td><td class="num">{{ fmtMoneyPlain(termsOut.scenario.p90) }}</td><td></td></tr>
              <tr data-measure="delta"><td>변화</td><td class="num">{{ fmtDelta(termsOut.delta.p10) }}</td><td class="num strong">{{ fmtDelta(termsOut.delta.p50) }}</td><td class="num">{{ fmtDelta(termsOut.delta.p90) }}</td><td><BandBar :band="termsOut.delta" :min="termsDomain[0]" :max="termsDomain[1]" aria-label="입금 변화의 80% 구간" /></td></tr>
            </tbody>
          </table>
        </div>
        <p class="small dim">고객이 조건 변화를 따르는 정도: {{ bandText(termsOut.pass_through, (v) => fmtPercent(v)) }} (조건이 바뀐 거래처 {{ termsOut.cases }}곳에서 잼)</p>
      </div>

      <template v-else-if="outcome">
        <WhatIfResult :outcome="outcome" :verdict="result?.verdict ?? null" :pnl-ready="pnlReady" />
        <p v-if="lead" class="small dim" data-testid="lead-means">평균 납기 {{ fmtDays(lead.from_mean) }} → {{ fmtDays(lead.to_mean) }}</p>
        <div v-if="drop" class="tbl-wrap" data-testid="drop-rates">
          <table class="tbl">
            <thead><tr><th>옮겨 가는 제품</th><th class="num">대체율 (80% 구간)</th><th class="num">품절 사례</th><th class="num">품절일</th><th class="num">그때 못 판 수량</th></tr></thead>
            <tbody><tr v-for="r in drop.rates" :key="r.to"><td>{{ r.name }}</td><td class="num">{{ bandText(r.rate, (v) => fmtPercent(v)) }}</td><td class="num">{{ r.episodes }}</td><td class="num">{{ r.days }}</td><td class="num">{{ fmtQty(r.lost_units) }}</td></tr></tbody>
          </table>
        </div>
      </template>
    </ResultFrame>
  </div>
</template>

<style scoped>
.whatif { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.form { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); max-width: 880px; }
.f { display: flex; flex-direction: column; gap: 3px; flex: 1 1 170px; min-width: 0; color: var(--text-2); font-size: 12px; font-weight: 550; }
.f .input, .f .select { font-size: 13px; font-weight: 400; color: var(--text); }
.short { flex: 0 1 110px; }
.grow-2 { flex: 2 1 200px; }
.change { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; }
.grid { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px; }
.multi { height: auto; padding: 2px; background-image: none; }
.form-foot { display: flex; align-items: flex-end; gap: 10px; }
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
</style>

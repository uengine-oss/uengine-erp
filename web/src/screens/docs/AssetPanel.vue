<script setup lang="ts">
// Under an asset's form: the plan the database works out from what is typed, and once it is registered, disposal with the
// entry shown first. The rules are the database's; this panel only asks and shows.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { sendCommand } from '../../lib/commands'
import { fmtDay, fmtMoney } from '../../lib/format'
import { writeBlock } from '../../lib/mode'
import { catalogOf, hasRole } from '../../lib/session'
import type { ErpRecord, State } from '../../lib/types'
import { toast } from '../../lib/ui'
import NumberInput from '../../components/NumberInput.vue'
import ReviewNotice from '../../components/ReviewNotice.vue'
import RefSelect from '../../components/RefSelect.vue'

const props = defineProps<{ record: ErpRecord | null; draft: State; readonly?: boolean }>()

interface PlanRow { year: number; first: string; last: string; months: number; annual: number; amount: number }
interface Decision { ready: boolean; plan?: PlanRow[]; rate_used?: number; end_value?: number; warnings?: string[]; last_plan_month?: string }
interface Entry { account_id: string; code: string; name: string; debit: number; credit: number }
interface Disposal { catch_up: number; accumulated: number; book_value: number; proceeds: number; gain_loss: number; locked: string | null; entry: Entry[] }

const registered = computed(() => !!props.record && ['active', 'fully', 'disposed'].includes(String(props.record.status)))
const decided = ref<Decision | null>(null)
const previewError = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
let seq = 0

const PREVIEW_FIELDS = ['kind', 'method', 'basis', 'cost', 'life_years', 'acquisition_date', 'in_service_date', 'residual_value', 'rate', 'opening_accumulated', 'opening_through', 'counter_account_id']
async function preview() {
  const my = ++seq
  try {
    const payload = Object.fromEntries(PREVIEW_FIELDS.map((k) => [k, props.draft[k] ?? null]))
    const res = await rpc<Decision>('erp_preview', { p_type: 'asset', p_payload: payload })
    if (my === seq) { decided.value = res; previewError.value = '' }
  } catch (e) {
    if (my === seq) { decided.value = null; previewError.value = messageOf(e) }
  }
}
watch(() => (registered.value ? null : PREVIEW_FIELDS.map((k) => props.draft[k])), () => {
  if (registered.value) return
  clearTimeout(timer)
  timer = setTimeout(preview, 250)
}, { immediate: true, deep: true })
onBeforeUnmount(() => clearTimeout(timer))

const plan = computed<PlanRow[]>(() => (registered.value ? (props.record?.state.plan as PlanRow[] | undefined) ?? [] : decided.value?.plan ?? []))
const planRate = computed(() => (registered.value ? props.record?.state.rate_used : decided.value?.rate_used))
const planEnd = computed(() => (registered.value ? props.record?.state.end_value : decided.value?.end_value))
const planTotal = computed(() => plan.value.reduce((n, r) => n + Number(r.amount), 0))

// Disposal
const canDispose = computed(() => !!props.record && ['active', 'fully'].includes(String(props.record.status)) && hasRole(['accounting']) && !writeBlock.value)
const date = ref(fmtDay(new Date().toISOString()))
const kind = ref<'sale' | 'scrap'>('sale')
const proceeds = ref<number | null>(0)
const proceedsAccount = ref<string | null>(null)
const disposal = ref<Disposal | null>(null)
const disposalError = ref('')
const busy = ref(false)
const booksOn = computed(() => !!catalogOf('journal_entry'))
let dseq = 0
let dtimer: ReturnType<typeof setTimeout> | undefined
async function previewDisposal() {
  const my = ++dseq
  if (!props.record || !canDispose.value || !date.value) { disposal.value = null; return }
  try {
    const res = await rpc<Disposal>('erp_asset_disposal_preview', { p_id: props.record.id, p_date: date.value, p_kind: kind.value, p_proceeds: kind.value === 'sale' ? proceeds.value ?? 0 : 0, p_proceeds_account: proceedsAccount.value })
    if (my === dseq) { disposal.value = res; disposalError.value = '' }
  } catch (e) {
    if (my === dseq) { disposal.value = null; disposalError.value = messageOf(e) }
  }
}
watch([date, kind, proceeds, proceedsAccount, canDispose, () => props.record?.version], () => { clearTimeout(dtimer); dtimer = setTimeout(previewDisposal, 250) }, { immediate: true })
onBeforeUnmount(() => clearTimeout(dtimer))
async function dispose() {
  if (!props.record) return
  busy.value = true
  disposalError.value = ''
  try {
    await sendCommand({ type: 'asset', id: props.record.id, command: 'dispose', payload: { date: date.value, kind: kind.value, proceeds: kind.value === 'sale' ? proceeds.value ?? 0 : 0, ...(proceedsAccount.value ? { proceeds_account_id: proceedsAccount.value } : {}) } })
    toast('처분했습니다.')
  } catch (e) {
    disposalError.value = messageOf(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="asset-panel no-print" data-testid="asset-panel">
    <ReviewNotice />
    <h2>연도별 상각 계획</h2>
    <p v-if="previewError" class="err-text" role="alert" data-testid="asset-preview-error">{{ previewError }}</p>
    <ul v-if="decided?.warnings?.length && !registered" class="warn-list" data-testid="asset-warnings"><li v-for="(w, i) in decided.warnings" :key="i">{{ w }}</li></ul>
    <p v-if="!plan.length && !previewError" class="small muted" data-testid="asset-plan-empty">취득일, 취득가액, 내용연수를 적으면 계획이 나옵니다.</p>
    <template v-else-if="plan.length">
      <p class="small dim" data-testid="asset-plan-summary">적용 상각률 {{ planRate }}. 모두 {{ fmtMoney(planTotal) }} 을 상각하고 {{ fmtMoney(planEnd) }} 이 남습니다.</p>
      <div class="scroll-x">
        <table class="tbl" data-testid="asset-plan">
          <thead><tr><th>연도</th><th>기간</th><th class="num">개월</th><th class="num">감가상각비</th></tr></thead>
          <tbody><tr v-for="r in plan" :key="r.year" data-testid="asset-plan-row" :data-year="r.year"><td>{{ r.year }}</td><td>{{ r.first }} ~ {{ r.last }}</td><td class="num">{{ r.months }}</td><td class="num" data-testid="asset-plan-amount">{{ fmtMoney(r.amount) }}</td></tr></tbody>
        </table>
      </div>
    </template>

    <template v-if="canDispose">
      <h2 style="margin-top: 12px">처분</h2>
      <div class="row-wrap">
        <div class="seg" role="group" aria-label="처분 구분">
          <button type="button" :class="{ on: kind === 'sale' }" :aria-pressed="kind === 'sale'" data-testid="dispose-sale" @click="kind = 'sale'">매각</button>
          <button type="button" :class="{ on: kind === 'scrap' }" :aria-pressed="kind === 'scrap'" data-testid="dispose-scrap" @click="kind = 'scrap'">폐기</button>
        </div>
        <label class="field-inline">처분일 <input v-model="date" class="input" type="date" data-testid="dispose-date" /></label>
        <label v-if="kind === 'sale'" class="field-inline">대금 <NumberInput v-model="proceeds" kind="money" style="width: 134px" aria-label="처분 대금" data-testid="dispose-proceeds" /></label>
        <label v-if="kind === 'sale' && booksOn" class="field-inline">대금 계정 <RefSelect v-model="proceedsAccount" ref-type="account" style="width: 180px" data-testid="dispose-account" /></label>
      </div>
      <p class="small dim">처분 달은 상각하지 않습니다. 그 전 달까지 아직 상각하지 않은 금액은 처분과 함께 잡습니다. 대금 계정을 비우면 보통예금입니다. 세금계산서를 내는 매각은 청구서 줄 계정과 여기 대금 계정을 모두 미수금으로 고르세요.</p>
      <p v-if="disposalError" class="err-text" role="alert" data-testid="dispose-error">{{ disposalError }}</p>
      <template v-if="disposal">
        <p v-if="disposal.locked" class="err-text" data-testid="dispose-locked">{{ disposal.locked }}</p>
        <dl class="tiles" data-testid="dispose-figures">
          <div><dt>처분 전 상각</dt><dd data-testid="dispose-catch-up">{{ fmtMoney(disposal.catch_up) }}</dd></div>
          <div><dt>장부가액</dt><dd data-testid="dispose-book-value">{{ fmtMoney(disposal.book_value) }}</dd></div>
          <div><dt>{{ disposal.gain_loss >= 0 ? '처분 이익' : '처분 손실' }}</dt><dd data-testid="dispose-gain">{{ fmtMoney(Math.abs(disposal.gain_loss)) }}</dd></div>
        </dl>
        <div class="scroll-x">
          <table class="tbl" style="max-width: 620px" data-testid="dispose-entry">
            <thead><tr><th>{{ booksOn ? '이 처분이 만들 전표' : '회계를 켜면 만들어질 전표' }}</th><th class="num">차변</th><th class="num">대변</th></tr></thead>
            <tbody><tr v-for="e in disposal.entry" :key="e.account_id" data-testid="dispose-entry-row"><td>{{ e.code }} {{ e.name }}</td><td class="num">{{ fmtMoney(e.debit) }}</td><td class="num">{{ fmtMoney(e.credit) }}</td></tr></tbody>
          </table>
        </div>
        <button type="button" class="btn btn-primary" :disabled="busy || !!disposal.locked" data-testid="dispose-run" @click="dispose">{{ kind === 'sale' ? '매각 처리' : '폐기 처리' }}</button>
      </template>
    </template>
    <p v-else-if="record?.status === 'disposed'" class="small dim" data-testid="asset-disposed" style="margin-top: 10px">{{ record.state.disposed_date }} 에 처분했습니다. 처분 손익 {{ fmtMoney(record.state.gain_loss) }}. 잘못 처분했으면 이력에서 되돌립니다.</p>
  </section>
</template>

<style scoped>
.asset-panel { display: flex; flex-direction: column; gap: 6px; margin-top: 14px; align-items: flex-start; }
.asset-panel .scroll-x, .review { align-self: stretch; }
.asset-panel h2 { font-size: 13px; }
.warn-list { margin: 0; padding: 8px 10px 8px 24px; background: var(--amber-bg); border: 1px solid var(--amber-line); border-radius: var(--radius); color: var(--amber-fg); }
.tiles { display: flex; flex-wrap: wrap; gap: 10px 28px; margin: 4px 0; }
.tiles dt { color: var(--text-2); font-size: 12px; }
.tiles dd { margin: 0; font-size: 15px; font-weight: 650; font-variant-numeric: tabular-nums; }
</style>

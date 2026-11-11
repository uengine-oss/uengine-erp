<script setup lang="ts">
// Where one line's money belongs: {analytic account: percent}, 100 in each plan. Empty means "the default rules decide when it is
// booked", {} means "nowhere". The database checks every value; this only shows what the rules would say and keeps the sums in view.
import { computed, ref, watch } from 'vue'
import { rpc } from '../lib/api'
import { ensureNames, ensureStates, refLabel, refStates } from '../lib/refs'
import type { State } from '../lib/types'
import Icon from './Icon.vue'
import NumberInput from './NumberInput.vue'
import RefSelect from './RefSelect.vue'

type Dist = Record<string, number>
const props = defineProps<{ modelValue: Dist | null | undefined; disabled?: boolean; compact?: boolean; id?: string; ariaLabel?: string; context?: State | null }>()
const emit = defineEmits<{ 'update:modelValue': [value: Dist | null] }>()

const open = ref(false)
const rows = ref<{ account: string | null; percent: number | null }[]>([])
const hint = ref<Dist | null>(null)

const isSet = computed(() => !!props.modelValue && typeof props.modelValue === 'object')
const ids = computed(() => [...Object.keys(props.modelValue ?? {}), ...Object.keys(hint.value ?? {}), ...rows.value.map((r) => r.account)])
watch(ids, async (list) => {
  await ensureStates(list)
  await ensureNames([...list, ...list.map((id) => (id ? refStates.get(id)?.plan_id : null))])
}, { immediate: true })

const planOf = (id: string | null) => (id ? refStates.get(id)?.plan_id ?? '' : '')
const say = (d: Dist | null | undefined) => Object.entries(d ?? {}).map(([id, p]) => `${refLabel(id)} ${Number(p)}%`).join(' · ')
const summary = computed(() => {
  if (!isSet.value) return hint.value ? `기본 규칙: ${say(hint.value)}` : '기본 규칙'
  return Object.keys(props.modelValue!).length ? say(props.modelValue) : '나누지 않음'
})

// What the rules would give this line now. Booking asks them again, as they stand then.
let seq = 0
const contextKey = computed(() => JSON.stringify([props.context?.product_id ?? null, props.context?.account_id ?? null, props.context?.partner_id ?? null]))
watch([contextKey, isSet], async () => {
  if (isSet.value) return
  const my = ++seq
  try {
    const res = await rpc<{ distribution: Dist | null }>('erp_analytic_default', { p: { product_id: props.context?.product_id ?? null, account_id: props.context?.account_id ?? null, partner_id: props.context?.partner_id ?? null } })
    if (my === seq) hint.value = res.distribution
  } catch { if (my === seq) hint.value = null }
}, { immediate: true })

const sums = computed(() => {
  const m = new Map<string, number>()
  for (const r of rows.value) if (r.account) m.set(planOf(r.account), (m.get(planOf(r.account)) ?? 0) + Number(r.percent ?? 0))
  return [...m].map(([plan, total]) => ({ plan, label: plan ? refLabel(plan) : '계획', total: Math.round(total * 100) / 100 }))
})
const allWhole = computed(() => sums.value.every((s) => s.total === 100))

function start() {
  if (props.disabled) return
  const from = isSet.value ? props.modelValue! : hint.value ?? {}
  rows.value = Object.entries(from).map(([account, percent]) => ({ account, percent: Number(percent) }))
  if (!rows.value.length) rows.value.push({ account: null, percent: 100 })
  open.value = true
}
function apply() {
  const out: Dist = {}
  for (const r of rows.value) if (r.account && r.percent) out[r.account] = (out[r.account] ?? 0) + Number(r.percent)
  emit('update:modelValue', out)
  open.value = false
}
function choose(v: Dist | null) {
  emit('update:modelValue', v)
  open.value = false
}
</script>

<template>
  <button :id="id" type="button" class="dist" :class="{ 'dist-default': !isSet, compact }" :disabled="disabled" :aria-label="ariaLabel ?? '분석 분배'" :title="summary"
          data-testid="distribution" @click="start">
    <span class="ellipsis">{{ summary }}</span>
  </button>
  <Teleport to="body">
    <div v-if="open" class="dist-backdrop" @click.self="open = false" @keydown.esc="open = false">
      <div class="dist-panel" role="dialog" aria-label="분석 분배" data-testid="distribution-editor">
        <h2>분석 분배</h2>
        <p class="muted small">부서·프로젝트 같은 분석 계정에 몇 %씩 나눌지 적습니다. 계획마다 합이 100% 여야 합니다.</p>
        <div v-for="(r, i) in rows" :key="i" class="dist-row" data-testid="distribution-row">
          <RefSelect :model-value="r.account" ref-type="analytic_account" aria-label="분석 계정" @update:model-value="r.account = $event" />
          <NumberInput :model-value="r.percent" kind="number" aria-label="비율" @update:model-value="r.percent = $event" />
          <span class="muted">%</span>
          <button type="button" class="btn btn-ghost btn-sm btn-icon" aria-label="줄 삭제" @click="rows.splice(i, 1)"><Icon name="x" :size="12" /></button>
        </div>
        <button type="button" class="btn btn-sm" data-testid="distribution-add" @click="rows.push({ account: null, percent: null })"><Icon name="plus" :size="12" />계정 추가</button>
        <p class="small sums" data-testid="distribution-sums">
          <span v-for="s in sums" :key="s.plan" :class="{ 'err-text': s.total !== 100 }">{{ s.label }} {{ s.total }}%</span>
        </p>
        <div class="row dist-actions">
          <button type="button" class="btn btn-primary btn-sm" :disabled="!allWhole || !sums.length" data-testid="distribution-apply" @click="apply">적용</button>
          <button type="button" class="btn btn-sm" data-testid="distribution-default" @click="choose(null)">기본 규칙대로</button>
          <button type="button" class="btn btn-sm btn-ghost" data-testid="distribution-none" @click="choose({})">나누지 않음</button>
          <button type="button" class="btn btn-sm btn-ghost" style="margin-left: auto" @click="open = false">닫기</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.dist { display: inline-flex; align-items: center; max-width: 100%; min-height: 28px; padding: 0 8px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.dist.compact { border-color: transparent; background: transparent; width: 100%; }
.dist:hover:not(:disabled) { border-color: var(--line); background: var(--surface); }
.dist-default { color: var(--text-2); font-style: italic; }
.dist:disabled { cursor: default; opacity: .7; }
.dist-backdrop { position: fixed; inset: 0; z-index: 900; display: flex; align-items: flex-start; justify-content: center; padding-top: 12vh; background: rgba(15, 23, 42, .28); }
.dist-panel { width: min(520px, calc(100vw - 32px)); padding: 16px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: 0 12px 32px rgba(15, 23, 42, .18); }
.dist-panel h2 { margin-bottom: 4px; }
.dist-row { display: grid; grid-template-columns: 1fr 90px auto 30px; gap: 6px; align-items: center; margin: 6px 0; }
.sums { display: flex; gap: 12px; margin: 8px 0; }
.dist-actions { gap: 6px; margin-top: 8px; }
</style>

<script setup lang="ts">
// What these terms would do to an amount on a date, before anything is saved. The database does the sums.
import { onBeforeUnmount, ref, watch } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { fmtDay, fmtMoney } from '../../lib/format'
import type { State } from '../../lib/types'
import NumberInput from '../../components/NumberInput.vue'

const props = defineProps<{ draft: State }>()
const amount = ref<number | null>(1000000)
const date = ref(fmtDay(new Date().toISOString()))
const schedule = ref<State[]>([])
const error = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
let seq = 0

async function load() {
  const my = ++seq
  try {
    const res = await rpc<{ schedule: State[] }>('erp_preview', { p_type: 'payment_term', p_payload: {
      lines: props.draft.lines ?? [], early_discount: props.draft.early_discount, discount_percentage: props.draft.discount_percentage,
      discount_days: props.draft.discount_days, discount_mode: props.draft.discount_mode, amount: amount.value ?? 0, date: date.value || null,
    } })
    if (my === seq) { schedule.value = res.schedule ?? []; error.value = '' }
  } catch (e) {
    if (my === seq) error.value = messageOf(e)
  }
}
watch([amount, date, () => props.draft.lines, () => props.draft.early_discount, () => props.draft.discount_percentage, () => props.draft.discount_days, () => props.draft.discount_mode], () => {
  clearTimeout(timer)
  timer = setTimeout(load, 250)
}, { immediate: true, deep: true })
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <section class="form-note no-print" data-testid="term-preview">
    <h2>회차 미리 보기</h2>
    <div class="row-wrap">
      <label class="field-inline">청구 금액 <NumberInput v-model="amount" kind="money" style="width: 134px" aria-label="청구 금액" data-testid="term-amount" @keydown.enter.prevent /></label>
      <label class="field-inline">청구일 <input v-model="date" class="input" type="date" data-testid="term-date" @keydown.enter.prevent /></label>
    </div>
    <p v-if="error" class="err-text small" role="alert" style="margin-top: 6px">{{ error }}</p>
    <div class="scroll-x" style="margin-top: 6px">
      <table class="tbl" data-testid="term-schedule">
        <thead><tr><th>회차</th><th>만기</th><th class="num">금액</th><th>할인 기한</th><th class="num">할인 후 금액</th></tr></thead>
        <tbody><tr v-for="(s, i) in schedule" :key="i" data-testid="term-row"><td>{{ i + 1 }}</td><td data-testid="term-due">{{ s.due_date }}</td><td class="num" data-testid="term-money">{{ fmtMoney(s.amount) }}</td><td>{{ s.discount_date }}</td><td class="num">{{ fmtMoney(s.discount_amount) }}</td></tr></tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.form-note { margin-top: 14px; }
.form-note h2 { margin-bottom: 6px; font-size: 13px; }
</style>

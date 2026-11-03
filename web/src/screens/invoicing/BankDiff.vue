<script setup lang="ts">
// The two sides next to each other. Money the books claim and the bank does not know is what a mistaken payment looks like.
import { computed, ref, watch } from 'vue'
import { rpc } from '../../lib/api'
import { fmtDay, fmtMoney } from '../../lib/format'
import { useLoad } from '../../lib/load'
import { ensureNames, refLabel } from '../../lib/refs'
import Icon from '../../components/Icon.vue'
import LoadError from '../../components/LoadError.vue'

interface Diff {
  at: string; statement_total: number; book_total: number; difference: number
  unmatched_lines: { id: string; date: string; amount: number; residual: number; payment_ref: string | null }[]; unmatched_lines_total: number
  unmatched_payments: { id: string; number: string | null; date: string; amount: number; partner_id: string | null; memo: string | null }[]; unmatched_payments_total: number
}
const props = defineProps<{ journal: string }>()
defineEmits<{ back: [] }>()
const at = ref(fmtDay(new Date().toISOString()))
const { data, error, load } = useLoad(async () => {
  const d = await rpc<Diff>('erp_bank_reconciliation', { p_journal_id: props.journal, p_at: at.value || null })
  await ensureNames(d.unmatched_payments.map((p) => p.partner_id))
  return d
})
watch(() => [props.journal, at.value], load, { immediate: true })
const none = computed(() => !!data.value && Number(data.value.difference) === 0 && !data.value.unmatched_lines.length && !data.value.unmatched_payments.length)
</script>

<template>
  <div class="report-pad" data-testid="bank-diff">
    <div class="row-wrap" style="margin-bottom: 8px">
      <label class="field-inline">기준일 <input v-model="at" class="input" type="date" data-testid="bank-at" /></label>
      <div class="grow"></div>
      <button type="button" class="btn" data-testid="bank-back" @click="$emit('back')"><Icon name="chevron-left" :size="12" />맞춰 보기로</button>
    </div>
    <LoadError :message="error" @retry="load" />
    <template v-if="data">
      <div class="stat-row">
        <div class="stat"><span class="stat-label">은행이 말한 금액</span><span class="stat-value" data-testid="bank-statement-total">{{ fmtMoney(data.statement_total) }}</span></div>
        <div class="stat"><span class="stat-label">장부가 말한 금액</span><span class="stat-value" data-testid="bank-book-total">{{ fmtMoney(data.book_total) }}</span></div>
        <div class="stat" :class="{ 'stat-bad': Number(data.difference) !== 0 }"><span class="stat-label">차이</span><span class="stat-value" data-testid="bank-difference">{{ fmtMoney(data.difference) }}</span></div>
      </div>
      <div v-if="none" class="banner banner-ok" style="margin-top: 10px" data-testid="bank-clean"><Icon name="check" /><span>은행과 장부가 일치합니다.</span></div>
      <section v-if="data.unmatched_lines.length" class="report-section" style="margin-top: 14px">
        <h2>은행에만 있는 돈 {{ fmtMoney(data.unmatched_lines_total) }}</h2>
        <div class="scroll-x"><table class="tbl" data-testid="diff-lines">
          <thead><tr><th>거래일</th><th>적요</th><th class="num">금액</th><th class="num">남은 금액</th></tr></thead>
          <tbody><tr v-for="l in data.unmatched_lines" :key="l.id" data-testid="diff-line"><td>{{ l.date }}</td><td><router-link :to="{ name: 'record', params: { type: 'bank_line', id: l.id } }">{{ l.payment_ref || '은행 거래' }}</router-link></td><td class="num">{{ fmtMoney(l.amount) }}</td><td class="num">{{ fmtMoney(l.residual) }}</td></tr></tbody>
        </table></div>
      </section>
      <section v-if="data.unmatched_payments.length" class="report-section">
        <h2>장부에만 있는 돈 {{ fmtMoney(data.unmatched_payments_total) }}</h2>
        <div class="scroll-x"><table class="tbl" data-testid="diff-payments">
          <thead><tr><th>일자</th><th>번호</th><th>거래처</th><th>메모</th><th class="num">금액</th></tr></thead>
          <tbody><tr v-for="p in data.unmatched_payments" :key="p.id" data-testid="diff-payment"><td>{{ p.date }}</td><td><router-link :to="{ name: 'record', params: { type: 'payment', id: p.id } }">{{ p.number }}</router-link></td><td>{{ refLabel(p.partner_id) }}</td><td>{{ p.memo }}</td><td class="num">{{ fmtMoney(p.amount) }}</td></tr></tbody>
        </table></div>
      </section>
    </template>
  </div>
</template>

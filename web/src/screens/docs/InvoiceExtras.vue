<script setup lang="ts">
// Recording a payment against an invoice, and the way back to the order behind it.
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { messageOf, rpc } from '../../lib/api'
import { sendCommand } from '../../lib/commands'
import { fmtDay } from '../../lib/format'
import { writeBlock } from '../../lib/mode'
import { catalogOf, hasRole } from '../../lib/session'
import type { ErpRecord, Field, State } from '../../lib/types'
import { ask, toast } from '../../lib/ui'

const props = defineProps<{ record: ErpRecord | null }>()
const router = useRouter()

const origin = computed(() => {
  const s = props.record?.state
  return s?.origin_type && s?.origin_id && catalogOf(s.origin_type) ? { type: s.origin_type as string, id: s.origin_id as string, name: (s.origin_name as string) ?? '원본 문서' } : null
})
const isCustomerSide = computed(() => String(props.record?.state.move_type ?? '').startsWith('out_'))
const isCredit = computed(() => String(props.record?.state.move_type ?? '').endsWith('_refund'))
const label = computed(() => {
  const receiving = isCustomerSide.value !== isCredit.value
  return receiving ? '입금 등록' : '지급 등록'
})
const canPay = computed(() => !!catalogOf('payment') && hasRole(['accounting']) && !writeBlock.value
  && props.record?.status === 'posted' && ['not_paid', 'partial', 'in_payment'].includes(String(props.record?.state.payment_state)))

const FIELDS: Field[] = [
  { name: 'amount', label: '금액', type: 'money', required: true },
  { name: 'date', label: '날짜', type: 'date', required: true },
  { name: 'journal', label: '입금 수단', type: 'enum', required: true, default: 'bank', options: [{ value: 'bank', label: '은행' }, { value: 'cash', label: '현금' }] },
  { name: 'memo', label: '메모', type: 'text' },
]

const canCopy = computed(() => hasRole(['accounting']) && !writeBlock.value && props.record?.status === 'draft')

// Starts over from an earlier document of the same kind: its partner, terms and lines come along.
async function copyFromPast() {
  let values: State = {}
  let error = ''
  for (;;) {
    const answer = await ask({
      title: '지난 문서에서 새 초안', message: '고른 문서의 거래처·조건·줄로 새 초안을 만듭니다. 이 초안은 그대로 남습니다.', error, values, confirmLabel: '만들기',
      fields: [{ name: 'from_move', label: '지난 문서', type: 'ref', ref: 'account_move', required: true }],
    })
    if (!answer) return
    values = answer.values
    try {
      const res = await sendCommand({ type: 'account_move', command: 'create', payload: { from_move: values.from_move } })
      toast('새 초안을 만들었습니다.')
      await router.push({ name: 'record', params: { type: 'account_move', id: res.id } })
      return
    } catch (e) {
      error = messageOf(e)
    }
  }
}

async function pay() {
  if (!props.record) return
  const id = props.record.id
  const today = fmtDay(new Date().toISOString())
  // The suggested amount comes from the database: it knows installments and early payment discounts.
  let values: State = { date: today, journal: 'bank', amount: props.record.state.amount_residual }
  try {
    const p = await rpc<State>('erp_preview', { p_type: 'payment', p_payload: { from_moves: [id], date: today } })
    if (p?.amount) values.amount = p.amount
  } catch { /* the balance on the invoice still stands */ }
  let error = ''
  for (;;) {
    const answer = await ask({ title: label.value, message: `${props.record.name ?? '이 문서'}에 대해 등록합니다.`, error, fields: FIELDS, values, confirmLabel: '등록', wide: true })
    if (!answer) return
    values = answer.values
    try {
      await sendCommand({ type: 'payment', command: 'create', payload: { from_moves: [id], amount: values.amount, date: values.date, journal: values.journal, memo: values.memo || undefined } })
      toast(`${label.value}을 마쳤습니다.`)
      return
    } catch (e) {
      error = messageOf(e)
    }
  }
}
</script>

<template>
  <span class="row-wrap" data-testid="doc-extras">
    <router-link v-if="origin" class="btn btn-sm btn-ghost" :to="{ name: 'record', params: { type: origin.type, id: origin.id } }" data-testid="invoice-origin">{{ origin.name }}</router-link>
    <button v-if="canPay" type="button" class="btn" data-testid="invoice-pay" @click="pay">{{ label }}</button>
    <button v-if="canCopy" type="button" class="btn" data-testid="invoice-copy" @click="copyFromPast">지난 문서에서</button>
    <router-link v-if="record" class="btn" :to="{ name: 'print', params: { type: 'account_move', id: record.id } }" data-testid="doc-print">출력</router-link>
  </span>
</template>

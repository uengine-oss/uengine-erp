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

// Evidence often arrives after posting: the approval number comes from the tax office, and old documents have none.
const canEvidence = computed(() => hasRole(['accounting']) && !writeBlock.value && props.record?.status === 'posted')
const canTakeBack = computed(() => canEvidence.value && !isCredit.value && !props.record?.state.reversed_by)
const moveField = (name: string): Field | undefined => catalogOf('account_move')?.fields.find((f) => f.name === name)
async function writeEvidence() {
  if (!props.record) return
  let values: State = { evidence_type: props.record.state.evidence_type, approval_no: props.record.state.approval_no }
  let error = ''
  for (;;) {
    const answer = await ask({ title: '증빙 적기', message: '게시된 문서의 금액은 그대로이고 신고서 칸만 따라갑니다.', error, values, confirmLabel: '저장',
      fields: [moveField('evidence_type')!, moveField('approval_no')!] })
    if (!answer) return
    values = answer.values
    try {
      await sendCommand({ type: 'account_move', id: props.record.id, command: 'set_evidence', payload: { evidence_type: values.evidence_type || null, approval_no: values.approval_no || null } })
      toast('증빙을 적었습니다.')
      return
    } catch (e) {
      error = messageOf(e)
    }
  }
}
// The way back from a posted document: its payment is cancelled and its credit note posted in one command.
async function takeBack() {
  if (!props.record) return
  let values: State = { amend_reason: 'input_error' }
  let error = ''
  for (;;) {
    const answer = await ask({ title: '전표 취소', message: '이 문서의 입금을 취소하고 대변 메모를 게시합니다. 재고에 반영한 문서면 물건도 되돌립니다. 원래 기록은 지우지 않습니다. 수정세금계산서가 필요하면 매출은 홈택스에서 발급하고 매입은 공급자에게 요청하세요.', error, values, confirmLabel: '취소 처리', danger: true,
      fields: [{ ...moveField('amend_reason')!, required: true }, { name: 'reason', label: '사유', type: 'text', required: true }] })
    if (!answer) return
    values = answer.values
    try {
      const res = await sendCommand({ type: 'account_move', id: props.record.id, command: 'compensate', payload: { amend_reason: values.amend_reason }, reason: String(values.reason) })
      toast('대변 메모를 게시했습니다.')
      await router.push({ name: 'record', params: { type: 'account_move', id: res.id } })
      return
    } catch (e) {
      error = messageOf(e)
    }
  }
}

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
    <button v-if="canEvidence" type="button" class="btn" data-testid="invoice-evidence" @click="writeEvidence">증빙 적기</button>
    <button v-if="canTakeBack" type="button" class="btn" data-testid="invoice-take-back" @click="takeBack">전표 취소</button>
    <router-link v-if="record" class="btn" :to="{ name: 'print', params: { type: 'account_move', id: record.id } }" data-testid="doc-print">출력</router-link>
  </span>
</template>

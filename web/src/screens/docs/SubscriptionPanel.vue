<script setup lang="ts">
// What a subscription has billed and what came of each bill, and a change that waits for the next period. The periods are
// the subscription's own record of invoicing's events: this screen reads nothing of invoicing but a link to the invoice.
import { computed, ref } from 'vue'
import { messageOf } from '../../lib/api'
import { sendCommand } from '../../lib/commands'
import { fmtMoney } from '../../lib/format'
import { writeBlock } from '../../lib/mode'
import { catalogOf, hasRole } from '../../lib/session'
import type { CatalogDoc, ErpRecord, State } from '../../lib/types'
import { ask, toast } from '../../lib/ui'

const props = defineProps<{ record: ErpRecord | null; draft: State; doc: CatalogDoc; readonly: boolean }>()

const KIND: Record<string, string> = { order: '주문', period: '정기', proration: '변경분', credit: '해지 환급' }
const PAY: Record<string, { label: string; color: string }> = {
  pending: { label: '청구 대기', color: 'gray' }, draft: { label: '초안', color: 'gray' }, unpaid: { label: '미결제', color: 'blue' },
  partial: { label: '일부 입금', color: 'amber' }, paid: { label: '입금 완료', color: 'green' }, overdue: { label: '연체', color: 'red' },
  cancelled: { label: '청구 취소', color: 'gray' }, credit: { label: '대변 메모', color: 'violet' },
}

interface Period { id: string; no: number; kind: string; period_start: string; period_end: string; amount: number; invoice_id?: string; invoice_number?: string; due_date?: string; payment_state: string; origin?: string }
interface Pending { lines: State[]; amount: number; mrr: number; scheduled_on: string }

const s = computed(() => props.record?.state ?? {})
const periods = computed<Period[]>(() => [...((s.value.periods ?? []) as Period[])].reverse())
const pending = computed<Pending | null>(() => (s.value.pending as Pending | undefined) ?? null)
const canInvoice = computed(() => !!catalogOf('account_move'))
const canOrder = computed(() => !!catalogOf('sales_order'))
const canWrite = computed(() => !writeBlock.value && hasRole(['sales']))
const busy = ref(false)
const error = ref('')
const pay = (v: string) => PAY[v] ?? { label: v, color: 'gray' }
const lineText = (l: State) => `${l.name ?? ''} × ${Number(l.qty ?? 0)} = ${fmtMoney(l.subtotal)}`

async function run(command: 'apply_now' | 'cancel_change') {
  if (!props.record || busy.value) return
  const def = props.doc.extra_commands?.[command]
  const answer = await ask({ title: def?.label ?? command, message: def?.confirm, confirmLabel: def?.label ?? command, danger: command === 'cancel_change' })
  if (!answer) return
  busy.value = true
  error.value = ''
  try {
    await sendCommand({ type: 'subscription', id: props.record.id, command, payload: {}, expectedVersion: props.record.version })
    toast(command === 'apply_now' ? '변경을 오늘부터 적용했습니다.' : '변경을 취소했습니다.')
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section v-if="record && record.status !== 'draft'" class="sub no-print" data-testid="subscription-panel">
    <p v-if="s.payment_status === 'overdue'" class="banner banner-error" role="status" data-testid="subscription-overdue">
      미납: {{ s.overdue_since }}부터 만기가 지난 청구가 있습니다. 구독은 그대로 이어지고, 입금되면 이 표시가 사라집니다.
    </p>
    <p v-if="s.origin_cancelled" class="banner banner-warn" role="status" data-testid="subscription-origin-cancelled">
      원본 주문이 취소되었습니다. 이미 따로 청구한 기간이 있어 구독은 그대로 두었습니다. 계속할지 담당자가 정합니다.
    </p>
    <p v-if="s.origin_type === 'sales_order' && s.origin_id" class="muted small" data-testid="subscription-origin">
      주문
      <router-link v-if="canOrder" :to="{ name: 'record', params: { type: 'sales_order', id: s.origin_id } }">{{ s.origin }}</router-link>
      <template v-else>{{ s.origin }}</template>
      에서 생겼습니다. 첫 기간은 그 주문의 청구서로 청구합니다.
    </p>

    <div v-if="pending" class="pending" data-testid="subscription-pending">
      <h2>다음 기간부터 바뀌는 내용</h2>
      <p class="small">
        다음 청구일 <strong>{{ s.next_billing_date }}</strong>부터 월 반복 매출이
        <strong>{{ fmtMoney(s.mrr) }}</strong> → <strong data-testid="subscription-pending-mrr">{{ fmtMoney(pending.mrr) }}</strong> 이 됩니다.
      </p>
      <ul class="small">
        <li v-for="l in pending.lines" :key="String(l.id)">{{ lineText(l) }}</li>
      </ul>
      <p v-if="error" class="err-text small" role="alert">{{ error }}</p>
      <div v-if="canWrite" class="actions">
        <button v-if="record.status === 'active'" type="button" class="btn btn-primary btn-sm" :disabled="busy" data-testid="subscription-apply-now" @click="run('apply_now')">지금 적용(남은 날 정산)</button>
        <button type="button" class="btn btn-sm" :disabled="busy" data-testid="subscription-cancel-change" @click="run('cancel_change')">변경 취소</button>
      </div>
    </div>

    <h2>청구 기간 <span class="muted small">기간마다 미리 청구합니다. 입금 상태는 청구 모듈이 알려 줍니다.</span></h2>
    <table v-if="periods.length" class="tbl" data-testid="subscription-periods">
      <thead><tr><th>구분</th><th>기간</th><th class="num">금액</th><th>청구서</th><th>만기일</th><th>입금</th></tr></thead>
      <tbody>
        <tr v-for="p in periods" :key="p.id" data-testid="subscription-period" :data-state="p.payment_state">
          <td>{{ KIND[p.kind] ?? p.kind }}</td>
          <td>{{ p.period_start }} ~ {{ p.period_end }}</td>
          <td class="num">{{ fmtMoney(p.amount) }}</td>
          <td>
            <router-link v-if="p.invoice_id && canInvoice" :to="{ name: 'record', params: { type: 'account_move', id: p.invoice_id } }">{{ p.invoice_number || '초안' }}</router-link>
            <span v-else-if="p.kind === 'order'" class="muted">주문에서 청구</span>
          </td>
          <td>{{ p.due_date ?? '' }}</td>
          <td><span class="pill" :class="`pill-${pay(p.payment_state).color}`">{{ pay(p.payment_state).label }}</span></td>
        </tr>
      </tbody>
    </table>
    <p v-else class="muted small" data-testid="subscription-no-periods">아직 청구한 기간이 없습니다. 시작일이 되면 청구합니다.</p>
  </section>
</template>

<style scoped>
/* Room under the last bill, so it is not left under a toast at the foot of the screen. */
.sub { margin-top: 16px; padding: 12px 0 72px; border-top: 1px solid var(--line); }
.sub h2 { display: flex; align-items: baseline; gap: 8px; margin: 10px 0 6px; font-size: 13px; }
.pending { margin: 8px 0; padding: 8px 10px; background: var(--navy-50); border-radius: var(--radius-sm); }
.pending h2 { margin-top: 0; }
.pending ul { margin: 4px 0 6px 16px; padding: 0; }
.actions { display: flex; gap: 6px; }
</style>

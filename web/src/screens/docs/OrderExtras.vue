<script setup lang="ts">
// The way from a sales order to what came of it, and to an invoice. The modules do not know each other, so the paths live here.
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { messageOf } from '../../lib/api'
import { sendCommand } from '../../lib/commands'
import { writeBlock } from '../../lib/mode'
import { catalogOf, hasRole } from '../../lib/session'
import type { ErpRecord, Field } from '../../lib/types'
import { ask, toast } from '../../lib/ui'

const props = defineProps<{ record: ErpRecord | null }>()
const router = useRouter()

const pickings = computed<{ id: string; number: string; state: string }[]>(() => (catalogOf('picking') ? props.record?.state.pickings ?? [] : []))
const invoices = computed<{ id: string; number: string | null; state: string }[]>(() => (catalogOf('account_move') ? props.record?.state.invoices ?? [] : []))
const canInvoice = computed(() => !!catalogOf('account_move') && hasRole(['accounting']) && !writeBlock.value && props.record?.status === 'sale')

const METHOD: Field = {
  name: 'method', label: '청구 방식', type: 'enum', required: true, default: 'regular',
  options: [{ value: 'regular', label: '남은 수량 전부' }, { value: 'percentage', label: '선금: 비율(%)' }, { value: 'fixed', label: '선금: 정액' }],
}
const AMOUNT: Field = { name: 'amount', label: '비율 또는 금액', type: 'number', help: '선금일 때만 씁니다.' }

async function invoice() {
  let values: Record<string, any> = {}
  let error = ''
  for (;;) {
    const answer = await ask({ title: '청구서 만들기', message: '이 주문으로 청구서 초안을 만듭니다. 게시 전까지 고칠 수 있습니다.', error, fields: [METHOD, AMOUNT], values, confirmLabel: '만들기' })
    if (!answer || !props.record) return
    values = answer.values
    try {
      const res = await sendCommand({
        type: 'account_move', command: 'create',
        payload: { from_sales_order: props.record.id, method: values.method, ...(values.method === 'regular' ? {} : { amount: values.amount }) },
      })
      toast('청구서 초안을 만들었습니다.')
      await router.push({ name: 'record', params: { type: 'account_move', id: res.id } })
      return
    } catch (e) {
      error = messageOf(e)
    }
  }
}
</script>

<template>
  <span class="row-wrap" data-testid="doc-extras">
    <router-link v-for="p in pickings" :key="p.id" class="btn btn-sm btn-ghost" :to="{ name: 'record', params: { type: 'picking', id: p.id } }" data-testid="order-picking">{{ p.number }}</router-link>
    <router-link v-for="i in invoices" :key="i.id" class="btn btn-sm btn-ghost" :to="{ name: 'record', params: { type: 'account_move', id: i.id } }" data-testid="order-invoice">{{ i.number ?? '청구서 초안' }}</router-link>
    <button v-if="canInvoice" type="button" class="btn" data-testid="order-make-invoice" @click="invoice">청구서 만들기</button>
  </span>
</template>

<script setup lang="ts">
// Money or credit waiting for this partner, offered on the document it could settle.
import { computed, ref, watch } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { sendCommand } from '../../lib/commands'
import { fmtMoney } from '../../lib/format'
import { writeBlock } from '../../lib/mode'
import { catalogOf, hasRole } from '../../lib/session'
import type { ErpRecord } from '../../lib/types'
import { toast } from '../../lib/ui'

interface Credit { kind: 'payment' | 'credit_note'; id: string; number: string | null; date: string | null; amount: number }

const props = defineProps<{ record: ErpRecord | null }>()
const credits = ref<Credit[]>([])
const busy = ref('')
const isInvoice = computed(() => ['out_invoice', 'in_invoice'].includes(String(props.record?.state.move_type)))
const open = computed(() => !!catalogOf('payment') && hasRole(['accounting']) && props.record?.status === 'posted' && isInvoice.value && Number(props.record?.state.amount_residual ?? 0) !== 0)

async function load() {
  if (!open.value) { credits.value = []; return }
  try {
    credits.value = await rpc<Credit[]>('erp_outstanding', { p_partner_id: props.record?.state.partner_id, p_side: String(props.record?.state.move_type).startsWith('out_') ? 'customer' : 'supplier' })
  } catch { credits.value = [] }
}
watch(() => [props.record?.id, props.record?.version, open.value], load, { immediate: true })

async function connect(c: Credit) {
  if (!props.record) return
  busy.value = c.id
  try {
    if (c.kind === 'payment') await sendCommand({ type: 'payment', id: c.id, command: 'allocate', payload: { move_id: props.record.id } })
    else await sendCommand({ type: 'account_move', id: props.record.id, command: 'apply_credit', payload: { credit_move_id: c.id } })
    toast('이 문서에 연결했습니다.')
    await load()
  } catch (e) {
    toast(messageOf(e), 'error')
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <section v-if="credits.length" class="banner banner-info no-print credits" data-testid="invoice-outstanding">
    <div class="grow">
      <strong>같은 거래처에 아직 연결하지 않은 금액이 {{ credits.length }}건 있습니다.</strong>
      <ul class="credit-list">
        <li v-for="c in credits" :key="`${c.kind}${c.id}`" data-testid="outstanding-row">
          <span>{{ c.kind === 'payment' ? '입금' : '대변 메모' }} {{ c.number }} · {{ c.date }} · {{ fmtMoney(c.amount) }}</span>
          <button v-if="!writeBlock" type="button" class="btn btn-sm" :disabled="busy === c.id" data-testid="outstanding-connect" @click="connect(c)">연결</button>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.credits { margin-top: 12px; align-items: flex-start; }
.credit-list { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.credit-list li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
</style>

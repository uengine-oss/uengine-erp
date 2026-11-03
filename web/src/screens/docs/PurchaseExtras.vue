<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { messageOf } from '../../lib/api'
import { sendCommand } from '../../lib/commands'
import { writeBlock } from '../../lib/mode'
import { catalogOf, hasRole } from '../../lib/session'
import type { ErpRecord } from '../../lib/types'
import { toast } from '../../lib/ui'

const props = defineProps<{ record: ErpRecord | null }>()
const router = useRouter()

const canBill = computed(() => !!catalogOf('account_move') && hasRole(['accounting']) && !writeBlock.value && props.record?.status === 'purchase')

// A receipt slip comes from the order through events; the order keeps what it heard about each one.
const receipts = computed<{ id: string; number: string }[]>(() => (catalogOf('picking') ? Object.entries(props.record?.state.pickings ?? {}).map(([id, p]) => ({ id, number: (p as { number?: string }).number ?? '입고 전표' })) : []))
const canShop = computed(() => hasRole(['purchase']) && !writeBlock.value && ['draft', 'sent'].includes(String(props.record?.status)))

async function bill() {
  if (!props.record) return
  try {
    const res = await sendCommand({ type: 'account_move', command: 'create', payload: { from_purchase_order: props.record.id } })
    toast('공급사 청구서 초안을 만들었습니다.')
    await router.push({ name: 'record', params: { type: 'account_move', id: res.id } })
  } catch (e) {
    toast(messageOf(e), 'error')
  }
}
</script>

<template>
  <span class="row-wrap" data-testid="doc-extras">
    <router-link v-for="p in receipts" :key="p.id" class="btn btn-sm btn-ghost" :to="{ name: 'record', params: { type: 'picking', id: p.id } }" data-testid="po-receipt">{{ p.number }}</router-link>
    <button v-if="canBill" type="button" class="btn" data-testid="po-make-bill" @click="bill">공급사 청구서 만들기</button>
    <router-link v-if="canShop && record?.state.partner_id" class="btn" :to="{ name: 'purchase-catalog', query: { order: record.id } }" data-testid="po-catalog">카탈로그</router-link>
    <router-link v-if="record" class="btn" :to="{ name: 'print', params: { type: 'purchase_order', id: record.id } }" data-testid="doc-print">출력</router-link>
  </span>
</template>

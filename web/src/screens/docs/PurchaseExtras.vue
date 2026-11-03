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
  <button v-if="canBill" type="button" class="btn" data-testid="po-make-bill" @click="bill">공급사 청구서 만들기</button>
</template>

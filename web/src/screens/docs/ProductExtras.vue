<script setup lang="ts">
// From a product to its stock. The menu's stock screens open here narrowed to this product.
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { writeBlock } from '../../lib/mode'
import { catalogOf } from '../../lib/session'
import { canAdjustStock, canReplenish, editOnHand, pickVariant, replenishNow } from '../../lib/stockActions'
import type { ErpRecord } from '../../lib/types'

const props = defineProps<{ record: ErpRecord | null }>()
const router = useRouter()
const stocked = computed(() => !!catalogOf('picking') && !!props.record?.state.is_storable)

async function open(name: 'stock-forecast' | 'stock-moves') {
  if (!props.record) return
  const variant = await pickVariant(props.record)
  if (!variant) return
  if (name === 'stock-forecast') await router.push({ name, params: { variant } })
  else await router.push({ name, query: { variant } })
}
async function edit() {
  const variant = props.record && await pickVariant(props.record)
  if (variant) await editOnHand({ variantId: variant })
}
async function replenish() {
  const variant = props.record && await pickVariant(props.record)
  if (variant) await replenishNow(variant)
}
</script>

<template>
  <span v-if="stocked" class="row-wrap" data-testid="doc-extras">
    <button type="button" class="btn" data-testid="product-moves" @click="open('stock-moves')">이동 내역</button>
    <button type="button" class="btn" data-testid="product-forecast" @click="open('stock-forecast')">예측</button>
    <button v-if="canAdjustStock() && !writeBlock" type="button" class="btn" data-testid="product-edit-stock" @click="edit">현재고 수정</button>
    <button v-if="canReplenish() && !writeBlock" type="button" class="btn" data-testid="product-replenish" @click="replenish">보충</button>
  </span>
</template>

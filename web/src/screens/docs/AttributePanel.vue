<script setup lang="ts">
// Which products use this attribute. The products hold the link, so the database is asked by containment.
import { ref, watch } from 'vue'
import { db } from '../../lib/conn'
import { rows } from '../../lib/load'
import type { ErpRecord } from '../../lib/types'

const props = defineProps<{ record: ErpRecord | null }>()
const products = ref<{ id: string; name: string | null }[]>([])

watch(() => props.record?.id, async (id) => {
  if (!id) { products.value = []; return }
  try {
    products.value = await rows(db().from('erp_records').select('id,name').eq('type', 'product').contains('state', { attributes: [{ attribute_id: id }] }).order('name').limit(100))
  } catch { products.value = [] }
}, { immediate: true })
</script>

<template>
  <section v-if="record" class="form-note" data-testid="attribute-products">
    <h2>이 속성을 쓰는 제품 {{ products.length }}개</h2>
    <p v-if="!products.length" class="muted small">아직 쓰는 제품이 없습니다.</p>
    <div class="chip-row"><router-link v-for="p in products" :key="p.id" class="tag" :to="{ name: 'record', params: { type: 'product', id: p.id } }" data-testid="attribute-product">{{ p.name }}</router-link></div>
  </section>
</template>

<style scoped>
.form-note { margin-top: 14px; }
.form-note h2 { margin-bottom: 4px; font-size: 13px; }
</style>

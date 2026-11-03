<script setup lang="ts">
import { computed } from 'vue'
import type { CatalogDoc } from '../lib/types'
import { stateOf } from '../lib/fields'

const props = defineProps<{ doc: CatalogDoc; value: string | null | undefined }>()
const def = computed(() => stateOf(props.doc, props.value))
const COLORS = new Set(['gray', 'blue', 'green', 'amber', 'red', 'violet'])
const color = computed(() => {
  const c = def.value?.color === 'orange' ? 'amber' : def.value?.color
  return c && COLORS.has(c) ? c : 'gray'
})
</script>

<template>
  <span v-if="value" class="pill" :class="`pill-${color}`">{{ def?.label ?? value }}</span>
</template>

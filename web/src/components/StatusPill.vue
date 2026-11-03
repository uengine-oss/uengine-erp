<script setup lang="ts">
import { computed } from 'vue'
import type { CatalogDoc } from '../lib/types'
import { stateOf } from '../lib/fields'

const props = defineProps<{ doc: CatalogDoc; value: string | null | undefined }>()
const def = computed(() => stateOf(props.doc, props.value))
const COLORS = new Set(['gray', 'blue', 'green', 'amber', 'red', 'violet'])
const color = computed(() => (def.value?.color && COLORS.has(def.value.color) ? def.value.color : 'gray'))
</script>

<template>
  <span v-if="value" class="pill" :class="`pill-${color}`">{{ def?.label ?? value }}</span>
</template>

<script setup lang="ts">
// A single amount next to its number in a table row. The number is the reading; this only shows how it compares.
import { computed } from 'vue'

const props = defineProps<{ value: number; max: number }>()
const share = computed(() => (props.max > 0 ? Math.max(0, props.value) / props.max : 0))
</script>

<template>
  <svg class="value" width="100%" height="10" aria-hidden="true"><rect :width="`${Math.max(share * 100, value > 0 ? 0.5 : 0)}%`" height="10" rx="2" /></svg>
</template>

<style scoped>
.value { display: block; min-width: 60px; }
rect { fill: var(--navy-700); }
</style>

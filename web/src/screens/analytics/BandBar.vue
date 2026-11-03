<script setup lang="ts">
// One 80% interval on a shared scale: the bar runs from P10 to P90, the tick is P50, the line is zero.
import { computed } from 'vue'
import type { Band } from '../../lib/forecast/types.ts'

const props = defineProps<{ band: Band; min: number; max: number; ariaLabel?: string }>()

const span = computed(() => props.max - props.min || 1)
const at = (v: number) => `${Math.min(100, Math.max(0, ((v - props.min) / span.value) * 100))}%`
const barWidth = computed(() => `${Math.max(0.5, ((props.band.p90 - props.band.p10) / span.value) * 100)}%`)
const crossesZero = computed(() => props.min < 0 && props.max > 0)
</script>

<template>
  <svg class="band" width="100%" height="14" role="img" :aria-label="ariaLabel">
    <line v-if="crossesZero" class="zero" :x1="at(0)" :x2="at(0)" y1="0" y2="14" />
    <rect class="range" :x="at(band.p10)" y="3" :width="barWidth" height="8" rx="2" />
    <line class="middle" :x1="at(band.p50)" :x2="at(band.p50)" y1="1" y2="13" />
  </svg>
</template>

<style scoped>
.band { display: block; min-width: 90px; }
.zero { stroke: var(--line-strong); stroke-width: 1; stroke-dasharray: 2 2; }
.range { fill: var(--navy-300); }
.middle { stroke: var(--text); stroke-width: 2; }
</style>

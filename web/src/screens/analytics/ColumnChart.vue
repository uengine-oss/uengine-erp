<script setup lang="ts">
// Columns over time, as bars from zero or as a range with its middle marked. Drawn at the real pixel size, so
// labels stay readable at phone width. One series, so the title names it and there is no legend.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Band } from '../../lib/forecast/types.ts'
import { fmtAxis } from './fmt'

export interface ColumnRow { key: string; label: string; value?: number; band?: Band; tip?: string }

const props = withDefaults(defineProps<{ rows: ColumnRow[]; format: (v: number) => string; height?: number; description: string }>(), { height: 180 })

const box = ref<HTMLElement | null>(null)
const width = ref(640)
let observer: ResizeObserver | undefined
onMounted(() => {
  if (!box.value) return
  width.value = box.value.clientWidth || 640
  observer = new ResizeObserver(() => { if (box.value?.clientWidth) width.value = box.value.clientWidth })
  observer.observe(box.value)
})
onBeforeUnmount(() => observer?.disconnect())

const LEFT = 48
const RIGHT = 8
const TOP = 10
const BOTTOM = 24

function niceStep(span: number): number {
  const raw = span / 3 || 1
  const mag = 10 ** Math.floor(Math.log10(raw))
  const unit = raw / mag
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * mag
}

const scale = computed(() => {
  const values = props.rows.flatMap((r) => (r.band ? [r.band.p10, r.band.p90] : [r.value ?? 0]))
  const lo = Math.min(0, ...values)
  const hi = Math.max(0, ...values)
  const step = niceStep(hi - lo)
  const min = lo < 0 ? Math.floor(lo / step) * step : 0
  const max = Math.ceil(hi / step) * step || step
  const ticks: number[] = []
  for (let t = min; t <= max + step / 2; t += step) ticks.push(t)
  const inner = props.height - TOP - BOTTOM
  return { min, max, ticks, y: (v: number) => TOP + (1 - (v - min) / (max - min || 1)) * inner }
})

const plotWidth = computed(() => Math.max(10, width.value - LEFT - RIGHT))
const slot = computed(() => plotWidth.value / Math.max(1, props.rows.length))
const markWidth = computed(() => Math.max(2, Math.min(22, slot.value - 2)))
const xOf = (i: number) => LEFT + slot.value * i + slot.value / 2
// Labels thin out so they never collide; the tooltip and the table beside the chart carry every one.
const labelEvery = computed(() => Math.max(1, Math.ceil(64 / slot.value)))

const hover = ref<number | null>(null)
const hovered = computed(() => (hover.value === null ? null : props.rows[hover.value]))
const tipStyle = computed(() => {
  if (hover.value === null) return {}
  const x = xOf(hover.value)
  return x > width.value / 2 ? { right: `${width.value - x + 8}px` } : { left: `${x + 8}px` }
})
const tipText = (r: ColumnRow) => r.tip ?? (r.band ? `${props.format(r.band.p10)} ~ ${props.format(r.band.p90)}` : props.format(r.value ?? 0))
</script>

<template>
  <div ref="box" class="chart" data-testid="column-chart">
    <svg :width="width" :height="height" role="img" :aria-label="description" @mouseleave="hover = null">
      <g class="grid">
        <line v-for="t in scale.ticks" :key="t" :x1="LEFT" :x2="width - RIGHT" :y1="scale.y(t)" :y2="scale.y(t)" :class="{ zero: t === 0 }" />
        <text v-for="t in scale.ticks" :key="`l${t}`" :x="LEFT - 6" :y="scale.y(t) + 4" text-anchor="end">{{ fmtAxis(t) }}</text>
      </g>
      <g v-for="(r, i) in rows" :key="r.key">
        <template v-if="r.band">
          <rect class="range" :class="{ on: hover === i }" :x="xOf(i) - markWidth / 2" :y="scale.y(r.band.p90)" :width="markWidth" :height="Math.max(2, scale.y(r.band.p10) - scale.y(r.band.p90))" rx="2" />
          <line class="middle" :x1="xOf(i) - markWidth / 2" :x2="xOf(i) + markWidth / 2" :y1="scale.y(r.band.p50)" :y2="scale.y(r.band.p50)" />
        </template>
        <rect v-else class="bar" :class="{ on: hover === i }" :x="xOf(i) - markWidth / 2" :y="Math.min(scale.y(r.value ?? 0), scale.y(0))" :width="markWidth" :height="Math.max(1, Math.abs(scale.y(r.value ?? 0) - scale.y(0)))" rx="2" />
        <text v-if="i % labelEvery === 0" class="x" :x="xOf(i)" :y="height - 8" text-anchor="middle">{{ r.label }}</text>
        <!-- The hit area is the whole column, wider than the mark. -->
        <rect class="hit" :x="LEFT + slot * i" :y="0" :width="slot" :height="height" tabindex="0" :aria-label="`${r.label}: ${tipText(r)}`" @mouseenter="hover = i" @focus="hover = i" @blur="hover = null" />
      </g>
    </svg>
    <div v-if="hovered" class="tip" :style="tipStyle" role="status" data-testid="chart-tip"><strong>{{ hovered.label }}</strong><br />{{ tipText(hovered) }}</div>
  </div>
</template>

<style scoped>
.chart { position: relative; width: 100%; }
svg { display: block; }
.grid line { stroke: var(--line); stroke-width: 1; }
.grid line.zero { stroke: var(--line-strong); }
.grid text, .x { fill: var(--text-3); font-size: 11px; font-variant-numeric: tabular-nums; }
.bar { fill: var(--navy-700); }
.range { fill: var(--navy-300); }
.bar.on { fill: var(--navy-800); }
.range.on { fill: var(--navy-600); }
.middle { stroke: var(--text); stroke-width: 2; }
.hit { fill: transparent; outline: none; }
.hit:focus-visible { stroke: var(--navy-600); stroke-width: 1; }
.tip { position: absolute; top: 4px; z-index: 5; padding: 4px 8px; background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow-pop); font-size: 12px; white-space: nowrap; pointer-events: none; }
</style>

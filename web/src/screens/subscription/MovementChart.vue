<script setup lang="ts">
// How MRR moved each month: what came in stacked above zero, what went out below it. One axis, one unit (money a month).
// The legend names every colour and the table under the chart carries every figure, so no colour stands alone.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { fmtAxis } from '../analytics/fmt'

export interface MoveMonth { month: string; new: number; expansion: number; reactivation: number; contraction: number; churn: number; mrr_start: number; mrr_end: number }

const props = withDefaults(defineProps<{ months: MoveMonth[]; format: (v: number) => string; height?: number }>(), { height: 220 })

const UP = [{ key: 'new', label: '신규' }, { key: 'expansion', label: '확장' }, { key: 'reactivation', label: '재개' }] as const
const DOWN = [{ key: 'contraction', label: '축소' }, { key: 'churn', label: '해지' }] as const
type Key = (typeof UP)[number]['key'] | (typeof DOWN)[number]['key']

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

const LEFT = 52
const RIGHT = 8
const TOP = 10
const BOTTOM = 24
const GAP = 2

const num = (m: MoveMonth, k: Key) => Number(m[k] ?? 0)
function niceStep(span: number): number {
  const raw = span / 4 || 1
  const mag = 10 ** Math.floor(Math.log10(raw))
  const unit = raw / mag
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * mag
}
const scale = computed(() => {
  const hi = Math.max(0, ...props.months.map((m) => UP.reduce((a, u) => a + num(m, u.key), 0)))
  const lo = -Math.max(0, ...props.months.map((m) => DOWN.reduce((a, d) => a + num(m, d.key), 0)))
  const step = niceStep(hi - lo || 1)
  const min = Math.floor(lo / step) * step
  const max = Math.ceil(hi / step) * step || step
  const ticks: number[] = []
  for (let t = min; t <= max + step / 2; t += step) ticks.push(t)
  const inner = props.height - TOP - BOTTOM
  return { ticks, y: (v: number) => TOP + (1 - (v - min) / (max - min || 1)) * inner }
})
const slot = computed(() => Math.max(10, width.value - LEFT - RIGHT) / Math.max(1, props.months.length))
const barWidth = computed(() => Math.max(4, Math.min(28, slot.value * 0.6)))
const xOf = (i: number) => LEFT + slot.value * i + slot.value / 2
const labelEvery = computed(() => Math.max(1, Math.ceil(56 / slot.value)))

// Segments stacked away from zero, each a little short of the next so a 2px gap of the surface shows between them.
const stacks = computed(() => props.months.map((m) => {
  const segs: { key: Key; y: number; h: number }[] = []
  let at = 0
  for (const u of UP) {
    const v = num(m, u.key)
    if (v <= 0) continue
    const top = scale.value.y(at + v); const bottom = scale.value.y(at)
    segs.push({ key: u.key, y: top, h: Math.max(1, bottom - top - (at > 0 ? GAP : 0)) })
    at += v
  }
  at = 0
  for (const d of DOWN) {
    const v = num(m, d.key)
    if (v <= 0) continue
    const top = scale.value.y(-at); const bottom = scale.value.y(-at - v)
    segs.push({ key: d.key, y: top + (at > 0 ? GAP : 0), h: Math.max(1, bottom - top - (at > 0 ? GAP : 0)) })
    at += v
  }
  return segs
}))

const hover = ref<number | null>(null)
const hovered = computed(() => (hover.value === null ? null : props.months[hover.value]))
const tipStyle = computed(() => {
  if (hover.value === null) return {}
  const x = xOf(hover.value)
  return x > width.value / 2 ? { right: `${width.value - x + 8}px` } : { left: `${x + 8}px` }
})
const describe = computed(() => props.months.map((m) => `${m.month} 신규 ${props.format(m.new)}, 확장 ${props.format(m.expansion)}, 재개 ${props.format(m.reactivation)}, 축소 ${props.format(m.contraction)}, 해지 ${props.format(m.churn)}`).join('. '))
</script>

<template>
  <div class="move" data-testid="mrr-movement-chart">
    <ul class="legend" aria-hidden="true">
      <li v-for="s in [...UP, ...DOWN]" :key="s.key"><i :class="`k-${s.key}`" />{{ s.label }}</li>
    </ul>
    <div ref="box" class="chart">
      <svg :width="width" :height="height" role="img" :aria-label="`월별 MRR 증감. ${describe}`" @mouseleave="hover = null">
        <g class="grid">
          <line v-for="t in scale.ticks" :key="t" :x1="LEFT" :x2="width - RIGHT" :y1="scale.y(t)" :y2="scale.y(t)" :class="{ zero: t === 0 }" />
          <text v-for="t in scale.ticks" :key="`l${t}`" :x="LEFT - 6" :y="scale.y(t) + 4" text-anchor="end">{{ fmtAxis(t) }}</text>
        </g>
        <g v-for="(m, i) in months" :key="m.month">
          <rect v-for="seg in stacks[i]" :key="seg.key" :class="[`k-${seg.key}`, { on: hover === i }]" :x="xOf(i) - barWidth / 2" :y="seg.y" :width="barWidth" :height="seg.h" rx="2" :data-key="seg.key" />
          <text v-if="i % labelEvery === 0" class="x" :x="xOf(i)" :y="height - 8" text-anchor="middle">{{ m.month.slice(2) }}</text>
          <rect class="hit" :x="LEFT + slot * i" y="0" :width="slot" :height="height" tabindex="0" :aria-label="m.month" @mouseenter="hover = i" @focus="hover = i" @blur="hover = null" />
        </g>
      </svg>
      <div v-if="hovered" class="tip" :style="tipStyle" role="status" data-testid="mrr-movement-tip">
        <strong>{{ hovered.month }}</strong>
        <div v-for="s in UP" :key="s.key"><i :class="`k-${s.key}`" />{{ s.label }} +{{ format(num(hovered, s.key)) }}</div>
        <div v-for="s in DOWN" :key="s.key"><i :class="`k-${s.key}`" />{{ s.label }} −{{ format(num(hovered, s.key)) }}</div>
        <div class="muted">월말 MRR {{ format(hovered.mrr_end) }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.move {
  --k-new: #3a62b8; --k-expansion: #2f8a5b; --k-reactivation: #7a5cc4; --k-contraction: #c08a1e; --k-churn: #c0392b;
}
@media screen and (prefers-color-scheme: dark) {
  .move { --k-new: #6a8fd6; --k-expansion: #4aa87a; --k-reactivation: #9a80dc; --k-contraction: #cf9f3c; --k-churn: #e05a4e; }
}
.chart { position: relative; width: 100%; }
svg { display: block; }
.grid line { stroke: var(--line); stroke-width: 1; }
.grid line.zero { stroke: var(--line-strong); }
.grid text, .x { fill: var(--text-3); font-size: 11px; font-variant-numeric: tabular-nums; }
rect.k-new { fill: var(--k-new); } rect.k-expansion { fill: var(--k-expansion); } rect.k-reactivation { fill: var(--k-reactivation); }
rect.k-contraction { fill: var(--k-contraction); } rect.k-churn { fill: var(--k-churn); }
rect.on { opacity: 0.85; }
.hit { fill: transparent; outline: none; }
.hit:focus-visible { stroke: var(--navy-600); stroke-width: 1; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 0 0 6px; padding: 0; list-style: none; font-size: 12px; color: var(--text-2); }
.legend li, .tip div { display: flex; align-items: center; gap: 5px; }
i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
i.k-new { background: var(--k-new); } i.k-expansion { background: var(--k-expansion); } i.k-reactivation { background: var(--k-reactivation); }
i.k-contraction { background: var(--k-contraction); } i.k-churn { background: var(--k-churn); }
.tip { position: absolute; top: 4px; z-index: 5; padding: 6px 8px; background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow-pop); font-size: 12px; white-space: nowrap; pointer-events: none; font-variant-numeric: tabular-nums; }
</style>

<script setup lang="ts">
import { computed } from 'vue'
import type { CatalogDoc } from '../lib/types'

const props = defineProps<{ doc: CatalogDoc; value: string | null | undefined }>()

// Terminal off-path states (cancelled, reversed) appear only while the record is in them.
const OFF_PATH = /cancel|revers|reject|expired|declin/
const steps = computed(() => {
  const states = props.doc.states ?? []
  return states.filter((s) => !(OFF_PATH.test(s.value) || s.color === 'red') || s.value === props.value)
})
const currentIndex = computed(() => steps.value.findIndex((s) => s.value === props.value))
</script>

<template>
  <ol v-if="steps.length > 1" class="pipeline" aria-label="상태">
    <li v-for="(s, i) in steps" :key="s.value" :class="{ on: i === currentIndex, past: i < currentIndex, bad: i === currentIndex && (s.color === 'red') }" :aria-current="i === currentIndex ? 'step' : undefined">
      {{ s.label }}
    </li>
  </ol>
</template>

<style scoped>
.pipeline { display: inline-flex; margin: 0; padding: 0; list-style: none; flex: none; }
.pipeline li {
  position: relative; display: flex; align-items: center; height: 24px; padding: 0 12px 0 16px;
  background: var(--ink-100); color: var(--text-3); font-size: 12px; white-space: nowrap;
  clip-path: polygon(0 0, calc(100% - 7px) 0, 100% 50%, calc(100% - 7px) 100%, 0 100%, 7px 50%);
  margin-left: -5px;
}
.pipeline li:first-child { padding-left: 10px; margin-left: 0; clip-path: polygon(0 0, calc(100% - 7px) 0, 100% 50%, calc(100% - 7px) 100%, 0 100%); border-radius: 3px 0 0 3px; }
.pipeline li.past { background: var(--navy-100); color: var(--navy-800); }
.pipeline li.on { background: var(--navy-700); color: var(--on-brand); font-weight: 600; }
.pipeline li.bad { background: var(--red-fg); color: #fff; }
@media screen {
  /* 대화: separate round steps instead of a chevron band. */
  :root[data-theme='talk'] .pipeline { gap: 4px; }
  :root[data-theme='talk'] .pipeline li, :root[data-theme='talk'] .pipeline li:first-child { margin-left: 0; padding: 0 11px; border-radius: 999px; clip-path: none; }
}
</style>

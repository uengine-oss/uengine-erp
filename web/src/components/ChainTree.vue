<script setup lang="ts">
import { computed } from 'vue'
import type { ErpEvent } from '../lib/types'
import ChainNode, { type TreeNode } from './ChainNode.vue'

const props = defineProps<{ events: ErpEvent[]; selected: number | null }>()
defineEmits<{ select: [event: ErpEvent] }>()

const tree = computed(() => {
  const nodes = new Map<number, TreeNode>()
  for (const e of props.events) nodes.set(e.seq, { event: e, children: [] })
  const roots: TreeNode[] = []
  for (const n of nodes.values()) {
    const parent = n.event.causation_seq ? nodes.get(n.event.causation_seq) : undefined
    if (parent) parent.children.push(n)
    else roots.push(n)
  }
  return roots
})
// A cause outside the list means row security hid it from this user.
const hasHidden = computed(() => {
  const seqs = new Set(props.events.map((e) => e.seq))
  return props.events.some((e) => e.causation_seq && !seqs.has(e.causation_seq))
})
</script>

<template>
  <ul class="chain chain-root" data-testid="chain-tree">
    <ChainNode v-for="n in tree" :key="n.event.seq" :node="n" :selected="selected" @select="$emit('select', $event)" />
  </ul>
  <p v-if="hasHidden" class="hint" style="margin-top: 6px">권한이 없는 유형의 이벤트는 사슬에서 빠져 있습니다.</p>
</template>

<style>
.chain { list-style: none; margin: 0; padding: 0 0 0 14px; border-left: 1px solid var(--line-strong); }
.chain-root { padding-left: 0; border-left: 0; }
.chain-item { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; width: 100%; padding: 4px 6px; border: 0; border-radius: var(--radius-sm); background: none; text-align: left; cursor: pointer; }
.chain-item:hover { background: var(--ink-50); }
.chain-item.on { background: var(--navy-100); }
.chain-title { font-weight: 600; }
</style>

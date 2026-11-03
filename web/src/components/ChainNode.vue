<script setup lang="ts">
import type { ErpEvent } from '../lib/types'
import { eventLabel, sourceColor, sourceLabel } from '../lib/eventText'
import { catalogOf } from '../lib/session'
import { fmtTime } from '../lib/format'

export interface TreeNode { event: ErpEvent; children: TreeNode[] }

defineProps<{ node: TreeNode; selected: number | null }>()
defineEmits<{ select: [event: ErpEvent] }>()
</script>

<template>
  <li>
    <button type="button" class="chain-item" :class="{ on: selected === node.event.seq }" @click="$emit('select', node.event)">
      <span class="chain-title">{{ eventLabel(node.event.event_type, catalogOf(node.event.stream_type)?.label) }}</span>
      <span class="muted small">{{ catalogOf(node.event.stream_type)?.label ?? node.event.stream_type }} · #{{ node.event.seq }} · {{ fmtTime(node.event.occurred_at) }}</span>
      <span class="pill" :class="`pill-${sourceColor(node.event.source)}`">{{ sourceLabel(node.event.source) }}</span>
    </button>
    <ul v-if="node.children.length" class="chain">
      <ChainNode v-for="c in node.children" :key="c.event.seq" :node="c" :selected="selected" @select="$emit('select', $event)" />
    </ul>
  </li>
</template>

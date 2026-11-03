<script setup lang="ts">
import { computed, defineAsyncComponent, type Component } from 'vue'
import { screenFor } from '../nav'
import MetaList from './MetaList.vue'

const props = defineProps<{ type: string }>()
const component = computed<Component>(() => {
  const custom = screenFor(props.type)?.list
  return custom ? defineAsyncComponent(custom) : MetaList
})
</script>

<template>
  <component :is="component" :key="type" :type="type" />
</template>

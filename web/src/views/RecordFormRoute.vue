<script setup lang="ts">
import { computed, defineAsyncComponent, type Component } from 'vue'
import { screenFor } from '../nav'
import MetaForm from './MetaForm.vue'

const props = defineProps<{ type: string; id?: string }>()
const component = computed<Component>(() => {
  const custom = screenFor(props.type)?.form
  return custom ? defineAsyncComponent(custom) : MetaForm
})
</script>

<template>
  <component :is="component" :key="type" :type="type" :id="id ?? null" />
</template>

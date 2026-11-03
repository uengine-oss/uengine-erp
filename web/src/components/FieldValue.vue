<script setup lang="ts">
import { computed } from 'vue'
import type { Field } from '../lib/types'
import { displayValue, isNumeric } from '../lib/fields'
import { refLabel } from '../lib/refs'

const props = defineProps<{ field: Field; value: unknown }>()
const isList = computed(() => (props.field.type === 'tags' || props.field.type === 'refs') && Array.isArray(props.value))
const items = computed(() => (props.value as unknown[]).map((v) => (props.field.ref ? refLabel(v) : props.field.options?.find((o) => o.value === v)?.label ?? String(v))))
const objectValue = computed(() => props.field.type === 'json' && props.value && typeof props.value === 'object')
</script>

<template>
  <template v-if="isList"><span v-for="t in items" :key="t" class="tag">{{ t }}</span></template>
  <pre v-else-if="objectValue" class="mono" style="margin: 0; white-space: pre-wrap">{{ JSON.stringify(value, null, 2) }}</pre>
  <span v-else :class="{ num: isNumeric(field) }">{{ displayValue(field, value) }}</span>
</template>

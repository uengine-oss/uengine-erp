<script setup lang="ts">
import { computed, ref } from 'vue'
import type { FieldOption } from '../lib/types'
import Icon from './Icon.vue'

const props = defineProps<{ modelValue: string[] | null | undefined; options?: FieldOption[]; disabled?: boolean; id?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()

const values = computed(() => props.modelValue ?? [])
const text = ref('')

function toggle(v: string) {
  emit('update:modelValue', values.value.includes(v) ? values.value.filter((x) => x !== v) : [...values.value, v])
}
function add() {
  const v = text.value.trim()
  if (v && !values.value.includes(v)) emit('update:modelValue', [...values.value, v])
  text.value = ''
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() }
  else if (e.key === 'Backspace' && !text.value && values.value.length) emit('update:modelValue', values.value.slice(0, -1))
}
</script>

<template>
  <div v-if="options?.length" :id="id" class="toggles" role="group">
    <button v-for="o in options" :key="o.value" type="button" class="toggle" :class="{ on: values.includes(o.value) }"
            :aria-pressed="values.includes(o.value)" :disabled="disabled" @click="toggle(o.value)">{{ o.label }}</button>
  </div>
  <div v-else class="chips">
    <span v-for="v in values" :key="v" class="tag">{{ v }}
      <button v-if="!disabled" type="button" tabindex="-1" aria-label="빼기" @click="toggle(v)"><Icon name="x" :size="10" /></button>
    </span>
    <input v-if="!disabled" :id="id" v-model="text" autocomplete="off" :placeholder="values.length ? '' : '입력 후 Enter'" @keydown="onKey" @blur="add" />
  </div>
</template>

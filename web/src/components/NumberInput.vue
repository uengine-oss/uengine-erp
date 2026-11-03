<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { fmtInteger, fmtMoney, fmtNumber } from '../lib/format'

const props = withDefaults(defineProps<{ modelValue: number | null | undefined; kind?: 'number' | 'money' | 'integer'; disabled?: boolean; id?: string; invalid?: boolean; placeholder?: string }>(), { kind: 'number' })
const emit = defineEmits<{ 'update:modelValue': [value: number | null] }>()

const focused = ref(false)
const text = ref('')

const formatted = computed(() => {
  if (props.modelValue === null || props.modelValue === undefined) return ''
  return props.kind === 'money' ? fmtMoney(props.modelValue) : props.kind === 'integer' ? fmtInteger(props.modelValue) : fmtNumber(props.modelValue)
})
const parse = (s: string): number | null => {
  const cleaned = s.replace(/,/g, '').trim()
  if (cleaned === '' || cleaned === '-') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

watch(() => props.modelValue, (v) => {
  // While typing, "1." and 1 are the same number: keep what the user sees unless the value truly moved.
  if (focused.value && parse(text.value) !== (v ?? null)) text.value = v === null || v === undefined ? '' : String(v)
})

function onFocus(e: FocusEvent) {
  focused.value = true
  text.value = props.modelValue === null || props.modelValue === undefined ? '' : String(props.modelValue)
  void Promise.resolve().then(() => (e.target as HTMLInputElement).select())
}
function onInput(e: Event) {
  text.value = (e.target as HTMLInputElement).value
  const n = parse(text.value)
  if (n !== (props.modelValue ?? null)) emit('update:modelValue', n)
}
</script>

<template>
  <input :id="id" class="input num" type="text" inputmode="decimal" autocomplete="off"
         :class="{ 'is-invalid': invalid }" :disabled="disabled" :placeholder="placeholder"
         :value="focused ? text : formatted" @focus="onFocus" @input="onInput" @blur="focused = false" />
</template>

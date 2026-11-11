<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Field } from '../lib/types'
import { isLongText } from '../lib/fields'
import { currency } from '../lib/format'
import NumberInput from './NumberInput.vue'
import RefSelect from './RefSelect.vue'
import RefsSelect from './RefsSelect.vue'
import TagsInput from './TagsInput.vue'
import DistributionInput from './DistributionInput.vue'

const props = defineProps<{ field: Field; modelValue: any; disabled?: boolean; id?: string; invalid?: boolean; compact?: boolean; ariaLabel?: string; context?: Record<string, any> | null }>()
const emit = defineEmits<{ 'update:modelValue': [value: any]; picked: [] }>()
const set = (v: unknown) => emit('update:modelValue', v)

// datetime-local works in the browser's zone; the record stores an absolute instant.
const localDateTime = computed(() => {
  if (!props.modelValue) return ''
  const d = new Date(props.modelValue)
  if (Number.isNaN(d.getTime())) return ''
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
})

const jsonText = ref('')
const jsonBad = ref(false)
watch(() => props.modelValue, (v) => {
  if (props.field.type !== 'json' || jsonBad.value) return
  jsonText.value = v === null || v === undefined ? '' : JSON.stringify(v, null, 2)
}, { immediate: true })
function onJson(e: Event) {
  jsonText.value = (e.target as HTMLTextAreaElement).value
  if (!jsonText.value.trim()) { jsonBad.value = false; set(null); return }
  try { set(JSON.parse(jsonText.value)); jsonBad.value = false } catch { jsonBad.value = true }
}
</script>

<template>
  <span v-if="field.type === 'money' && !compact" class="input-suffix">
    <NumberInput :id="id" :model-value="modelValue" kind="money" :disabled="disabled" :invalid="invalid" :aria-label="ariaLabel" @update:model-value="set" />
    <span>{{ currency() }}</span>
  </span>
  <NumberInput v-else-if="field.type === 'number' || field.type === 'money' || field.type === 'integer'" :id="id" :model-value="modelValue" :kind="field.type" :disabled="disabled" :invalid="invalid" :aria-label="ariaLabel" @update:model-value="set" />
  <label v-else-if="field.type === 'boolean'" class="check">
    <input :id="id" type="checkbox" :checked="!!modelValue" :disabled="disabled" :aria-label="ariaLabel" @change="set(($event.target as HTMLInputElement).checked)" />
    <span v-if="!compact">{{ modelValue ? '예' : '아니오' }}</span>
  </label>
  <input v-else-if="field.type === 'date'" :id="id" class="input" type="date" :class="{ 'is-invalid': invalid }" :disabled="disabled" :aria-label="ariaLabel"
         :value="modelValue ? String(modelValue).slice(0, 10) : ''" @input="set(($event.target as HTMLInputElement).value || null)" />
  <input v-else-if="field.type === 'datetime'" :id="id" class="input" type="datetime-local" :class="{ 'is-invalid': invalid }" :disabled="disabled"
         :value="localDateTime" @input="set(($event.target as HTMLInputElement).value ? new Date(($event.target as HTMLInputElement).value).toISOString() : null)" />
  <select v-else-if="field.type === 'enum'" :id="id" class="select" :class="{ 'is-invalid': invalid }" :disabled="disabled" :aria-label="ariaLabel"
          :value="modelValue ?? ''" @change="set(($event.target as HTMLSelectElement).value || null)">
    <option value="">{{ field.required ? '선택하세요' : '없음' }}</option>
    <option v-for="o in field.options ?? []" :key="o.value" :value="o.value">{{ o.label }}</option>
  </select>
  <RefSelect v-else-if="field.type === 'ref' && field.ref" :id="id" :model-value="modelValue" :ref-type="field.ref" :disabled="disabled" :invalid="invalid" :aria-label="ariaLabel"
             @update:model-value="set" @picked="$emit('picked')" />
  <RefsSelect v-else-if="(field.type === 'refs' || field.type === 'tags') && field.ref" :id="id" :model-value="modelValue" :ref-type="field.ref" :disabled="disabled" @update:model-value="set" />
  <TagsInput v-else-if="field.type === 'tags'" :id="id" :model-value="modelValue" :options="field.options" :disabled="disabled" @update:model-value="set" />
  <DistributionInput v-else-if="field.type === 'distribution'" :id="id" :model-value="modelValue" :disabled="disabled" :compact="compact" :aria-label="ariaLabel" :context="context" @update:model-value="set" />
  <div v-else-if="field.type === 'json'" class="stack" style="gap: 2px">
    <textarea :id="id" class="textarea mono" :rows="compact ? 1 : 4" :style="compact ? 'min-height: 28px' : undefined" spellcheck="false" :class="{ 'is-invalid': jsonBad || invalid }" :disabled="disabled" :value="jsonText" @input="onJson" />
    <span v-if="jsonBad" class="err-text small">JSON 형식이 맞지 않습니다. 고치기 전까지 저장되지 않습니다.</span>
  </div>
  <input v-else-if="field.type === 'password'" :id="id" class="input" type="password" autocomplete="new-password" :class="{ 'is-invalid': invalid }"
         :disabled="disabled" :value="modelValue ?? ''" @input="set(($event.target as HTMLInputElement).value || null)" />
  <textarea v-else-if="isLongText(field) && !compact" :id="id" class="textarea" rows="2" :class="{ 'is-invalid': invalid }" :disabled="disabled"
            :value="modelValue ?? ''" @input="set(($event.target as HTMLTextAreaElement).value)" />
  <input v-else :id="id" class="input" type="text" autocomplete="off" :class="{ 'is-invalid': invalid }" :disabled="disabled" :aria-label="ariaLabel"
         :value="modelValue ?? ''" @input="set(($event.target as HTMLInputElement).value)" />
</template>

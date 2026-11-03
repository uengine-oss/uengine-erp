<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ensureNames, refLabel } from '../lib/refs'
import Icon from './Icon.vue'
import RefSelect from './RefSelect.vue'

const props = defineProps<{ modelValue: string[] | null | undefined; refType: string; disabled?: boolean; id?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()

const ids = computed(() => props.modelValue ?? [])
const picker = ref<string | null>(null)

watch(ids, (v) => { void ensureNames(v) }, { immediate: true })
watch(picker, (v) => {
  if (!v) return
  if (!ids.value.includes(v)) emit('update:modelValue', [...ids.value, v])
  picker.value = null
})
function remove(id: string) {
  emit('update:modelValue', ids.value.filter((x) => x !== id))
}
</script>

<template>
  <div class="stack" style="gap: 3px">
    <div v-if="ids.length" class="row-wrap" style="gap: 3px">
      <span v-for="id in ids" :key="id" class="tag">{{ refLabel(id) }}
        <button v-if="!disabled" type="button" tabindex="-1" aria-label="빼기" @click="remove(id)"><Icon name="x" :size="10" /></button>
      </span>
    </div>
    <RefSelect v-if="!disabled" :id="id" v-model="picker" :ref-type="refType" :exclude="ids" placeholder="검색하여 추가" />
  </div>
</template>

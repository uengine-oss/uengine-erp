<script setup lang="ts">
import Icon from './Icon.vue'

defineProps<{ message: string }>()
defineEmits<{ retry: [] }>()
</script>

<template>
  <div v-if="message" class="banner banner-error banner-flush" role="alert" data-testid="load-error">
    <Icon name="alert" /><span class="grow">{{ message }}</span>
    <button type="button" class="btn btn-sm" data-testid="load-retry" @click="$emit('retry')">다시 시도</button>
  </div>
</template>

<script setup lang="ts">
defineProps<{ title: string; text?: string }>()
</script>

<template>
  <div class="empty" data-testid="empty-state">
    <div class="empty-title">{{ title }}</div>
    <div v-if="text" class="empty-text">{{ text }}</div>
    <slot />
  </div>
</template>

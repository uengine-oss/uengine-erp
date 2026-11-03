<script setup lang="ts">
import { toasts } from '../lib/ui'
</script>

<template>
  <div class="toasts" role="status" aria-live="polite">
    <div v-for="t in toasts" :key="t.id" class="toast" :class="{ 'toast-error': t.kind === 'error' }">{{ t.text }}</div>
  </div>
</template>

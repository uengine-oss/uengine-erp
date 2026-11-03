<script setup lang="ts">
defineProps<{ note?: string }>()
</script>

<template>
  <div class="split">
    <aside class="split-side">
      <div class="brand">
        <span class="brand-mark"><svg width="15" height="15" viewBox="0 0 32 32" aria-hidden="true"><path d="M7 5v14a9 9 0 0 0 18 0V5h-5v14a4 4 0 0 1-8 0V5z" fill="#fff" /></svg></span>
        uEngine ERP
      </div>
      <slot name="side" />
      <p v-if="note" class="side-note">{{ note }}</p>
    </aside>
    <main class="split-main"><div class="split-inner"><slot /></div></main>
  </div>
</template>

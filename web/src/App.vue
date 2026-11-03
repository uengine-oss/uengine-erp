<script setup lang="ts">
import { watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { session } from './lib/session'
import DialogHost from './components/DialogHost.vue'
import ToastHost from './components/ToastHost.vue'

const route = useRoute()
const router = useRouter()

// Expired sessions end here wherever the user was, without losing the way back.
watch(() => session.phase, (phase, previous) => {
  if (previous === 'ready' && phase === 'anon' && !route.meta.public) {
    void router.push({ name: 'login', query: { next: route.fullPath } })
  }
})
</script>

<template>
  <router-view />
  <DialogHost />
  <ToastHost />
</template>

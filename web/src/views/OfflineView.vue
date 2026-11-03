<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { boot } from '../lib/session'
import ConnectionProblem from '../components/ConnectionProblem.vue'
import SplitLayout from '../components/SplitLayout.vue'

const route = useRoute()
const router = useRouter()
const busy = ref(false)
let timer: ReturnType<typeof setInterval> | undefined

async function retry() {
  if (busy.value) return
  busy.value = true
  try {
    const phase = await boot()
    if (phase !== 'offline') await router.replace(String(route.query.next ?? '/'))
  } finally {
    busy.value = false
  }
}
// A resuming project comes back on its own, so keep checking while the screen is open.
onMounted(() => { timer = setInterval(retry, 15000) })
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <SplitLayout note="연결되면 자동으로 이전 화면으로 돌아갑니다.">
    <h1 class="split-title">연결할 수 없습니다</h1>
    <p class="split-lead">앱은 이 브라우저와 회사의 Supabase 프로젝트만으로 동작합니다. 지금은 프로젝트가 응답하지 않습니다.</p>
    <ConnectionProblem :busy="busy" @retry="retry" @change="router.push({ name: 'setup', query: { change: '1' } })" />
  </SplitLayout>
</template>

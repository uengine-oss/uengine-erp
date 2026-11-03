<script setup lang="ts">
// A demo company whose building stopped half way holds the event bus still. Only an admin can finish it.
import { onMounted, ref } from 'vue'
import { rpc } from '../lib/api'
import { isAdmin, session } from '../lib/session'
import type { BusTick } from '../lib/types'
import Icon from './Icon.vue'

const unfinished = ref(false)
onMounted(async () => {
  if (!session.status?.demo || !isAdmin()) return
  try { unfinished.value = !!(await rpc<BusTick>('erp_bus_tick')).paused } catch { /* the cron job will say nothing either */ }
})
</script>

<template>
  <div v-if="unfinished" class="banner banner-warn banner-flush no-print" role="alert" data-testid="demo-unfinished">
    <Icon name="alert" />
    <span class="grow">가상 회사를 만들다 멈췄습니다. 끝날 때까지 모듈 사이의 전달이 멈춰 있습니다.</span>
    <router-link class="btn btn-sm" :to="{ name: 'demo-build' }" data-testid="demo-resume">이어서 만들기</router-link>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { conn, dashboardUrl, net } from '../lib/conn'
import { refreshStatus } from '../lib/session'
import Icon from './Icon.vue'

const busy = ref(false)
async function retry() {
  busy.value = true
  await refreshStatus()
  busy.value = false
}
</script>

<template>
  <div v-if="!net.reachable" class="banner banner-error banner-flush no-print" role="alert" data-testid="net-banner">
    <Icon name="alert" />
    <span class="grow">프로젝트에 연결할 수 없습니다. 입력 중인 내용은 이 화면에 그대로 있습니다. 무료 플랜은 7일 동안 활동이 없으면 일시 중지되므로, 계속되면 대시보드에서 재개하세요.</span>
    <button type="button" class="btn btn-sm" :disabled="busy" @click="retry">다시 시도</button>
    <a class="btn btn-sm" :href="dashboardUrl(conn?.url)" target="_blank" rel="noopener noreferrer"><Icon name="external" :size="12" />대시보드</a>
  </div>
</template>

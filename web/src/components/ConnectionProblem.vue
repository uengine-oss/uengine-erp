<script setup lang="ts">
import { conn, dashboardUrl } from '../lib/conn'
import Icon from './Icon.vue'

defineProps<{ busy?: boolean }>()
defineEmits<{ retry: []; change: [] }>()
</script>

<template>
  <div class="stack" style="gap: 12px" data-testid="connection-problem">
    <div class="banner banner-warn"><Icon name="alert" /><span>프로젝트에 연결할 수 없습니다.</span></div>
    <p class="dim">가장 흔한 이유는 일시 중지입니다. 무료 플랜 프로젝트는 7일 동안 활동이 없으면 일시 중지되며, 데이터는 그대로 남아 있습니다.</p>
    <ol class="note-list">
      <li>Supabase 대시보드에서 프로젝트를 열고 <b>Restore project</b> 를 누릅니다.</li>
      <li>재개에는 몇 분 걸립니다. 끝나면 아래 다시 시도를 누르세요.</li>
      <li>일시 중지가 아니라면 인터넷 연결과 Project URL 을 확인하세요.</li>
    </ol>
    <div class="row">
      <button type="button" class="btn btn-primary" :disabled="busy" data-testid="retry" @click="$emit('retry')">{{ busy ? '확인 중…' : '다시 시도' }}</button>
      <a class="btn" :href="dashboardUrl(conn?.url)" target="_blank" rel="noopener noreferrer"><Icon name="external" :size="13" />대시보드 열기</a>
      <button type="button" class="btn btn-ghost" @click="$emit('change')">접속 정보 변경</button>
    </div>
  </div>
</template>

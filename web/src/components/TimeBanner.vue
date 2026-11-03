<script setup lang="ts">
import { computed } from 'vue'
import { exitTimeView, timeView, writeBlock } from '../lib/mode'
import { openRollback } from '../lib/rollback'
import { isAdmin } from '../lib/session'
import Icon from './Icon.vue'

// A version problem blocks writes on its own, and a rollback is a write.
const canRollback = computed(() => isAdmin() && writeBlock.value === 'time')

async function rollbackHere() {
  const done = await openRollback('time', { at: timeView.at }, '이 시점으로 되돌리기', `${timeView.date} 이후에 일어난 일을 회사 전체에서 되돌립니다.`)
  if (done) exitTimeView()
}
</script>

<template>
  <div v-if="timeView.at" class="banner banner-time banner-flush no-print" data-testid="company-time-banner">
    <Icon name="history" />
    <span class="grow">{{ timeView.date }} 시점을 보고 있습니다. 읽기 전용입니다.</span>
    <button v-if="canRollback" type="button" class="btn btn-sm btn-danger" data-testid="rollback-time-here" @click="rollbackHere">이 시점으로 되돌리기</button>
    <button type="button" class="btn btn-sm" data-testid="company-time-exit" @click="exitTimeView">현재로 돌아가기</button>
  </div>
</template>

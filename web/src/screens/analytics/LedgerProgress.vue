<script setup lang="ts">
import { computed } from 'vue'
import { ensureLedger, ledger } from '../../lib/analytics'
import Icon from '../../components/Icon.vue'

const percent = computed(() => (ledger.total ? Math.round((ledger.done / ledger.total) * 100) : 0))
</script>

<template>
  <div v-if="ledger.phase === 'loading'" class="progress" data-testid="ledger-progress">
    <div class="row small dim" style="justify-content: space-between">
      <span>원장을 읽는 중입니다. 화면은 그대로 쓸 수 있습니다.</span>
      <span class="nowrap" data-testid="ledger-progress-count">{{ ledger.total ? `${ledger.done} / ${ledger.total}` : '준비 중' }}</span>
    </div>
    <div class="meter" role="progressbar" :aria-valuenow="percent" aria-valuemin="0" aria-valuemax="100"><i :style="{ width: `${percent}%` }"></i></div>
  </div>
  <div v-else-if="ledger.phase === 'error'" class="banner banner-error" role="alert" data-testid="ledger-error">
    <Icon name="alert" /><span class="grow">{{ ledger.error }}</span>
    <button type="button" class="btn btn-sm" data-testid="ledger-retry" @click="ensureLedger(true)">다시 시도</button>
  </div>
</template>

<style scoped>
.progress { display: flex; flex-direction: column; gap: 4px; max-width: 520px; }
</style>

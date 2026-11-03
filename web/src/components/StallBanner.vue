<script setup lang="ts">
import { computed } from 'vue'
import { moduleLabel, stalls } from '../lib/bus'
import { isAdmin } from '../lib/session'
import Icon from './Icon.vue'

const first = computed(() => stalls.value[0])
const more = computed(() => new Set(stalls.value.map((s) => s.module)).size - 1)
</script>

<template>
  <div v-if="isAdmin() && first" class="banner banner-error banner-flush no-print" role="alert" data-testid="stall-banner">
    <Icon name="alert" />
    <span class="grow">{{ moduleLabel(first.module) }} 모듈이 이벤트 #{{ first.last_error_seq }} 에서 멈췄습니다.<template v-if="more > 0"> 다른 모듈 {{ more }}개도 멈춰 있습니다.</template> 다른 모듈과 사용자의 작업은 영향받지 않습니다.</span>
    <router-link class="btn btn-sm" to="/settings/bus" data-testid="stall-open">원인 보기</router-link>
  </div>
</template>

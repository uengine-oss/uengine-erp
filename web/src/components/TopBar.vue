<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { session, signOut } from '../lib/session'
import { live } from '../lib/realtime'
import Icon from './Icon.vue'

const router = useRouter()
const roleNames = computed(() => {
  const opts = session.catalog.find((c) => c.type === 'member')?.fields.find((f) => f.name === 'roles')?.options ?? []
  return (session.me?.roles ?? []).map((r) => opts.find((o) => o.value === r)?.label ?? r).join(', ')
})
const liveText = computed(() => ({ live: '실시간', connecting: '연결 중', down: '실시간 꺼짐', off: '실시간 꺼짐' })[live.status])
const liveTitle = computed(() => (live.status === 'down'
  ? '실시간 연결이 끊겼습니다. 앱은 그대로 쓸 수 있고, 화면은 다시 열 때 갱신됩니다.'
  : '다른 사람의 변경이 화면에 바로 반영됩니다.'))

async function logout() {
  await signOut()
  await router.push({ name: 'login' })
}
</script>

<template>
  <header class="top">
    <strong class="ellipsis" data-testid="company-name">{{ session.company?.state?.name ?? session.status?.company_name }}</strong>
    <span class="top-right">
      <span class="live" :class="`live-${live.status}`" :title="liveTitle" data-testid="live"><i></i>{{ liveText }}</span>
      <span class="top-sep"></span>
      <span class="top-user" data-testid="user"><span>{{ session.me?.name }}</span><span class="muted small">{{ roleNames }}</span></span>
      <button type="button" class="btn btn-ghost btn-sm" data-testid="logout" @click="logout"><Icon name="logout" :size="13" />로그아웃</button>
    </span>
  </header>
</template>

<style scoped>
.top { display: flex; align-items: center; gap: 12px; height: 44px; flex: none; padding: 0 12px 0 16px; background: var(--surface); border-bottom: 1px solid var(--line); }
.top strong { font-size: 13.5px; font-weight: 650; }
.top-right { display: flex; align-items: center; gap: 10px; margin-left: auto; flex: none; }
.top-sep { width: 1px; height: 18px; background: var(--line); }
.top-user { display: inline-flex; align-items: baseline; gap: 6px; font-weight: 550; }
.live { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-3); cursor: default; }
.live i { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-300); }
.live-live { color: var(--green-fg); }
.live-live i { background: #1f9d63; }
.live-connecting i { background: #c9981f; }
</style>

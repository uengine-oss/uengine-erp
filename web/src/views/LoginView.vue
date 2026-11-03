<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { conn, projectRef } from '../lib/conn'
import { boot, session, signIn } from '../lib/session'
import type { ApiError } from '../lib/api'
import ConnectionProblem from '../components/ConnectionProblem.vue'
import Icon from '../components/Icon.vue'
import SplitLayout from '../components/SplitLayout.vue'

const route = useRoute()
const router = useRouter()
const email = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')
const offline = ref(false)

const projectLabel = computed(() => projectRef(conn.value?.url) ?? conn.value?.url ?? '')

const nextPath = () => String(route.query.next ?? '/')

async function checkState() {
  if (!conn.value) return router.replace({ name: 'setup' })
  busy.value = true
  const phase = await boot()
  busy.value = false
  offline.value = phase === 'offline'
  if (phase === 'ready') return router.replace(nextPath())
  if (phase === 'not-installed' || phase === 'not-initialized' || phase === 'bad-key') return router.replace({ name: 'setup' })
  if (session.message) error.value = session.message
}
onMounted(checkState)

async function submit() {
  error.value = ''
  busy.value = true
  try {
    await signIn(email.value, password.value)
    const phase = await boot()
    if (phase === 'ready') await router.replace(nextPath())
    else { offline.value = phase === 'offline'; error.value = session.message || '로그인하지 못했습니다.' }
  } catch (e) {
    const err = e as ApiError
    if (err.network) offline.value = true
    else error.value = err.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <SplitLayout note="계정은 회사 관리자가 만듭니다. 비밀번호와 데이터는 이 회사의 Supabase 프로젝트로만 전달됩니다.">
    <template #side>
      <div style="margin-top: 32px">
        <div class="small" style="color: var(--ink-400); margin-bottom: 4px">프로젝트</div>
        <div style="color: #fff; font-size: 16px; font-weight: 600" data-testid="login-project">{{ projectLabel }}</div>
      </div>
    </template>
    <template v-if="offline">
      <h1 class="split-title">연결할 수 없습니다</h1>
      <p class="split-lead">앱은 이 브라우저와 회사의 Supabase 프로젝트만으로 동작합니다.</p>
      <ConnectionProblem :busy="busy" @retry="checkState" @change="router.push({ name: 'setup', query: { change: '1' } })" />
    </template>
    <template v-else>
      <h1 class="split-title">로그인</h1>
      <p class="split-lead">관리자에게 받은 이메일과 비밀번호를 넣으세요.</p>
      <form class="form-stack" style="max-width: 340px" @submit.prevent="submit">
        <div class="field-stack">
          <label for="login-email">이메일</label>
          <input id="login-email" v-model="email" class="input input-lg" type="email" autocomplete="username" required autofocus />
        </div>
        <div class="field-stack">
          <label for="login-password">비밀번호</label>
          <input id="login-password" v-model="password" class="input input-lg" type="password" autocomplete="current-password" required />
        </div>
        <div v-if="error" class="banner banner-error" role="alert" data-testid="login-error"><Icon name="alert" /><span>{{ error }}</span></div>
        <button type="submit" class="btn btn-primary btn-lg" :disabled="busy" data-testid="login-submit">{{ busy ? '확인 중…' : '로그인' }}</button>
        <router-link class="small" :to="{ name: 'setup', query: { change: '1' } }" data-testid="change-connection">접속 정보 변경</router-link>
      </form>
    </template>
  </SplitLayout>
</template>

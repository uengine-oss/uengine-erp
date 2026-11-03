<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { classifyKey, conn, normalizeUrl, SECRET_KEY_MESSAGE, setConn } from '../lib/conn'
import { session } from '../lib/session'
import Icon from '../components/Icon.vue'
import SplitLayout from '../components/SplitLayout.vue'

const route = useRoute()
const router = useRouter()

const rawUrl = String(route.query.u ?? '')
const rawKey = String(route.query.k ?? '')
const check = normalizeUrl(rawUrl)
const kind = classifyKey(rawKey)

const problem = computed(() => {
  if (kind === 'secret') return SECRET_KEY_MESSAGE
  if (!check.ok || kind === 'invalid') return '초대 링크가 올바르지 않습니다. 링크를 보낸 동료에게 다시 요청하세요.'
  return ''
})
const host = computed(() => (check.ok ? new URL(check.url).host : ''))
const replacing = computed(() => !!conn.value && check.ok && conn.value.url !== check.url)
const accepted = ref(false)

// A refused key must not linger in the address bar or the browser history.
onMounted(() => {
  if (kind === 'secret') void router.replace({ name: 'connect', query: { refused: '1' } })
})

function accept() {
  if (!check.ok || problem.value) return
  setConn({ url: check.url, key: rawKey.trim() })
  session.phase = 'idle'
  accepted.value = true
  void router.replace({ name: 'login' })
}
</script>

<template>
  <SplitLayout note="접속 정보는 이 브라우저에만 저장됩니다. 초대 링크는 주소의 # 뒤에 있어 서버로 전달되지 않습니다.">
    <h1 class="split-title">회사 접속</h1>
    <template v-if="problem || route.query.refused">
      <div class="banner banner-error" role="alert" data-testid="connect-error"><Icon name="alert" /><span>{{ route.query.refused ? SECRET_KEY_MESSAGE : problem }}</span></div>
      <p style="margin-top: 14px"><router-link :to="{ name: 'setup', query: { change: '1' } }">접속 정보 직접 입력</router-link></p>
    </template>
    <template v-else>
      <p class="split-lead">동료가 보낸 초대 링크입니다. 아래 주소가 회사에서 쓰는 프로젝트가 맞을 때만 접속하세요. 다음 화면에서 이 프로젝트에 비밀번호를 보내게 됩니다.</p>
      <dl class="kv" style="margin: 0 0 16px">
        <dt>프로젝트 주소</dt><dd><code data-testid="connect-host">{{ host }}</code></dd>
      </dl>
      <div v-if="replacing" class="banner banner-warn" style="margin-bottom: 14px"><Icon name="alert" /><span>지금 연결된 다른 프로젝트({{ conn?.url }})의 로그인이 해제됩니다.</span></div>
      <div class="row">
        <button type="button" class="btn btn-primary btn-lg" data-testid="connect-accept" @click="accept">이 회사로 접속</button>
        <router-link class="btn btn-lg btn-ghost" :to="{ name: 'setup', query: { change: '1' } }">접속 정보 직접 입력</router-link>
      </div>
    </template>
  </SplitLayout>
</template>

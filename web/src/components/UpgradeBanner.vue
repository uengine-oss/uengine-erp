<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { conn, sqlEditorUrl } from '../lib/conn'
import { APP_BUILD, APP_VERSION, installParts, type InstallPart } from '../lib/install'
import { appOutdated, dbOutdated as needed } from '../lib/mode'
import { isAdmin, refreshStatus, session } from '../lib/session'
import { copyText, toast } from '../lib/ui'
import Icon from './Icon.vue'

const checking = ref(false)

// The upgrade is the same install SQL in the same parts (the cloud SQL Editor refuses it whole), run again from part 1.
// Loaded ahead of the click: browsers can refuse the clipboard if a click waits on a download first.
const parts = ref<InstallPart[]>([])
watch(needed, async (v) => { if (v && !parts.value.length) parts.value = await installParts() }, { immediate: true })
const done = computed(() => {
  const i = session.status?.install
  return i && i.version === APP_BUILD && i.total === parts.value.length ? i.done : []
})

const reload = () => window.location.reload()

async function copyPart(p: InstallPart) {
  const ok = await copyText(p.sql)
  toast(ok ? `${p.n}/${p.total} ${p.label} 부분을 복사했습니다. SQL Editor 에 붙여 넣고 실행하세요.` : '복사하지 못했습니다.', ok ? 'ok' : 'error')
}
async function recheck() {
  checking.value = true
  await refreshStatus()
  checking.value = false
  if (needed.value) toast(done.value.length ? `${done.value.length}/${parts.value.length} 실행됨. 나머지를 차례로 실행한 뒤 다시 확인하세요.` : '아직 이전 버전입니다. SQL 을 실행한 뒤 다시 확인하세요.', 'error')
  else toast('업그레이드를 확인했습니다.')
}
</script>

<template>
  <div v-if="appOutdated" class="banner banner-error banner-flush no-print" role="alert" data-testid="app-outdated-banner">
    <Icon name="alert" />
    <span class="grow">앱이 이 데이터베이스보다 오래되었습니다(앱 v{{ APP_VERSION }}, 최소 v{{ session.status?.min_app_version }}). 새로 고칠 때까지 저장할 수 없습니다.</span>
    <button type="button" class="btn btn-sm" data-testid="app-reload" @click="reload"><Icon name="refresh" :size="12" />새로 고침</button>
  </div>
  <div v-else-if="needed" class="banner banner-warn banner-flush no-print" data-testid="upgrade-banner">
    <Icon name="alert" />
    <span class="grow">
      데이터베이스가 이전 버전입니다(v{{ session.status?.version }} → 앱 v{{ APP_VERSION }}). 업그레이드할 때까지 저장할 수 없습니다.
      <template v-if="isAdmin()">설치 SQL 을 1번부터 차례로 다시 실행하면 업그레이드되며 데이터는 그대로 보존됩니다.</template>
      <template v-else>관리자에게 업그레이드를 요청하세요.</template>
    </span>
    <template v-if="isAdmin()">
      <span class="upgrade-parts">
        <button
          v-for="p in parts" :key="p.n" type="button" class="btn btn-sm" :title="`${p.n}. ${p.label} (${Math.ceil(p.bytes / 1024)} KB)`"
          :data-testid="`upgrade-part-${p.n}`" :data-done="done.includes(p.n) ? 'true' : 'false'" @click="copyPart(p)"
        ><Icon :name="done.includes(p.n) ? 'check' : 'copy'" :size="12" />{{ p.n }}</button>
      </span>
      <a class="btn btn-sm" :href="sqlEditorUrl(conn?.url)" target="_blank" rel="noopener noreferrer"><Icon name="external" :size="12" />SQL Editor</a>
      <button type="button" class="btn btn-sm" :disabled="checking" @click="recheck">다시 확인</button>
    </template>
  </div>
</template>

<style scoped>
.upgrade-parts { display: inline-flex; gap: 4px; flex-wrap: wrap; }
</style>

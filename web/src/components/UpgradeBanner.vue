<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { conn, sqlEditorUrl } from '../lib/conn'
import { compareVersions } from '../lib/format'
import { APP_VERSION, installSql } from '../lib/install'
import { isAdmin, refreshStatus, session } from '../lib/session'
import { copyText, toast } from '../lib/ui'
import Icon from './Icon.vue'

const needed = computed(() => session.status?.version != null && compareVersions(session.status.version, APP_VERSION) < 0)
const checking = ref(false)

// Loaded ahead of the click: browsers can refuse the clipboard if a click waits on a download first.
const sql = ref('')
watch(needed, async (v) => { if (v && !sql.value) sql.value = await installSql() }, { immediate: true })

async function copySql() {
  const ok = await copyText(sql.value || await installSql())
  toast(ok ? '업그레이드 SQL 을 복사했습니다. SQL Editor 에 붙여 넣고 실행하세요.' : '복사하지 못했습니다.', ok ? 'ok' : 'error')
}
async function recheck() {
  checking.value = true
  await refreshStatus()
  checking.value = false
  if (needed.value) toast('아직 이전 버전입니다. SQL 을 실행한 뒤 다시 확인하세요.', 'error')
  else toast('업그레이드를 확인했습니다.')
}
</script>

<template>
  <div v-if="needed" class="banner banner-warn banner-flush no-print" data-testid="upgrade-banner">
    <Icon name="alert" />
    <span class="grow">
      데이터베이스가 이전 버전입니다(v{{ session.status?.version }} → 앱 v{{ APP_VERSION }}).
      <template v-if="isAdmin()">같은 설치 SQL 을 다시 실행하면 업그레이드되며 데이터는 그대로 보존됩니다.</template>
      <template v-else>관리자에게 업그레이드를 요청하세요.</template>
    </span>
    <template v-if="isAdmin()">
      <button type="button" class="btn btn-sm" @click="copySql"><Icon name="copy" :size="12" />SQL 복사</button>
      <a class="btn btn-sm" :href="sqlEditorUrl(conn?.url)" target="_blank" rel="noopener noreferrer"><Icon name="external" :size="12" />SQL Editor</a>
      <button type="button" class="btn btn-sm" :disabled="checking" @click="recheck">다시 확인</button>
    </template>
  </div>
</template>

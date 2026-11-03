<script setup lang="ts">
// How printed documents look. The address and name come from the company; the logo lives on the record as an image of its
// own, because the app's security policy loads nothing from other sites.
import { computed, ref } from 'vue'
import { messageOf } from '../../lib/api'
import { sendCommand } from '../../lib/commands'
import { writeBlock } from '../../lib/mode'
import { isAdmin, loadCompany, session } from '../../lib/session'
import { COMPANY_ID } from '../../lib/types'
import { toast } from '../../lib/ui'
import Icon from '../../components/Icon.vue'

const MAX = 64 * 1024
const error = ref('')
const company = computed(() => session.company?.state ?? {})
const logo = computed(() => String(company.value.logo_url ?? ''))
const inlineLogo = computed(() => (logo.value.startsWith('data:image/') ? logo.value : ''))
const outside = computed(() => !!logo.value && !inlineLogo.value)
const canEdit = computed(() => isAdmin() && !writeBlock.value)

async function saveLogo(value: string | null) {
  error.value = ''
  try {
    await sendCommand({ type: 'company', id: COMPANY_ID, command: 'update', payload: { logo_url: value } })
    await loadCompany()
    toast('저장했습니다.')
  } catch (e) {
    error.value = messageOf(e)
  }
}
function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  if (!file.type.startsWith('image/')) { error.value = '그림 파일을 고르세요.'; return }
  if (file.size > MAX) { error.value = '로고는 64KB 까지입니다. 줄여서 다시 올리세요.'; return }
  const reader = new FileReader()
  reader.onload = () => { void saveLogo(String(reader.result)) }
  reader.readAsDataURL(file)
}
</script>

<template>
  <div class="page" data-testid="documents">
    <div class="page-head"><h1>문서 양식</h1></div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert" data-testid="documents-error"><Icon name="alert" /><span>{{ error }}</span></div>
    <div class="page-body report-pad">
      <div class="settings-col">
        <section class="section">
          <h2 class="section-title">로고</h2>
          <div class="sample" data-testid="documents-sample">
            <img v-if="inlineLogo" :src="inlineLogo" alt="회사 로고" class="sample-logo" data-testid="documents-logo" />
            <div><strong>{{ company.name }}</strong><div class="small dim">{{ company.address }}<template v-if="company.phone"> · {{ company.phone }}</template></div></div>
          </div>
          <p v-if="outside" class="err-text small" data-testid="documents-outside">지금 로고는 외부 주소입니다. 이 앱은 다른 사이트의 그림을 불러오지 않으니 파일로 올려 주세요.</p>
          <div v-if="canEdit" class="row-wrap" style="margin-top: 8px">
            <input class="input" style="width: 280px" type="file" accept="image/png,image/jpeg,image/svg+xml" aria-label="로고 파일" data-testid="documents-file" @change="onFile" />
            <button v-if="logo" type="button" class="btn" data-testid="documents-clear" @click="saveLogo(null)">로고 지우기</button>
          </div>
          <p class="hint" style="margin-top: 6px">견적서·발주서·납품서·청구서의 머리에 들어갑니다. 회사명과 주소는 <router-link to="/settings/company">회사 정보</router-link>에서 고칩니다.</p>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-col { max-width: 760px; }
.sample { display: flex; align-items: center; gap: 12px; padding: 10px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
.sample-logo { max-height: 48px; max-width: 160px; }
</style>

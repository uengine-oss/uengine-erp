<script setup lang="ts">
// One model: its state from the database first, then its panel. Locked models stop here with what would open them.
import { computed, onMounted, ref, watch } from 'vue'
import { ensureLedger, fetchModels, ledger, type ModelRow } from '../../lib/analytics'
import { messageOf } from '../../lib/api'
import { timeView } from '../../lib/mode'
import { onLedgerEvent } from '../../lib/realtime'
import { isAdmin } from '../../lib/session'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'
import ForecastPanel from './ForecastPanel.vue'
import WhatIfPanel from './WhatIfPanel.vue'
import { STATE_COLOR, STATE_LABEL } from './fmt'

const props = defineProps<{ id: string }>()

const model = ref<ModelRow | null>(null)
const loaded = ref(false)
const error = ref('')
let seq = 0

async function load() {
  const my = ++seq
  error.value = ''
  try {
    const rows = await fetchModels()
    if (my !== seq) return
    model.value = rows.find((m) => m.id === props.id) ?? null
  } catch (e) {
    if (my === seq) { model.value = null; error.value = messageOf(e) }
  } finally {
    if (my === seq) loaded.value = true
  }
}
onMounted(load)
// Another model's panel must not stay up under this model's address while its state is on its way.
watch(() => props.id, () => { model.value = null; loaded.value = false; void load() })
watch(() => timeView.at, load)
watch(() => model.value?.label, (t) => { if (t) document.title = `${t} · uEngine ERP` }, { immediate: true })

const isWhatIf = computed(() => model.value?.kind === 'whatif')
const isOpen = computed(() => !!model.value && model.value.state !== 'locked')

// Numbers stay right about the moment they were read. Whoever wants the newer moment asks for it.
onLedgerEvent(() => { if (ledger.phase === 'ready') ledger.stale = true })
</script>

<template>
  <div class="page" data-testid="model-page" :data-model="id">
    <div class="page-head">
      <div class="crumbs">
        <router-link to="/analytics/models">예측·what-if</router-link><Icon class="muted" name="chevron-right" :size="12" />
        <h1 data-testid="model-title">{{ model?.label ?? '모델' }}</h1>
        <span v-if="model" class="pill" :class="`pill-${STATE_COLOR[model.state]}`" data-testid="model-page-state">{{ STATE_LABEL[model.state] }}</span>
      </div>
      <div class="grow"></div>
      <button v-if="isOpen" type="button" class="btn" :disabled="ledger.phase === 'loading'" data-testid="ledger-reload" @click="ensureLedger(true)"><Icon name="refresh" :size="13" />원장 다시 읽기</button>
    </div>
    <div v-if="isWhatIf" class="banner banner-info banner-flush" data-testid="whatif-note">
      <Icon name="shield" /><span class="grow">이 계산은 원장을 바꾸지 않습니다. 이 브라우저 안에서 시험만 해 보고, 저장되는 것은 없습니다.</span>
    </div>
    <div v-if="timeView.at && isOpen" class="banner banner-time banner-flush" data-testid="model-asof"><Icon name="history" /><span class="grow">{{ timeView.date }} 까지의 기록으로, 그날 기준으로 계산합니다.</span></div>
    <div v-if="ledger.stale && isOpen" class="banner banner-flush" data-testid="ledger-stale"><Icon name="info" /><span class="grow">읽은 뒤에 원장이 바뀌었습니다. 아래 숫자는 읽은 때 기준입니다.</span><button type="button" class="btn btn-sm" @click="ensureLedger(true)">다시 읽기</button></div>
    <div v-if="model?.stale_modules?.length && isOpen" class="banner banner-flush" data-testid="model-stale-modules"><Icon name="info" /><span class="grow">{{ model.evidence.message }}</span></div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert" data-testid="model-load-error"><Icon name="alert" /><span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" @click="load">다시 시도</button></div>

    <div class="page-body page-pad">
      <EmptyState v-if="loaded && !model && !error" title="없는 모델입니다"><router-link class="btn" to="/analytics/models">목록으로</router-link></EmptyState>
      <section v-else-if="model?.state === 'locked'" class="locked" data-testid="model-locked">
        <h2><Icon name="lock" :size="14" /> 잠겨 있습니다</h2>
        <p data-testid="model-locked-message">{{ model.evidence.message }}</p>
        <router-link v-if="isAdmin() && !model.forbidden" class="btn btn-primary" to="/settings/modules">모듈 화면으로</router-link>
        <p v-else-if="!model.forbidden" class="small muted">모듈은 관리자가 켭니다. 관리자에게 요청하세요.</p>
      </section>
      <template v-else-if="model">
        <WhatIfPanel v-if="isWhatIf" :key="model.id" :id="model.id" />
        <ForecastPanel v-else :key="model.id" :id="model.id" />
      </template>
    </div>
  </div>
</template>

<style scoped>
.crumbs { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.locked { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 14px 16px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); max-width: 560px; }
.locked h2 { display: inline-flex; align-items: center; gap: 6px; }
</style>

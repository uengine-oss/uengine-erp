<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { bus, isStalled, loadModels, refreshBus } from '../lib/bus'
import { sendCommand } from '../lib/commands'
import { messageOf } from '../lib/api'
import { eventLabel } from '../lib/eventText'
import { fmtDay, josa } from '../lib/format'
import { writeBlock, writeBlockMessage } from '../lib/mode'
import { isAdmin, loadCatalog } from '../lib/session'
import type { BusSubscription, Field, ModelInfo, ModuleDoc, State } from '../lib/types'
import { ask, toast } from '../lib/ui'
import EmptyState from '../components/EmptyState.vue'
import Icon from '../components/Icon.vue'

const admin = computed(() => isAdmin())
const models = ref<ModelInfo[]>([])
const busyId = ref('')
let modelsRead: Promise<void> = Promise.resolve()
async function load() {
  modelsRead = loadModels().then((list) => { models.value = list })
  await refreshBus()
  await modelsRead
}
onMounted(() => { if (admin.value) void load() })
watch(admin, (v) => { if (v) void load() })

const enabledIds = computed(() => new Set(bus.modules.filter((m) => m.enabled).map((m) => m.id)))
const missingRequired = (m: ModuleDoc) => (m.requires ?? []).filter((id) => !enabledIds.value.has(id)).map((id) => bus.modules.find((x) => x.id === id)?.label ?? id)
const subsOf = (m: ModuleDoc): BusSubscription[] => bus.subs.filter((s) => s.module === m.id)
const stallsOf = (m: ModuleDoc): BusSubscription[] => subsOf(m).filter(isStalled)

/** Models this module opens given what is already on. One that also needs a module still off stays out of it. */
function modelsFor(m: ModuleDoc): ModelInfo[] {
  return models.value.filter((x) => x.modules.includes(m.id) && x.modules.every((id) => id === m.id || enabledIds.value.has(id)))
}
function unlockText(m: ModuleDoc): string {
  const labels = modelsFor(m).map((x) => x.label)
  if (!labels.length) return ''
  if (m.enabled) return `이 모듈로 쓰는 예측·what-if: ${labels.join(', ')}`
  const last = labels[labels.length - 1]
  return `${[...labels.slice(0, -1), josa(last, '이', '가')].join(', ')} 열립니다`
}

function subsText(m: ModuleDoc): string {
  const subs = subsOf(m)
  if (!subs.length) return '없음'
  if (!m.enabled) return `${subs.length}개 · 꺼짐`
  const stuck = stallsOf(m).length
  if (stuck) return `${subs.length}개 중 ${stuck}개 멈춤`
  return subs.some((s) => s.pending) ? `${subs.length}개 · 처리 대기` : `${subs.length}개 · 정상`
}

const labelOf = (id: string) => bus.modules.find((x) => x.id === id)?.label ?? id
const needsText = (m: ModuleDoc) => (m.requires ?? []).map(labelOf).join(', ')

/** A date left empty means "do not reach back": sending it would read as a request to replay everything. */
function filledOptions(values: State): State {
  const out: State = {}
  for (const [k, v] of Object.entries(values)) if (v !== null && v !== undefined && v !== '') out[k] = v
  return out
}

const RESUME_FIELD: Field = {
  name: 'resume', label: '꺼져 있던 동안의 이벤트', type: 'enum', required: true, default: 'process',
  options: [{ value: 'process', label: '밀린 이벤트 처리' }, { value: 'skip', label: '건너뛰기' }],
  help: '건너뛰면 이 모듈은 꺼져 있던 동안의 일을 받지 않습니다. 원장에는 그대로 남습니다.',
}

async function enable(m: ModuleDoc) {
  // The dialog says what this opens, and it does not change once open, so a quick click waits for the list.
  busyId.value = m.id
  await modelsRead.catch(() => {})
  busyId.value = ''
  const again = !!m.enabled_at
  const fields = again ? [RESUME_FIELD] : (m.options ?? [])
  const lines = [unlockText(m), m.not_rebuilt].filter(Boolean).map((t) => String(t).replace(/\.$/, ''))
  const message = lines.length ? `${lines.join('. ')}.` : '메뉴에 이 모듈의 화면이 나타나고, 지금부터의 이벤트를 받습니다.'
  let values: State = {}
  let error = ''
  for (;;) {
    const answer = await ask({ title: `${m.label} 모듈 켜기`, message, error, fields, values, confirmLabel: '켜기', wide: fields.length > 1 })
    if (!answer) return
    values = answer.values
    busyId.value = m.id
    try {
      const payload: State = again
        // Turning on again keeps the choices made the first time.
        ? { id: m.id, options: m.options_set ?? {}, resume: values.resume === 'skip' ? 'skip' : 'process' }
        : { id: m.id, options: filledOptions(values) }
      await sendCommand({ type: 'module', command: 'enable', payload })
      await afterChange()
      toast(`${m.label} 모듈을 켰습니다.`)
      return
    } catch (e) {
      error = messageOf(e)
    } finally {
      busyId.value = ''
    }
  }
}

async function disable(m: ModuleDoc) {
  const answer = await ask({
    title: `${m.label} 모듈 끄기`,
    message: '메뉴와 명령이 막히고 구독이 멈춥니다. 데이터와 이력은 그대로 남고, 다시 켤 때 밀린 이벤트를 처리할지 고를 수 있습니다.',
    danger: true,
    reason: true,
    confirmLabel: '끄기',
  })
  if (!answer) return
  busyId.value = m.id
  try {
    await sendCommand({ type: 'module', command: 'disable', payload: { id: m.id }, reason: answer.reason || null })
    await afterChange()
    toast(`${m.label} 모듈을 껐습니다.`)
  } catch (e) {
    toast(messageOf(e), 'error')
  } finally {
    busyId.value = ''
  }
}

/** The catalog decides the menu, so it is read again before anyone looks up from this screen. */
async function afterChange() {
  await Promise.all([loadCatalog(), refreshBus()])
}
</script>

<template>
  <div class="page" data-testid="modules">
    <div class="page-head">
      <h1>모듈<span v-if="bus.modules.length" class="page-count">{{ enabledIds.size }}개 켜짐 / {{ bus.modules.length }}개</span></h1>
      <span class="muted small head-note">회사가 필요할 때 하나씩 켭니다. 꺼도 데이터와 이력은 남습니다.</span>
    </div>

    <div v-if="!admin" class="page-body">
      <EmptyState title="관리자만 볼 수 있습니다" text="모듈을 켜고 끄는 일은 관리자가 합니다. 필요한 모듈이 있으면 관리자에게 요청하세요." />
    </div>
    <template v-else>
      <div v-if="bus.error" class="banner banner-error banner-flush" role="alert" data-testid="modules-error">
        <Icon name="alert" /><span class="grow">{{ bus.error }}</span>
        <button type="button" class="btn btn-sm" data-testid="modules-retry" @click="load">다시 시도</button>
      </div>
      <div class="page-body page-pad">
        <div v-if="bus.modules.length" class="cards">
          <article v-for="m in bus.modules" :key="m.id" class="card" :class="{ off: !m.enabled, stuck: stallsOf(m).length }" data-testid="module-card" :data-id="m.id">
            <header class="card-head">
              <h2 class="ellipsis">{{ m.label }}</h2>
              <span class="pill" :class="m.enabled ? 'pill-green' : 'pill-gray'" data-testid="module-state">{{ m.enabled ? '켜짐' : '꺼짐' }}</span>
            </header>
            <p v-if="m.description" class="dim card-text">{{ m.description }}</p>
            <dl class="kv small card-facts">
              <template v-if="m.enabled_at"><dt>{{ m.enabled ? '켠 날짜' : '처음 켠 날짜' }}</dt><dd data-testid="module-enabled-at">{{ fmtDay(m.enabled_at) }}</dd></template>
              <template v-if="m.requires?.length"><dt>먼저 켤 모듈</dt><dd data-testid="module-requires">{{ needsText(m) }}</dd></template>
              <dt>구독</dt><dd data-testid="module-subs">{{ subsText(m) }}</dd>
            </dl>
            <p v-if="unlockText(m)" class="card-unlock" data-testid="module-unlocks"><Icon name="analytics" :size="13" /><span>{{ unlockText(m) }}</span></p>
            <div v-for="s in m.enabled ? stallsOf(m) : []" :key="s.name" class="card-stall" data-testid="module-stall">
              <strong>이벤트 #{{ s.last_error_seq }} 에서 멈춤</strong>
              <span v-if="s.last_error_event" class="small"> · {{ eventLabel(s.last_error_event) }}</span>
              <p class="small card-error">{{ s.last_error }}</p>
              <router-link class="small" to="/settings/bus" data-testid="module-stall-open">이벤트 버스에서 처리하기</router-link>
            </div>
            <footer class="card-foot">
              <button v-if="m.enabled" type="button" class="btn" :disabled="!!writeBlock || busyId === m.id" :title="writeBlockMessage" data-testid="module-disable" @click="disable(m)">끄기</button>
              <template v-else>
                <span v-if="missingRequired(m).length" class="small dim" data-testid="module-requires">{{ missingRequired(m).join(', ') }} 모듈을 먼저 켜야 합니다</span>
                <button type="button" class="btn btn-primary" :disabled="!!writeBlock || busyId === m.id || missingRequired(m).length > 0" :title="writeBlockMessage" data-testid="module-enable" @click="enable(m)">켜기</button>
              </template>
            </footer>
          </article>
        </div>
        <EmptyState v-else-if="bus.loaded && !bus.error" title="설치된 모듈이 없습니다" text="모듈 SQL 을 실행하면 여기에 나타나고, 켜면 메뉴에 그 화면이 생깁니다." />
      </div>
    </template>
  </div>
</template>

<style scoped>
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; align-items: start; }
.card { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
.card.stuck { border-color: var(--red-line); }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.card-text { min-height: 19px; }
.card-facts { grid-template-columns: 76px minmax(0, 1fr); gap: 2px 8px; }
.card-unlock { display: flex; gap: 6px; padding: 5px 8px; background: var(--navy-50); border-radius: var(--radius-sm); color: var(--text); font-size: 12px; }
.card-unlock svg { margin-top: 2px; }
.card-stall { padding: 6px 8px; background: var(--red-bg); border: 1px solid var(--red-line); border-radius: var(--radius-sm); color: var(--red-fg); }
.card-error { margin: 2px 0 4px; overflow-wrap: anywhere; white-space: pre-wrap; }
.card-foot { display: flex; justify-content: flex-end; margin-top: 4px; }
@media (max-width: 720px) {
  .cards { grid-template-columns: minmax(0, 1fr); }
  .head-note { display: none; }
}
</style>

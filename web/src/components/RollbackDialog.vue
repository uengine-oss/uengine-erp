<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { messageOf, type ApiError } from '../lib/api'
import { moduleLabel } from '../lib/bus'
import { applyRollback } from '../lib/commands'
import { eventLabel } from '../lib/eventText'
import { stateOf } from '../lib/fields'
import { fmtDateTime } from '../lib/format'
import { previewRollback, rollbackRequest } from '../lib/rollback'
import { catalogOf } from '../lib/session'
import type { RollbackPlan, RollbackStream } from '../lib/types'
import { toast } from '../lib/ui'
import { navLabel } from '../nav'
import Icon from './Icon.vue'

const plan = ref<RollbackPlan | null>(null)
const loading = ref(false)
const loadError = ref('')
const applyError = ref('')
const notice = ref('')
const reason = ref('')
const reasonMissing = ref(false)
const accepted = ref(false)
const applying = ref(false)
const root = ref<HTMLElement | null>(null)
let returnFocus: HTMLElement | null = null

const LIST_LIMIT = 50
const EFFECT_LABELS: Record<string, string> = { quant: '재고', gl: '장부' }

async function loadPlan() {
  const req = rollbackRequest.value
  if (!req) return
  loading.value = true
  loadError.value = ''
  try {
    const next = await previewRollback(req.kind, req.target)
    if (rollbackRequest.value === req) plan.value = next
  } catch (e) {
    if (rollbackRequest.value === req) { plan.value = null; loadError.value = messageOf(e) }
  } finally {
    if (rollbackRequest.value === req) loading.value = false
  }
}

async function focusFirst() {
  await nextTick()
  root.value?.querySelector<HTMLElement>('input:not([disabled]), .dlg-foot .btn')?.focus()
}

async function retryPlan() {
  await loadPlan()
  await focusFirst()
}

// Listens on the document: the button holding focus can disappear when a retry succeeds.
watch(rollbackRequest, (req, old) => {
  if (req && !old) document.addEventListener('keydown', onKey)
  if (!req && old) document.removeEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey)
  // The session ended behind the dialog. It must not reappear for whoever signs in next.
  rollbackRequest.value?.resolve(null)
  rollbackRequest.value = null
})

watch(rollbackRequest, async (req) => {
  if (!req) return
  returnFocus = document.activeElement as HTMLElement | null
  plan.value = null
  applyError.value = ''
  notice.value = ''
  reason.value = ''
  reasonMissing.value = false
  accepted.value = false
  applying.value = false
  await retryPlan()
})

function close() {
  const req = rollbackRequest.value
  if (!req || applying.value) return
  rollbackRequest.value = null
  req.resolve(null)
  returnFocus?.focus?.()
}

const hasCascade = computed(() => !!plan.value?.cascade.length)
const blocked = computed(() => !!plan.value?.blocked.length)
const canApply = computed(() => !!plan.value && !plan.value.nothing_to_do && !blocked.value && !applying.value && !loading.value && (!hasCascade.value || accepted.value))
const shownStreams = computed(() => plan.value?.streams.slice(0, LIST_LIMIT) ?? [])
const hiddenStreams = computed(() => Math.max(0, (plan.value?.streams.length ?? 0) - LIST_LIMIT))

const moduleOf = (s: RollbackStream): string | null => {
  const id = catalogOf(s.type)?.module
  return id ? navLabel(id) ?? moduleLabel(id) : null
}
const modules = computed(() => [...new Set((plan.value?.streams ?? []).map(moduleOf).filter((m): m is string => !!m))])

function statusText(s: RollbackStream, value: string | null): string {
  if (!value) return '없음'
  const doc = catalogOf(s.type)
  return (doc && stateOf(doc, value)?.label) ?? value
}
const effectsText = (s: RollbackStream) => Object.entries(s.effects ?? {}).map(([k, rows]) => `${EFFECT_LABELS[k] ?? k} ${rows.length}줄`).join(', ')
const blockedName = (b: { type?: string; name?: string | null }) => b.name ?? (b.type && catalogOf(b.type)?.label) ?? ''

// These come back when the world changed after the preview: the answer is to look again, not to fail.
const REPLAN = new Set(['ERP_CONFLICT', 'ERP_ROLLBACK_BLOCKED', 'ERP_ROLLBACK_CASCADE', 'ERP_NOTHING'])

async function apply() {
  const req = rollbackRequest.value
  if (!req || !plan.value || !canApply.value) return
  if (!reason.value.trim()) {
    reasonMissing.value = true
    root.value?.querySelector<HTMLElement>('#rollback-reason')?.focus()
    return
  }
  applying.value = true
  applyError.value = ''
  notice.value = ''
  try {
    const done = await applyRollback(req.kind, req.target, plan.value.hash, hasCascade.value && accepted.value, reason.value.trim())
    applying.value = false
    rollbackRequest.value = null
    toast('되돌렸습니다. 사유가 원장에 남았습니다.')
    req.resolve(done)
    returnFocus?.focus?.()
  } catch (e) {
    applying.value = false
    const err = e as ApiError
    if (err.code && REPLAN.has(err.code)) {
      const said = err.code === 'ERP_CONFLICT' ? '미리보기 뒤에 데이터가 바뀌었습니다' : err.message.replace(/\.$/, '')
      notice.value = `${said}. 바뀐 내용을 다시 확인하세요.`
      accepted.value = false
      await loadPlan()
    } else {
      applyError.value = messageOf(e)
    }
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); close(); return }
  if (e.key !== 'Tab') return
  const items = root.value?.querySelectorAll<HTMLElement>('input, button:not([disabled]), a[href]')
  if (!items?.length) return
  const first = items[0]
  const last = items[items.length - 1]
  if (!root.value?.contains(document.activeElement)) { e.preventDefault(); first.focus() }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
}
</script>

<template>
  <div v-if="rollbackRequest" class="dlg-overlay" @mousedown.self="close">
    <div ref="root" class="dlg dlg-wide" role="dialog" aria-modal="true" aria-labelledby="rollback-title" data-testid="rollback-dialog">
      <form class="stack" style="gap: 0; min-height: 0" @submit.prevent="apply">
        <div class="dlg-head">
          <h2 id="rollback-title">{{ rollbackRequest.title }}</h2>
          <p v-if="rollbackRequest.subject" class="dim small" data-testid="rollback-subject">{{ rollbackRequest.subject }}</p>
        </div>
        <div class="dlg-body rb-body">
          <div v-if="notice" class="banner banner-warn" role="alert" data-testid="rollback-replanned"><Icon name="alert" /><span>{{ notice }}</span></div>

          <p v-if="loading && !plan" class="waiting"><span class="spin"></span>되돌릴 범위를 계산하는 중…</p>
          <div v-else-if="loadError" class="banner banner-error" role="alert" data-testid="rollback-error">
            <Icon name="alert" /><span class="grow">{{ loadError }}</span>
            <button type="button" class="btn btn-sm" data-testid="rollback-retry" @click="retryPlan">다시 시도</button>
          </div>

          <template v-if="plan">
            <p v-if="plan.nothing_to_do" class="rb-none" data-testid="rollback-nothing">되돌릴 내용이 없습니다. 이미 되돌렸거나 그 뒤로 바뀐 것이 없습니다.</p>

            <section v-if="blocked" class="banner banner-error rb-block" role="alert" data-testid="rollback-blocked">
              <strong><Icon name="lock" :size="13" /> 되돌릴 수 없습니다</strong>
              <ul>
                <li v-for="(b, i) in plan.blocked" :key="i"><span v-if="blockedName(b)" class="rb-who">{{ blockedName(b) }}: </span>{{ b.reason }}</li>
              </ul>
            </section>

            <section v-if="plan.warnings.length" class="banner banner-warn rb-block" data-testid="rollback-warnings">
              <strong><Icon name="alert" :size="13" /> 알아 둘 것</strong>
              <ul>
                <li v-for="(w, i) in plan.warnings" :key="i"><span v-if="w.name" class="rb-who">{{ w.name }}: </span>{{ w.message }}</li>
              </ul>
            </section>

            <section v-if="plan.streams.length">
              <h3 class="rb-h">되돌아갈 문서 {{ plan.streams.length }}건<span v-if="modules.length > 1" class="muted small" data-testid="rollback-modules"> · 모듈이 달라도 함께 되돌아갑니다 ({{ modules.join(', ') }})</span></h3>
              <ul class="rb-list" data-testid="rollback-streams">
                <li v-for="s in shownStreams" :key="s.id" data-testid="rollback-stream">
                  <div class="rb-line">
                    <span class="tag">{{ s.label ?? s.type }}</span>
                    <span class="grow ellipsis rb-name">{{ s.name ?? '(이름 없음)' }}</span>
                    <span class="muted small nowrap">v{{ s.from_version }} → v{{ s.to_version }}</span>
                  </div>
                  <div class="rb-sub small dim">
                    <template v-if="s.removes">없던 문서가 됩니다. 번호는 재사용하지 않습니다.</template>
                    <template v-else-if="s.from_status !== s.to_status">{{ statusText(s, s.from_status) }} → {{ statusText(s, s.to_status) }}</template>
                    <template v-else>이벤트 {{ s.events }}건의 변경이 되돌아갑니다.</template>
                    <template v-if="effectsText(s)"> · 함께 되돌아가는 합계: {{ effectsText(s) }}</template>
                  </div>
                </li>
                <li v-if="hiddenStreams" class="muted small">외 {{ hiddenStreams.toLocaleString('ko-KR') }}건</li>
              </ul>
            </section>

            <section v-if="hasCascade" data-testid="rollback-cascade">
              <h3 class="rb-h">뒤따른 작업 {{ plan.cascade.length }}건도 함께 되돌아갑니다</h3>
              <ul class="rb-list">
                <li v-for="c in plan.cascade" :key="c.correlation_id" class="rb-line">
                  <span class="grow ellipsis">{{ eventLabel(c.first_event) }}<span class="muted small"> · 이벤트 {{ c.events }}건</span></span>
                  <span class="muted small nowrap">{{ c.actor ?? '시스템' }} · {{ fmtDateTime(c.at).slice(5, 16) }}</span>
                </li>
              </ul>
              <label v-if="!blocked" class="check rb-accept">
                <input v-model="accepted" type="checkbox" data-testid="rollback-accept" />
                뒤따른 작업 {{ plan.cascade.length }}건도 함께 되돌리는 데 동의합니다
              </label>
            </section>

            <div v-if="!plan.nothing_to_do && !blocked" class="field-stack rb-reason">
              <label for="rollback-reason">사유<span class="req">*</span> <span class="muted">(필수, 원장에 남습니다)</span></label>
              <input id="rollback-reason" v-model="reason" class="input" autocomplete="off" :class="{ 'is-invalid': reasonMissing }" data-testid="rollback-reason" @input="reasonMissing = false" />
              <span v-if="reasonMissing" class="err-text small" role="alert" data-testid="rollback-reason-error">되돌리는 사유를 적어 주세요.</span>
            </div>
          </template>

          <p v-if="applyError" class="err-text" role="alert" data-testid="rollback-apply-error">{{ applyError }}</p>
        </div>
        <div class="dlg-foot">
          <button type="button" class="btn" :disabled="applying" data-testid="rollback-cancel" @click="close">{{ plan?.nothing_to_do || blocked ? '닫기' : '취소' }}</button>
          <button v-if="!plan?.nothing_to_do && !blocked" type="submit" class="btn btn-danger-solid" :disabled="!canApply" data-testid="rollback-apply">{{ applying ? '되돌리는 중…' : '되돌리기' }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.rb-body { display: flex; flex-direction: column; gap: 10px; }
.rb-body > * { color: var(--text); }
.rb-none { padding: 8px 0; color: var(--text-2); }
.rb-block { display: block; }
.rb-block strong { display: inline-flex; align-items: center; gap: 4px; }
.rb-block ul { margin: 4px 0 0; padding-left: 18px; }
.rb-who { font-weight: 600; }
.rb-h { margin-bottom: 4px; }
.rb-list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: var(--radius); max-height: 188px; overflow: auto; }
.rb-list > li { padding: 5px 8px; border-bottom: 1px solid var(--ink-100); }
.rb-list > li:last-child { border-bottom: 0; }
.rb-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
.rb-name { font-weight: 550; }
.rb-sub { margin-top: 1px; }
.rb-accept { margin-top: 6px; font-weight: 550; align-items: flex-start; }
.rb-accept input { margin-top: 3px; flex: none; }
.rb-reason { margin-top: 0 !important; }
</style>

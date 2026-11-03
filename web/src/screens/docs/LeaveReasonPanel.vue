<script setup lang="ts">
// The words beside a leave request. They live outside the ledger, so a person can have them erased, and this panel is only a view
// of that: the database decides who may read them and answers everyone else with a refusal whether or not this is drawn.
import { ref, watch } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { sendCommand } from '../../lib/commands'
import { writeBlock } from '../../lib/mode'
import type { ErpRecord } from '../../lib/types'
import { ask, toast } from '../../lib/ui'
import Icon from '../../components/Icon.vue'

defineOptions({ inheritAttrs: false })
const props = defineProps<{ record: ErpRecord | null }>()

interface Words { reason: string | null; reject_reason: string | null; has_row: boolean }
const words = ref<Words | null>(null)
const error = ref('')
const busy = ref(false)

async function load() {
  words.value = null
  error.value = ''
  if (!props.record?.id) return
  try {
    words.value = await rpc<Words>('erp_leave_reason', { p_request: props.record.id })
  } catch (e) {
    error.value = messageOf(e)
  }
}
watch(() => props.record?.id, load, { immediate: true })
watch(() => props.record?.version, load)

async function erase() {
  if (!props.record || busy.value) return
  const answer = await ask({
    title: '휴가 사유 지우기',
    message: '사유를 지웁니다. 되돌릴 수 없습니다.\n원장에는 지웠다는 사실과 지운 까닭, 처리한 사람만 남습니다.\n까닭도 원장에 남으니 사유의 내용을 적지 마세요.',
    danger: true,
    reason: true,
    reasonRequired: true,
    confirmLabel: '지우기',
  })
  if (!answer) return
  busy.value = true
  error.value = ''
  try {
    await sendCommand({ type: 'leave_request', id: props.record.id, command: 'erase_private', payload: {}, reason: answer.reason })
    toast('사유를 지웠습니다.')
    await load()
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section v-if="record" class="private no-print" data-testid="leave-reason-panel">
    <h2><Icon name="lock" :size="13" /> 사유 <span class="muted small">신청자, 상사, 인사 담당자만 봅니다. 원장에는 사유가 있다는 사실만 남습니다</span></h2>
    <p v-if="error" class="err-text small" role="alert">{{ error }}</p>
    <template v-if="words">
      <p v-if="words.reason" data-testid="leave-reason-text">{{ words.reason }}</p>
      <p v-if="words.reject_reason" data-testid="leave-reject-text"><span class="dim">반려 사유:</span> {{ words.reject_reason }}</p>
      <p v-if="!words.has_row" class="muted small" data-testid="leave-reason-empty">적힌 사유가 없습니다.</p>
      <button v-else type="button" class="btn btn-danger" :disabled="busy || !!writeBlock" data-testid="leave-reason-erase" @click="erase">사유 지우기</button>
    </template>
  </section>
</template>

<style scoped>
.private { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line); }
.private h2 { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 13px; flex-wrap: wrap; }
.private h2 .muted { font-weight: 450; }
</style>

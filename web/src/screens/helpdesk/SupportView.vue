<script setup lang="ts">
// What a customer sees of their support ticket: where it stands, the answers, their own words, and a box to answer. No account,
// reachable only by its token, the way a quotation's link works. The database shows nothing internal (no notes, no deadlines).
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { messageOf, toApiError } from '../../lib/api'
import { classifyKey, normalizeUrl } from '../../lib/conn'
import { fmtDateTime } from '../../lib/format'
import type { State } from '../../lib/types'
import { toast } from '../../lib/ui'
import EmptyState from '../../components/EmptyState.vue'

const props = defineProps<{ token: string }>()
const route = useRoute()

let client: SupabaseClient | null = null
function connect(): boolean {
  const url = normalizeUrl(String(route.query.u ?? ''))
  const key = String(route.query.k ?? '')
  if (!url.ok || !key || classifyKey(key) === 'secret') return false
  client = createClient(url.url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'erp.support' } })
  return true
}
async function call(fn: string, args: Record<string, unknown>): Promise<State> {
  if (!client) throw new Error('no connection')
  const { data, error, status } = await client.rpc(fn, { p_token: props.token, ...args })
  if (error) throw toApiError(error, status)
  return data as State
}

const ticket = ref<State | null>(null)
const failed = ref('')
const loading = ref(true)
const busy = ref(false)
const text = ref('')
const STAGE_COLOR: Record<string, string> = { new: 'gray', in_progress: 'blue', waiting: 'amber', solved: 'green', closed: 'gray', cancelled: 'red' }

onMounted(async () => {
  document.documentElement.classList.add('portal-doc')
  if (!connect()) { failed.value = '링크가 올바르지 않습니다. 담당자에게 다시 요청해 주세요.'; loading.value = false; return }
  try {
    ticket.value = await call('erp_portal_ticket', {})
    document.title = `${ticket.value.number ?? '문의'} · ${ticket.value.company?.name ?? ''}`
  } catch (e) {
    failed.value = messageOf(e)
  } finally {
    loading.value = false
  }
})
onBeforeUnmount(() => document.documentElement.classList.remove('portal-doc'))

async function send() {
  if (!text.value.trim() || busy.value) return
  busy.value = true
  try {
    ticket.value = await call('erp_portal_ticket_comment', { p_message: text.value })
    text.value = ''
    toast('남겼습니다. 담당자가 확인합니다.')
  } catch (e) {
    toast(messageOf(e), 'error')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="support" data-testid="support">
    <EmptyState v-if="failed" title="문의를 열 수 없습니다" :text="failed" />
    <p v-else-if="loading" class="muted" style="padding: 24px">불러오는 중…</p>
    <template v-else-if="ticket">
      <header class="support-head">
        <div><strong data-testid="support-company">{{ ticket.company?.name }}</strong><div class="small dim">{{ [ticket.company?.phone, ticket.company?.email].filter(Boolean).join(' · ') }}</div></div>
        <span class="pill" :class="`pill-${STAGE_COLOR[ticket.stage] ?? 'gray'}`" data-testid="support-stage">{{ ticket.stage_label }}</span>
      </header>
      <main class="support-main">
        <h1><span class="dim" data-testid="support-number">{{ ticket.number }}</span> {{ ticket.subject }}</h1>
        <p class="dim small">{{ ticket.partner_name }} 님이 {{ fmtDateTime(ticket.opened_at).slice(0, 16) }} 에 남긴 문의입니다.</p>
        <p v-if="ticket.description" class="desc">{{ ticket.description }}</p>
        <ol class="thread">
          <li v-for="(m, i) in ticket.messages" :key="i" :class="`msg msg-${m.kind}`" data-testid="support-message" :data-kind="m.kind">
            <div class="small"><strong>{{ m.kind === 'reply' ? `${m.by} (담당자)` : '고객' }}</strong> <span class="dim">{{ fmtDateTime(m.at).slice(0, 16) }}</span></div>
            <p>{{ m.body }}</p>
          </li>
        </ol>
        <p v-if="!ticket.messages?.length" class="muted small">담당자의 답을 기다리는 중입니다.</p>
        <form v-if="ticket.can_comment" class="comment" @submit.prevent="send">
          <label class="field-stack"><span>답하기</span><textarea v-model="text" class="input" rows="4" maxlength="4000" data-testid="support-comment"></textarea></label>
          <button type="submit" class="btn btn-primary" :disabled="busy || !text.trim()" data-testid="support-send">보내기</button>
        </form>
        <p v-else class="banner banner-warn" data-testid="support-closed">종료된 문의입니다. 다른 일이 있으면 새로 문의해 주세요.</p>
      </main>
    </template>
  </div>
</template>

<style>
html.portal-doc, html.portal-doc body, html.portal-doc #app { height: auto; min-height: 100%; }
</style>
<style scoped>
.support { max-width: 760px; margin: 0 auto; padding: 0 16px 40px; }
.support-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--line); }
.support-main { padding-top: 14px; }
.support-main h1 { font-size: 19px; margin-bottom: 2px; }
.desc { margin: 10px 0; padding: 10px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); white-space: pre-line; }
.thread { list-style: none; margin: 12px 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.msg { padding: 8px 12px; border-radius: var(--radius); border: 1px solid var(--line); background: var(--surface); }
.msg p { margin: 3px 0 0; white-space: pre-line; }
.msg-customer { background: var(--navy-50); margin-left: 40px; }
.comment { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.comment textarea { width: 100%; resize: vertical; }
.comment .btn { align-self: flex-end; }
</style>

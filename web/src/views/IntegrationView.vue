<script setup lang="ts">
// How other systems reach this company: long-lived keys, and the addresses to use them with. A key is shown once.
import { computed, onMounted, ref } from 'vue'
import { conn, db } from '../lib/conn'
import { messageOf, rpc, toApiError } from '../lib/api'
import { fmtDateTime, josa } from '../lib/format'
import { writeBlock, writeBlockMessage } from '../lib/mode'
import { isAdmin, session } from '../lib/session'
import type { ErpRecord, Field } from '../lib/types'
import { ask, copyText, toast } from '../lib/ui'
import EmptyState from '../components/EmptyState.vue'
import Icon from '../components/Icon.vue'

interface ApiKey { id: string; label: string; prefix: string; member: string | null; created_at: string; last_used_at: string | null; revoked_at: string | null }

const admin = computed(() => isAdmin())
const keys = ref<ApiKey[]>([])
const members = ref<ErpRecord[]>([])
const loaded = ref(false)
const error = ref('')
const fresh = ref<{ label: string; key: string; member: string } | null>(null)

async function load() {
  error.value = ''
  try {
    const [list, people] = await Promise.all([
      rpc<ApiKey[]>('erp_api_keys'),
      db().from('erp_records').select('*').eq('type', 'member').eq('active', true).order('name'),
    ])
    if (people.error) throw toApiError(people.error, people.status)
    keys.value = list
    members.value = (people.data ?? []) as ErpRecord[]
    loaded.value = true
  } catch (e) {
    error.value = messageOf(e)
  }
}
onMounted(() => { if (admin.value) void load() })

const base = computed(() => conn.value?.url ?? '')
const mcpUrl = computed(() => `${base.value}/rest/v1/rpc/erp_mcp`)
const restUrl = computed(() => `${base.value}/rest/v1/erp_api_partner`)
const publicKey = computed(() => conn.value?.key ?? '')
const shownKey = computed(() => fresh.value?.key ?? 'erpk_여기에_연동_키')
const mcpExample = computed(() => `curl ${mcpUrl.value} \\
  -H "apikey: ${publicKey.value}" \\
  -H "x-erp-key: ${shownKey.value}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`)
const restExample = computed(() => `curl "${restUrl.value}?limit=10" \\
  -H "apikey: ${publicKey.value}" \\
  -H "Authorization: Bearer <구성원 로그인 토큰>"`)
const resources = computed(() => session.catalog.filter((d) => !d.hidden && d.module !== 'settings').map((d) => ({ type: d.type, label: d.label })))

async function create() {
  const fields: Field[] = [
    { name: 'label', label: '이름', type: 'text', required: true, help: '어느 시스템이 쓰는 키인지 적어 두세요.' },
    {
      name: 'member_id', label: '이 구성원의 권한으로 동작', type: 'enum', required: true,
      options: members.value.map((m) => ({ value: m.id, label: `${m.state.name} (${m.state.email})` })),
      help: '이 키로 하는 모든 일은 이 구성원이 한 것으로 원장에 남고, 이 구성원의 역할만큼만 할 수 있습니다. 필요한 역할만 가진 구성원을 따로 만들어 쓰세요.',
    },
  ]
  let values: Record<string, any> = {}
  let message = ''
  for (;;) {
    const answer = await ask({ title: '연동 키 만들기', error: message, fields, values, confirmLabel: '만들기', wide: true })
    if (!answer) return
    values = answer.values
    if (!values.label?.trim() || !values.member_id) { message = '이름과 구성원을 모두 고르세요.'; continue }
    try {
      const res = await rpc<{ id: string; key: string; prefix: string }>('erp_api_key_create', { p_member_id: values.member_id, p_label: values.label.trim() })
      const who = members.value.find((m) => m.id === values.member_id)
      fresh.value = { label: values.label.trim(), key: res.key, member: String(who?.state.name ?? '') }
      await load()
      return
    } catch (e) {
      message = messageOf(e)
    }
  }
}

async function revoke(k: ApiKey) {
  const answer = await ask({
    title: `"${k.label}" 키 폐기`,
    message: '이 키를 쓰는 시스템은 바로 접속할 수 없게 됩니다. 되살릴 수 없으니 필요하면 새 키를 만드세요.',
    danger: true,
    confirmLabel: '폐기',
  })
  if (!answer) return
  try {
    await rpc('erp_api_key_revoke', { p_id: k.id })
    toast('키를 폐기했습니다.')
    await load()
  } catch (e) {
    toast(messageOf(e), 'error')
  }
}

async function copy(text: string, what: string) {
  const ok = await copyText(text)
  toast(ok ? `${josa(what, '을', '를')} 복사했습니다.` : '복사하지 못했습니다.', ok ? 'ok' : 'error')
}

const activeLabel = (k: ApiKey) => (k.revoked_at ? '폐기됨' : '사용 중')
</script>

<template>
  <div class="page" data-testid="integration">
    <div class="page-head">
      <h1>연동</h1>
      <span class="muted small head-note">에이전트와 외부 시스템이 이 회사의 데이터를 쓰는 길입니다.</span>
      <div class="grow"></div>
      <button v-if="admin" type="button" class="btn btn-primary" :disabled="!!writeBlock" :title="writeBlockMessage" data-testid="key-create" @click="create"><Icon name="plus" :size="13" />연동 키 만들기</button>
    </div>
    <div v-if="!admin" class="page-body"><EmptyState title="관리자만 볼 수 있습니다" text="연동 키는 관리자가 만들고 폐기합니다." /></div>
    <template v-else>
      <div v-if="error" class="banner banner-error banner-flush" role="alert" data-testid="keys-error"><Icon name="alert" /><span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" data-testid="keys-retry" @click="load">다시 시도</button></div>
      <div class="page-body page-pad">
        <div class="col">
          <section v-if="fresh" class="once" role="status" data-testid="key-once">
            <h2><Icon name="alert" :size="14" /> 이 키는 지금 한 번만 보여 줍니다</h2>
            <p class="small">"{{ fresh.label }}" 키가 {{ fresh.member }} 님의 권한으로 동작합니다. 이 화면을 떠나면 다시 볼 수 없고, 데이터베이스에는 해시만 남습니다.</p>
            <div class="row">
              <input class="input mono grow" readonly :value="fresh.key" aria-label="새 연동 키" data-testid="key-value" />
              <button type="button" class="btn btn-primary" data-testid="key-copy" @click="copy(fresh!.key, '연동 키')"><Icon name="copy" :size="13" />복사</button>
              <button type="button" class="btn" data-testid="key-dismiss" @click="fresh = null">저장했습니다</button>
            </div>
          </section>

          <section class="section">
            <h2 class="section-title">연동 키</h2>
            <div v-if="keys.length" class="tbl-wrap">
              <table class="tbl" data-testid="keys-table">
                <thead><tr><th>이름</th><th>앞자리</th><th>구성원 권한</th><th>만든 때</th><th>마지막 사용</th><th>상태</th><th></th></tr></thead>
                <tbody>
                  <tr v-for="k in keys" :key="k.id" :class="{ 'is-archived': k.revoked_at }" data-testid="key-row" :data-label="k.label">
                    <td>{{ k.label }}</td><td class="mono">{{ k.prefix }}…</td><td>{{ k.member ?? '-' }}</td><td class="nowrap">{{ fmtDateTime(k.created_at).slice(0, 16) }}</td><td class="nowrap">{{ k.last_used_at ? fmtDateTime(k.last_used_at).slice(0, 16) : '아직 없음' }}</td>
                    <td><span class="pill" :class="k.revoked_at ? 'pill-gray' : 'pill-green'" data-testid="key-state">{{ activeLabel(k) }}</span></td>
                    <td class="num"><button v-if="!k.revoked_at" type="button" class="btn btn-sm btn-danger" :disabled="!!writeBlock" data-testid="key-revoke" @click="revoke(k)">폐기</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-else-if="loaded" class="muted" data-testid="keys-empty">아직 만든 키가 없습니다. 로그인 토큰은 1시간이면 만료되므로, 오래 도는 연동에는 키를 만들어 주세요.</p>
          </section>

          <section class="section" data-testid="mcp-guide">
            <h2 class="section-title">MCP</h2>
            <p class="dim">에이전트가 도구 4개(조회, 만들기, 고치기, 지우기)로 켜져 있는 모듈의 문서를 다룹니다. 서버를 따로 띄우지 않습니다.</p>
            <dl class="kv">
              <dt>주소</dt><dd class="line"><code data-testid="mcp-url">{{ mcpUrl }}</code><button type="button" class="btn btn-sm btn-ghost" aria-label="MCP 주소 복사" data-testid="mcp-copy" @click="copy(mcpUrl, 'MCP 주소')"><Icon name="copy" :size="12" /></button></dd>
              <dt>헤더 <code>apikey</code></dt><dd>이 프로젝트의 공개 키</dd>
              <dt>헤더 <code>x-erp-key</code></dt><dd>위에서 만든 연동 키</dd>
            </dl>
            <pre class="code" data-testid="mcp-example">{{ mcpExample }}</pre>
          </section>

          <section class="section" data-testid="rest-guide">
            <h2 class="section-title">REST</h2>
            <p class="dim">문서 유형마다 자원이 하나씩 있습니다. <code>GET</code>·<code>POST</code>·<code>PATCH</code>·<code>DELETE</code> 를 쓰고, 한 요청에 한 건을 고칩니다. 모든 쓰기는 화면과 같은 규칙을 거쳐 원장에 남습니다. REST 는 구성원의 로그인 토큰으로 호출하고, 연동 키는 MCP 에서 씁니다.</p>
            <pre class="code" data-testid="rest-example">{{ restExample }}</pre>
            <details class="small">
              <summary>지금 켜져 있는 자원 {{ resources.length }}개</summary>
              <ul class="res" data-testid="rest-resources"><li v-for="r in resources" :key="r.type"><code>/rest/v1/erp_api_{{ r.type }}</code> <span class="muted">{{ r.label }}</span></li></ul>
            </details>
          </section>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.col { max-width: 860px; }
.once { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; padding: 10px 12px; background: var(--amber-bg); border: 1px solid var(--amber-line); border-radius: var(--radius); color: var(--amber-fg); }
.once h2 { display: inline-flex; align-items: center; gap: 6px; }
.once .input { color: var(--text); background: var(--surface); }
.tbl-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.tbl-wrap .tbl th { position: static; }
.line { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.line code { overflow-wrap: anywhere; }
.code { margin: 8px 0 0; padding: 8px 10px; background: var(--ink-50); border: 1px solid var(--line); border-radius: var(--radius); font-family: var(--mono); font-size: 11.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.res { margin: 4px 0 0; padding-left: 16px; columns: 2; }
@media (max-width: 720px) { .head-note { display: none; } .once .row { flex-wrap: wrap; } .res { columns: 1; } }
</style>

<script setup lang="ts">
// What a customer sees: one quotation, with no account, reachable only by its token. The database answers these calls for
// anyone holding the token and shows nothing internal, so this page holds no connection of its own beyond the link.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { messageOf, toApiError } from '../../lib/api'
import { classifyKey, normalizeUrl } from '../../lib/conn'
import { fmtMoney, fmtNumber } from '../../lib/format'
import type { State } from '../../lib/types'
import { ask, toast } from '../../lib/ui'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'

const props = defineProps<{ token: string }>()
const route = useRoute()
const MAX_SIGNATURE = 200000
const FILE_LIMIT = 140 * 1024

let client: SupabaseClient | null = null
function connect(): boolean {
  const url = normalizeUrl(String(route.query.u ?? ''))
  const key = String(route.query.k ?? '')
  if (!url.ok || !key || classifyKey(key) === 'secret') return false
  client = createClient(url.url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'erp.portal' } })
  return true
}
async function call(fn: string, args: Record<string, unknown>): Promise<State> {
  if (!client) throw new Error('no connection')
  const { data, error, status } = await client.rpc(fn, { p_token: props.token, ...args })
  if (error) throw toApiError(error, status)
  return data as State
}

const quote = ref<State | null>(null)
const failed = ref('')
const loading = ref(true)
const busy = ref(false)

onMounted(async () => {
  document.documentElement.classList.add('portal-doc')
  if (!connect()) { failed.value = '링크가 올바르지 않습니다. 담당자에게 다시 요청해 주세요.'; loading.value = false; return }
  try {
    quote.value = await call('erp_portal_get', {})
    document.title = `${quote.value.number ?? '견적'} · ${quote.value.company?.name ?? ''}`
  } catch (e) {
    failed.value = messageOf(e)
  } finally {
    loading.value = false
  }
})
onBeforeUnmount(() => document.documentElement.classList.remove('portal-doc'))

const money = (v: unknown) => `${fmtMoney(v)} ${quote.value?.company?.currency ?? ''}`.trim()
const stateText = computed(() => {
  const q = quote.value
  if (!q) return ''
  if (q.state === 'sale') return '주문이 확정되었습니다.'
  if (q.state === 'cancelled') return '이 견적은 취소되었습니다.'
  if (q.is_expired) return '유효기간이 지난 견적입니다. 담당자에게 문의해 주세요.'
  return ''
})
const options = computed<State[]>(() => (quote.value?.optional_lines ?? []).filter((o: State) => !o.added))

async function act(fn: string, args: Record<string, unknown>, done: string): Promise<boolean> {
  busy.value = true
  try {
    quote.value = await call(fn, args)
    toast(done)
    return true
  } catch (e) {
    toast(messageOf(e), 'error')
    return false
  } finally {
    busy.value = false
  }
}
async function addOption(o: State) {
  const answer = await ask({ title: `${o.name} 담기`, confirmLabel: '담기', fields: [{ name: 'qty', label: '수량', type: 'number', required: true }], values: { qty: o.qty ?? 1 } })
  if (answer) await act('erp_portal_add_option', { p_option_id: o.id, p_qty: answer.values.qty }, '견적에 담았습니다. 담당자도 볼 수 있습니다.')
}
async function decline() {
  const answer = await ask({ title: '견적 거절', message: '거절하면 이 견적은 취소됩니다.', danger: true, confirmLabel: '거절', cancelLabel: '돌아가기', fields: [{ name: 'reason', label: '사유(선택)', type: 'text' }] })
  if (answer) await act('erp_portal_decline', { p_reason: answer.values.reason || null }, '거절했습니다.')
}

/* Signing: a typed name turned into a picture, a drawing, or a file */
const signing = ref(false)
const signMode = ref<'auto' | 'draw' | 'file'>('auto')
const signer = ref('')
const signFile = ref('')
const signError = ref('')
const canvas = ref<HTMLCanvasElement | null>(null)
let drawing = false
let drew = false

function prepareCanvas() {
  const c = canvas.value
  if (!c) return
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.strokeStyle = '#101b2f'
  ctx.fillStyle = '#101b2f'
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  drew = false
}
watch([signMode, signing], () => { if (signing.value && signMode.value === 'draw') void Promise.resolve().then(prepareCanvas) })
const pointAt = (e: PointerEvent) => { const r = canvas.value!.getBoundingClientRect(); return [(e.clientX - r.left) * (canvas.value!.width / r.width), (e.clientY - r.top) * (canvas.value!.height / r.height)] }
function penDown(e: PointerEvent) {
  drawing = true
  canvas.value!.setPointerCapture(e.pointerId)
  const ctx = canvas.value!.getContext('2d')!
  ctx.beginPath()
  ctx.moveTo(...(pointAt(e) as [number, number]))
}
function penMove(e: PointerEvent) {
  if (!drawing) return
  const ctx = canvas.value!.getContext('2d')!
  ctx.lineTo(...(pointAt(e) as [number, number]))
  ctx.stroke()
  drew = true
}
function penUp() { drawing = false }
function typedSignature(name: string): string {
  const c = document.createElement('canvas')
  c.width = 420
  c.height = 110
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.fillStyle = '#101b2f'
  ctx.font = 'italic 40px "Pretendard Variable", serif'
  ctx.textBaseline = 'middle'
  ctx.fillText(name, 14, 56, 392)
  return c.toDataURL('image/png')
}
function onSignFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  signError.value = ''
  signFile.value = ''
  if (!file) return
  if (!file.type.startsWith('image/') || file.size > FILE_LIMIT) { signError.value = '140KB 이하의 그림 파일을 올려 주세요.'; return }
  const r = new FileReader()
  r.onload = () => { signFile.value = String(r.result) }
  r.readAsDataURL(file)
}
async function sign() {
  signError.value = ''
  const name = signer.value.trim()
  if (!name) { signError.value = '서명하는 분의 이름을 적어 주세요.'; return }
  let image = ''
  if (signMode.value === 'auto') image = typedSignature(name)
  else if (signMode.value === 'draw') {
    if (!drew) { signError.value = '서명을 그려 주세요.'; return }
    image = canvas.value!.toDataURL('image/png')
  } else {
    if (!signFile.value) { signError.value = '서명 파일을 올려 주세요.'; return }
    image = signFile.value
  }
  if (image.length > MAX_SIGNATURE) { signError.value = '서명 이미지가 너무 큽니다.'; return }
  if (await act('erp_portal_sign', { p_name: name, p_signature: image }, '서명했습니다. 감사합니다.')) signing.value = false
}
const printPage = () => window.print()
</script>

<template>
  <div class="portal" data-testid="portal">
    <EmptyState v-if="failed" title="견적을 열 수 없습니다" :text="failed" />
    <p v-else-if="loading" class="muted" style="padding: 24px">불러오는 중…</p>
    <template v-else-if="quote">
      <header class="portal-head">
        <div><strong data-testid="portal-company">{{ quote.company?.name }}</strong><div class="small dim">{{ [quote.company?.phone, quote.company?.email].filter(Boolean).join(' · ') }}</div></div>
        <button type="button" class="btn no-print" data-testid="portal-print" @click="printPage"><Icon name="printer" :size="13" />인쇄</button>
      </header>
      <main class="portal-main">
        <h1 data-testid="portal-number">{{ quote.number }}</h1>
        <p class="dim">{{ quote.partner_name }} 님께 보내는 견적입니다.</p>
        <dl class="kv small portal-kv">
          <template v-if="quote.date_order"><dt>주문일</dt><dd>{{ String(quote.date_order).slice(0, 10) }}</dd></template>
          <template v-if="quote.validity_date"><dt>유효기간</dt><dd data-testid="portal-validity">{{ quote.validity_date }}<span v-if="quote.is_expired" class="pill pill-red" style="margin-left: 6px" data-testid="portal-expired">지남</span></dd></template>
          <template v-if="quote.client_ref"><dt>참조번호</dt><dd>{{ quote.client_ref }}</dd></template>
        </dl>
        <div v-if="stateText" class="banner" :class="quote.state === 'sale' ? 'banner-ok' : 'banner-warn'" style="margin-top: 10px" role="status" data-testid="portal-state">{{ stateText }}</div>

        <div class="scroll-x portal-box">
          <table class="tbl" data-testid="portal-lines">
            <thead><tr><th>품목</th><th class="num">수량</th><th class="num">단가</th><th class="num">할인</th><th class="num">세액</th><th class="num">금액</th></tr></thead>
            <tbody>
              <template v-for="l in quote.lines" :key="l.id">
                <tr v-if="l.display_type" class="portal-section"><td colspan="6" class="wrap">{{ l.name }}</td></tr>
                <tr v-else :class="{ 'portal-added': l.from_portal }" data-testid="portal-line" :data-added="l.from_portal ? '1' : '0'"><td class="wrap">{{ l.name }}<span v-if="l.from_portal" class="tag" style="margin-left: 4px">추가함</span></td><td class="num">{{ fmtNumber(l.qty) }} {{ l.uom }}</td><td class="num">{{ fmtMoney(l.price_unit) }}</td><td class="num">{{ l.discount ? `${fmtNumber(l.discount)}%` : '' }}</td><td class="num">{{ fmtMoney(l.tax_amount) }}</td><td class="num">{{ fmtMoney(l.subtotal) }}</td></tr>
              </template>
            </tbody>
          </table>
        </div>
        <dl class="portal-totals">
          <dt>공급가액</dt><dd>{{ money(quote.amount_untaxed) }}</dd>
          <dt>세액</dt><dd>{{ money(quote.amount_tax) }}</dd>
          <dt class="grand">합계</dt><dd class="grand" data-testid="portal-total">{{ money(quote.amount_total) }}</dd>
        </dl>
        <p v-if="quote.note" class="dim small" style="white-space: pre-line; margin-top: 10px">{{ quote.note }}</p>

        <section v-if="options.length" class="portal-section-block no-print" data-testid="portal-options">
          <h2>함께 고를 수 있는 제품</h2>
          <div v-for="o in options" :key="o.id" class="option" data-testid="portal-option" :data-name="o.name">
            <span class="grow">{{ o.name }} <span class="muted small">{{ fmtMoney(o.price_unit) }}<template v-if="o.discount"> · {{ fmtNumber(o.discount) }}% 할인</template></span></span>
            <button v-if="quote.can_add_options" type="button" class="btn btn-sm" :disabled="busy" data-testid="portal-option-add" @click="addOption(o)"><Icon name="plus" :size="11" />담기</button>
          </div>
        </section>

        <section v-if="quote.signed_by" class="portal-section-block" data-testid="portal-signed"><p>{{ quote.signed_by }} 님이 {{ String(quote.signed_at ?? '').slice(0, 10) }} 에 서명했습니다.</p></section>
        <p v-if="quote.state === 'sent' && quote.require_payment && quote.signed_by" class="hint">온라인 결제는 제공하지 않습니다. 담당자가 확인한 뒤 주문을 확정합니다.</p>

        <div v-if="!signing" class="row-wrap portal-actions no-print">
          <button v-if="quote.can_sign" type="button" class="btn btn-primary btn-lg" data-testid="portal-sign-open" @click="signing = true">서명하고 주문하기</button>
          <button v-if="quote.can_decline" type="button" class="btn btn-lg" :disabled="busy" data-testid="portal-decline" @click="decline">거절</button>
        </div>
        <section v-else class="portal-section-block no-print" data-testid="portal-sign">
          <h2>서명</h2>
          <label class="field-stack"><span>이름</span><input v-model="signer" class="input" autocomplete="name" data-testid="portal-signer" /></label>
          <div class="seg" role="group" aria-label="서명 방법" style="margin-top: 8px">
            <button type="button" :class="{ on: signMode === 'auto' }" :aria-pressed="signMode === 'auto'" data-testid="sign-auto" @click="signMode = 'auto'">이름으로</button>
            <button type="button" :class="{ on: signMode === 'draw' }" :aria-pressed="signMode === 'draw'" data-testid="sign-draw" @click="signMode = 'draw'">직접 그리기</button>
            <button type="button" :class="{ on: signMode === 'file' }" :aria-pressed="signMode === 'file'" data-testid="sign-file" @click="signMode = 'file'">파일</button>
          </div>
          <div v-if="signMode === 'draw'" style="margin-top: 8px">
            <canvas ref="canvas" width="420" height="130" class="sign-pad" aria-label="서명란" data-testid="sign-pad" @pointerdown="penDown" @pointermove="penMove" @pointerup="penUp" @pointerleave="penUp"></canvas>
            <button type="button" class="btn btn-sm btn-ghost" @click="prepareCanvas">다시 그리기</button>
          </div>
          <input v-else-if="signMode === 'file'" class="input" style="margin-top: 8px" type="file" accept="image/*" aria-label="서명 파일" data-testid="sign-upload" @change="onSignFile" />
          <p v-if="signError" class="err-text small" role="alert" style="margin-top: 6px" data-testid="sign-error">{{ signError }}</p>
          <div class="row-wrap" style="margin-top: 10px">
            <button type="button" class="btn btn-primary" :disabled="busy" data-testid="portal-sign-go" @click="sign">서명</button>
            <button type="button" class="btn" @click="signing = false">취소</button>
          </div>
        </section>
      </main>
    </template>
  </div>
</template>

<style>
html.portal-doc, html.portal-doc body, html.portal-doc #app { height: auto; min-height: 100%; }
</style>
<style scoped>
.portal { max-width: 860px; margin: 0 auto; padding: 0 16px 40px; }
.portal-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--line); }
.portal-main { padding-top: 14px; }
.portal-main h1 { font-size: 20px; margin-bottom: 2px; }
.portal-kv { margin-top: 10px; }
.portal-box { margin-top: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
.portal-section td { font-weight: 650; background: var(--ink-50); }
.portal-added td { background: var(--green-bg); }
.portal-totals { display: grid; grid-template-columns: auto minmax(120px, auto); justify-content: end; gap: 3px 16px; margin: 10px 0 0; }
.portal-totals dt { color: var(--text-2); text-align: right; }
.portal-totals dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.portal-totals .grand { padding-top: 4px; border-top: 1px solid var(--line-strong); font-size: 15px; font-weight: 650; color: var(--text); }
.portal-section-block { margin-top: 18px; padding: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
.portal-section-block h2 { margin-bottom: 6px; font-size: 13px; }
.option { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.portal-actions { margin-top: 18px; }
.sign-pad { display: block; width: 100%; max-width: 420px; height: auto; background: #fff; border: 1px solid var(--line-strong); border-radius: var(--radius); touch-action: none; cursor: crosshair; }
</style>

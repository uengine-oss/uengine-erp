<script setup lang="ts">
// A statement line against what it could be: a posted payment, an unpaid document, or an account for a fee.
import { computed, ref, watch } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { nudgeBus, sendCommand } from '../../lib/commands'
import { fmtMoney } from '../../lib/format'
import { useLoad } from '../../lib/load'
import { writeBlock } from '../../lib/mode'
import { ensureNames, refLabel } from '../../lib/refs'
import { toast } from '../../lib/ui'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'
import LoadError from '../../components/LoadError.vue'

interface Line { id: string; date: string; amount: number; payment_ref: string | null; partner_id: string | null; state: string; residual: number; matches: { payment_id: string; number: string | null; amount: number }[]; booked: { account_id: string; amount: number; name: string | null }[]; running_balance: number }
interface Candidates {
  payments: { id: string; number: string | null; date: string | null; amount: number; partner_id: string | null; exact: boolean }[]
  documents: { id: string; number: string | null; partner_id: string | null; residual: number; due_date: string | null; exact: boolean; named: boolean }[]
  accounts: { id: string; code: string; name: string }[]
}

const props = defineProps<{ journal: string }>()
defineEmits<{ next: [] }>()
const onlyOpen = ref(true)
const chosen = ref<string | null>(null)
const pickPayments = ref<string[]>([])
const pickDocs = ref<string[]>([])
const account = ref('')
const label = ref('')
const busy = ref(false)
const canWrite = computed(() => !writeBlock.value)

const { data, loading, error, load } = useLoad(async () => {
  const list = await rpc<Line[]>('erp_bank_lines', { p_journal_id: props.journal, p_only_open: onlyOpen.value, p_limit: 500 })
  await ensureNames(list.map((l) => l.partner_id))
  return list
})
watch(() => [props.journal, onlyOpen.value], load, { immediate: true })
const lines = computed(() => data.value ?? [])
const line = computed(() => lines.value.find((l) => l.id === chosen.value) ?? null)

const cand = useLoad(async () => {
  const c = await rpc<Candidates>('erp_bank_match_candidates', { p_line_id: chosen.value })
  await ensureNames([...c.payments.map((p) => p.partner_id), ...c.documents.map((d) => d.partner_id)])
  return c
})
function open(l: Line) {
  chosen.value = l.id
  pickPayments.value = []
  pickDocs.value = []
  account.value = ''
  label.value = l.payment_ref ?? ''
  if (l.state === 'open') void cand.load()
  else cand.data.value = null
}
async function act(command: string, payload: object, done: string) {
  if (!line.value) return
  busy.value = true
  try {
    await sendCommand({ type: 'bank_line', id: line.value.id, command, payload: payload as Record<string, unknown> })
    toast(done)
    const id = line.value.id
    await load()
    const next = lines.value.find((l) => l.id === id) ?? lines.value.find((l) => l.state === 'open')
    if (next) open(next); else chosen.value = null
  } catch (e) {
    toast(messageOf(e), 'error')
  } finally {
    busy.value = false
  }
}
const without = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id])
const togglePayment = (id: string) => { pickPayments.value = without(pickPayments.value, id) }
const toggleDocument = (id: string) => { pickDocs.value = without(pickDocs.value, id) }

async function autoMatch() {
  busy.value = true
  try {
    const res = await rpc<{ matched: number }>('erp_bank_auto_match', { p_journal_id: props.journal })
    nudgeBus()
    toast(res.matched ? `${res.matched}건을 맞췄습니다. 애매한 것은 그대로 둡니다.` : '확실히 맞는 거래가 없습니다.')
    chosen.value = null
    await load()
  } catch (e) {
    toast(messageOf(e), 'error')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="report-pad" data-testid="bank-match">
    <div class="row-wrap" style="margin-bottom: 8px">
      <button v-if="canWrite" type="button" class="btn btn-primary" :disabled="busy" data-testid="bank-auto" @click="autoMatch">확실한 것 자동으로 맞추기</button>
      <label class="check small dim"><input v-model="onlyOpen" type="checkbox" data-testid="bank-only-open" />미대사만</label>
      <div class="grow"></div>
      <button type="button" class="btn" data-testid="bank-to-diff" @click="$emit('next')">차이 확인으로<Icon name="chevron-right" :size="12" /></button>
    </div>
    <LoadError :message="error" @retry="load" />
    <div class="match-split">
      <div class="scroll-x match-lines">
        <table v-if="lines.length" class="tbl" data-testid="bank-lines">
          <thead><tr><th>거래일</th><th>적요</th><th class="num">금액</th><th class="num">남은 금액</th><th class="num">잔액</th><th>상태</th></tr></thead>
          <tbody>
            <tr v-for="l in lines" :key="l.id" class="clickable" :class="{ 'is-selected': chosen === l.id }" tabindex="0" data-testid="bank-line" :data-ref="l.payment_ref" @click="open(l)" @keydown.enter="open(l)">
              <td>{{ l.date }}</td><td>{{ l.payment_ref }}</td><td class="num" :class="{ neg: l.amount < 0 }">{{ fmtMoney(l.amount) }}</td><td class="num" data-testid="bank-line-residual">{{ fmtMoney(l.residual) }}</td><td class="num">{{ fmtMoney(l.running_balance) }}</td>
              <td><span class="pill" :class="l.state === 'matched' ? 'pill-green' : 'pill-amber'" data-testid="bank-line-state">{{ l.state === 'matched' ? '대사 끝남' : '미대사' }}</span></td>
            </tr>
          </tbody>
        </table>
        <EmptyState v-else-if="!loading && !error" :title="onlyOpen ? '맞출 거래가 없습니다' : '거래가 없습니다'" text="명세서 단계에서 거래를 넣으면 여기에 나타납니다." />
      </div>
      <aside v-if="line" class="match-side" data-testid="bank-side">
        <h2>{{ line.payment_ref || '이 거래' }} · {{ fmtMoney(line.residual) }}</h2>
        <template v-if="line.matches.length || line.booked.length">
          <h3>맞춘 것</h3>
          <ul class="plain">
            <li v-for="m in line.matches" :key="m.payment_id" data-testid="bank-matched"><router-link :to="{ name: 'record', params: { type: 'payment', id: m.payment_id } }">{{ m.number }}</router-link> {{ fmtMoney(m.amount) }} <button v-if="canWrite" type="button" class="btn btn-sm btn-ghost" :disabled="busy" data-testid="bank-unmatch" @click="act('unmatch', { payment_id: m.payment_id }, '맞춤을 풀었습니다.')">풀기</button></li>
            <li v-for="(b, i) in line.booked" :key="i" data-testid="bank-booked">{{ b.name }} {{ fmtMoney(b.amount) }}</li>
          </ul>
          <button v-if="canWrite && line.booked.length" type="button" class="btn btn-sm" :disabled="busy" data-testid="bank-unbook" @click="act('unbook', {}, '분개를 풀었습니다.')">분개 풀기</button>
        </template>
        <LoadError :message="cand.error.value" @retry="cand.load" />
        <template v-if="line.state === 'open' && cand.data.value && canWrite">
          <section v-if="cand.data.value.payments.length">
            <h3>이미 등록한 입금·지급</h3>
            <label v-for="p in cand.data.value.payments" :key="p.id" class="check cand" data-testid="cand-payment" :data-number="p.number"><input type="checkbox" :checked="pickPayments.includes(p.id)" @change="togglePayment(p.id)" />{{ p.number }} · {{ p.date }} · {{ refLabel(p.partner_id) }} · {{ fmtMoney(p.amount) }}<span v-if="p.exact" class="tag">금액 일치</span></label>
            <button type="button" class="btn btn-sm btn-primary" :disabled="busy || !pickPayments.length" data-testid="bank-match-payments" @click="act('match', { payment_ids: pickPayments }, '맞췄습니다.')">맞추기</button>
          </section>
          <section v-if="cand.data.value.documents.length">
            <h3>아직 안 받은 문서</h3>
            <label v-for="d in cand.data.value.documents" :key="d.id" class="check cand" data-testid="cand-document" :data-number="d.number"><input type="checkbox" :checked="pickDocs.includes(d.id)" @change="toggleDocument(d.id)" />{{ d.number }} · {{ refLabel(d.partner_id) }} · {{ fmtMoney(d.residual) }}<span v-if="d.exact" class="tag">금액 일치</span><span v-if="d.named" class="tag">적요에 번호</span></label>
            <button type="button" class="btn btn-sm btn-primary" :disabled="busy || !pickDocs.length" data-testid="bank-pay-documents" @click="act('pay', { move_ids: pickDocs }, '입금을 등록하고 맞췄습니다.')">입금 등록하고 맞추기</button>
          </section>
          <section>
            <h3>계정으로 분개 (수수료, 이자)</h3>
            <div class="row-wrap">
              <select v-model="account" class="select" style="width: 190px" aria-label="상대 계정" data-testid="bank-account"><option value="">계정 선택</option><option v-for="a in cand.data.value.accounts" :key="a.id" :value="a.id">{{ a.code }} {{ a.name }}</option></select>
              <input v-model="label" class="input" style="width: 170px" placeholder="적요" aria-label="적요" data-testid="bank-book-label" />
              <button type="button" class="btn btn-sm" :disabled="busy || !account" data-testid="bank-book" @click="act('book', { account_id: account, name: label || undefined }, '분개했습니다.')">분개</button>
            </div>
            <p v-if="!cand.data.value.accounts.length" class="hint">대사 허용을 켠 계정이 없습니다. 계정과목에서 켜세요.</p>
          </section>
        </template>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.match-split { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 12px; align-items: start; }
.match-lines { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
.match-side { padding: 10px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); min-width: 0; }
.match-side h3 { margin: 10px 0 4px; font-size: 12px; color: var(--text-2); }
.cand { display: flex; flex-wrap: wrap; }
.plain { list-style: none; margin: 0; padding: 0; }
@media (max-width: 720px) { .match-split { grid-template-columns: minmax(0, 1fr); } }
</style>

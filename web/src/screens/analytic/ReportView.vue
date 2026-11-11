<script setup lang="ts">
// Revenue, cost and margin by analytic account for a period, read from the analytic lines the books gave. A row opens the lines
// behind it, each leading to its entry and the document it came from. The time view reads the ledger as it stood then.
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { messageOf, rpc } from '../../lib/api'
import { onDataChanged } from '../../lib/commands'
import { fmtMoney } from '../../lib/format'
import { timeView } from '../../lib/mode'
import { session } from '../../lib/session'
import Icon from '../../components/Icon.vue'

interface Row { analytic_account_id: string; code: string | null; name: string; plan_id: string | null; plan_name: string | null; revenue: number; cost: number; margin: number; other: number; lines: number; active: boolean }
interface Report { rows: Row[]; totals: { revenue: number; cost: number; margin: number; other: number }; plans: { id: string; name: string }[] }
interface Line { date: string; move_id: string; number: string | null; origin_type: string | null; origin_id: string | null; account_code: string | null; account_name: string | null; kind: string; partner_name: string | null; name: string | null; source: string; percent: number | null; amount: number }
interface Lines { name: string; rows: Line[]; total: number }

const route = useRoute()
const router = useRouter()
const today = () => {
  const tz = session.company?.state?.timezone || 'Asia/Seoul'
  return new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(timeView.at ? new Date(timeView.at) : new Date())
}
function quarterOf(day: string): [string, string] {
  const [y, m] = day.split('-').map(Number)
  const q0 = Math.floor((m - 1) / 3) * 3 + 1
  const end = new Date(Date.UTC(y, q0 + 2, 0)).toISOString().slice(0, 10)
  return [`${y}-${String(q0).padStart(2, '0')}-01`, end]
}
const [q1, q2] = quarterOf(today())
const from = ref(String(route.query.from ?? q1))
const to = ref(String(route.query.to ?? q2))
const plan = ref<string>(String(route.query.plan ?? ''))
const picked = ref<string>(String(route.query.account ?? ''))
const data = ref<Report | null>(null)
const lines = ref<Lines | null>(null)
const error = ref('')
let seq = 0

const showOther = computed(() => !!data.value?.rows.some((r) => Number(r.other) !== 0))
const pickedRow = computed(() => data.value?.rows.find((r) => r.analytic_account_id === picked.value) ?? null)

async function load() {
  const my = ++seq
  error.value = ''
  try {
    const at = timeView.at || null
    const r = await rpc<Report>('erp_analytic_report', { p_from: from.value || null, p_to: to.value || null, p_plan: plan.value || null, p_at: at })
    const l = picked.value ? await rpc<Lines>('erp_analytic_lines', { p_account: picked.value, p_from: from.value || null, p_to: to.value || null, p_at: at }) : null
    if (my !== seq) return
    data.value = r
    lines.value = l
  } catch (e) {
    if (my === seq) error.value = messageOf(e)
  }
}
function pick(id: string) {
  picked.value = picked.value === id ? '' : id
}
watch([from, to, plan, picked], () => {
  void router.replace({ query: { from: from.value, to: to.value, ...(plan.value ? { plan: plan.value } : {}), ...(picked.value ? { account: picked.value } : {}) } })
  void load()
})
onMounted(load)
watch(() => timeView.at, load)
onDataChanged(() => { void load() })

const docLink = (l: Line) => (l.origin_type && l.origin_id
  ? { name: 'record', params: { type: l.origin_type, id: l.origin_id } }
  : { name: 'record', params: { type: 'journal_entry', id: l.move_id } })
</script>

<template>
  <div class="page" data-testid="analytic-report">
    <div class="page-head">
      <h1>분석 계정별 손익</h1>
      <div class="row filters">
        <label class="small">기간 <input v-model="from" class="input" type="date" aria-label="시작일" data-testid="analytic-from" /></label>
        <span class="muted">~</span>
        <input v-model="to" class="input" type="date" aria-label="종료일" data-testid="analytic-to" />
        <select v-model="plan" class="select" aria-label="계획" data-testid="analytic-plan">
          <option value="">모든 계획</option>
          <option v-for="p in data?.plans ?? []" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </div>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert"><Icon name="alert" /><span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" @click="load">다시 시도</button></div>
    <div class="page-body page-pad">
      <p class="muted small">게시한 청구서·공급사 청구서·수동 전표·경비가 분석 계정에 나눈 금액입니다. 매출은 수익 계정, 비용은 비용 계정에 잡힌 금액이고, 이익은 둘의 차이입니다. 행을 누르면 그 금액을 이룬 줄과 원본 문서가 나옵니다.</p>
      <table v-if="data" class="tbl" data-testid="analytic-table">
        <thead>
          <tr><th>계획</th><th>코드</th><th>분석 계정</th><th class="num">매출</th><th class="num">비용</th><th class="num">이익</th><th v-if="showOther" class="num">그 밖의 계정</th><th class="num">줄</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in data.rows" :key="r.analytic_account_id" class="clickable" :class="{ picked: r.analytic_account_id === picked }" data-testid="analytic-row" :data-account="r.name"
              tabindex="0" @click="pick(r.analytic_account_id)" @keydown.enter="pick(r.analytic_account_id)">
            <td class="muted">{{ r.plan_name }}</td><td class="muted">{{ r.code }}</td><td>{{ r.name }}<span v-if="!r.active" class="muted small"> (보관)</span></td>
            <td class="num" data-testid="analytic-revenue">{{ fmtMoney(r.revenue) }}</td>
            <td class="num" data-testid="analytic-cost">{{ fmtMoney(r.cost) }}</td>
            <td class="num" :class="{ 'err-text': Number(r.margin) < 0 }" data-testid="analytic-margin"><strong>{{ fmtMoney(r.margin) }}</strong></td>
            <td v-if="showOther" class="num">{{ fmtMoney(r.other) }}</td>
            <td class="num muted">{{ r.lines }}</td>
          </tr>
          <tr v-if="!data.rows.length"><td :colspan="showOther ? 8 : 7" class="muted">분석 계정이 없습니다. 분석 계정을 만들고 문서 줄에 분석 분배를 적으세요.</td></tr>
        </tbody>
        <tfoot v-if="data.rows.length">
          <tr class="totals-row" data-testid="analytic-totals"><td colspan="3">합계</td><td class="num">{{ fmtMoney(data.totals.revenue) }}</td><td class="num">{{ fmtMoney(data.totals.cost) }}</td><td class="num"><strong>{{ fmtMoney(data.totals.margin) }}</strong></td><td v-if="showOther" class="num">{{ fmtMoney(data.totals.other) }}</td><td></td></tr>
        </tfoot>
      </table>
      <p v-if="data && data.plans.length > 1 && !plan" class="dim small">계획이 여럿이면 한 줄이 계획마다 한 번씩 나뉘므로, 합계는 계획을 하나 고를 때 장부의 손익과 견줄 수 있습니다.</p>

      <section v-if="lines && pickedRow" class="panel drill" data-testid="analytic-lines">
        <h2>{{ pickedRow.name }} <span class="muted small">{{ lines.rows.length }}줄 · 합계 {{ fmtMoney(lines.total) }}</span></h2>
        <table class="tbl">
          <thead><tr><th>날짜</th><th>문서</th><th>거래처</th><th>계정과목</th><th>적요</th><th class="num">비율</th><th class="num">금액</th></tr></thead>
          <tbody>
            <tr v-for="(l, i) in lines.rows" :key="i" data-testid="analytic-line">
              <td>{{ l.date }}</td>
              <td><router-link :to="docLink(l)" data-testid="analytic-line-doc">{{ l.number ?? '전표' }}</router-link></td>
              <td>{{ l.partner_name }}</td>
              <td>{{ l.account_code }} {{ l.account_name }}</td>
              <td>{{ l.name }}<span v-if="l.source === 'rule'" class="pill small" title="문서 줄에 분배가 없어 기본 분배 규칙을 따랐습니다">기본 규칙</span></td>
              <td class="num">{{ l.percent === null ? '' : `${Number(l.percent)}%` }}</td>
              <td class="num" :class="{ 'err-text': Number(l.amount) < 0 }">{{ fmtMoney(l.amount) }}</td>
            </tr>
          </tbody>
        </table>
        <p class="dim small">금액은 매출이 +, 비용이 − 입니다. 대변 메모·초안으로 되돌림·역분개는 반대 부호의 줄로 남습니다.</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.filters { gap: 6px; align-items: center; flex-wrap: wrap; }
.filters .input, .filters .select { width: auto; }
.clickable { cursor: pointer; }
.clickable:hover td { background: var(--ink-50); }
tr.picked td { background: var(--navy-50, #eef3fb); }
.totals-row td { font-weight: 650; border-top: 2px solid var(--line); }
.panel { padding: 12px 14px; margin-top: 14px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
.panel h2 { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
.pill { margin-left: 6px; }
</style>

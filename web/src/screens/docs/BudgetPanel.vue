<script setup lang="ts">
// A budget against what its accounts have actually earned and spent, the way to change a confirmed one (with a reason, kept for good),
// and every change made so far: who, when, why, and which lines moved from what to what.
import { computed, ref, watch } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { onDataChanged, sendCommand } from '../../lib/commands'
import { fmtDateTime, fmtMoney } from '../../lib/format'
import { timeView, writeBlock } from '../../lib/mode'
import { hasRole } from '../../lib/session'
import { toast } from '../../lib/ui'
import type { CatalogDoc, ErpRecord, State } from '../../lib/types'
import BudgetTable, { type BudgetRow } from '../analytic/BudgetTable.vue'

const props = defineProps<{ record: ErpRecord | null; draft: State; doc: CatalogDoc; readonly: boolean }>()

interface Report { rows: BudgetRow[]; over_lines: number; income: { planned: number; actual: number }; expense: { planned: number; actual: number } }
interface Change { kind: string; analytic_account_name: string | null; side: string; month: string | null; from: number; to: number }
interface Revision { seq: number; event: string; at: string; actor: string | null; source: string; reason: string | null; revision: number | null; changes: Change[]; total_income: number | null; total_expense: number | null; total_income_before: number | null; total_expense_before: number | null; state: string | null }

const report = ref<Report | null>(null)
const history = ref<Revision[]>([])
const error = ref('')
const editing = ref<Record<string, number | null> | null>(null)
const reason = ref('')
const busy = ref(false)
let seq = 0

const canRevise = computed(() => props.record?.status === 'confirmed' && !writeBlock.value && hasRole(['accounting']))
const changed = computed(() => !!editing.value && (props.record?.state.lines ?? []).some((l: State) => Number(editing.value![l.id] ?? 0) !== Number(l.planned ?? 0)))

async function load() {
  const id = props.record?.id
  if (!id) { report.value = null; history.value = []; return }
  const my = ++seq
  try {
    const [r, h] = await Promise.all([
      rpc<Report>('erp_budget_report', { p_budget: id, p_at: timeView.at || null }),
      rpc<Revision[]>('erp_budget_revisions', { p_budget: id }),
    ])
    if (my !== seq) return
    report.value = r
    history.value = h
    error.value = ''
  } catch (e) {
    if (my === seq) error.value = messageOf(e)
  }
}
watch(() => [props.record?.id, props.record?.version, timeView.at], load, { immediate: true })
onDataChanged(() => { void load() })

function startRevise() {
  editing.value = Object.fromEntries((props.record?.state.lines ?? []).map((l: State) => [l.id, Number(l.planned ?? 0)]))
  reason.value = ''
}
async function saveRevise() {
  if (!props.record || !editing.value) return
  busy.value = true
  try {
    const lines = (props.record.state.lines ?? []).map((l: State) => ({ ...l, planned: editing.value![l.id] ?? 0 }))
    await sendCommand({ type: 'budget', id: props.record.id, command: 'revise', payload: { lines }, reason: reason.value.trim(), expectedVersion: props.record.version })
    toast('예산을 바꿨습니다. 변경 이력에 남았습니다.')
    editing.value = null
  } catch (e) {
    toast(messageOf(e), 'error')
  } finally {
    busy.value = false
  }
}
const label = (h: Revision) => ({ BudgetConfirmed: '확정', BudgetRevised: `${h.revision}차 변경`, BudgetClosed: '마감', BudgetCancelled: '취소', BudgetResetToDraft: '초안으로', Reverted: '되돌림' } as Record<string, string>)[h.event] ?? h.event
</script>

<template>
  <section v-if="record" class="budget-panel no-print" data-testid="budget-panel">
    <h2>예산 대비 실적
      <span v-if="report" class="muted small" data-testid="budget-summary">비용 {{ fmtMoney(report.expense.actual) }} / {{ fmtMoney(report.expense.planned) }} · 매출 {{ fmtMoney(report.income.actual) }} / {{ fmtMoney(report.income.planned) }}<template v-if="report.over_lines"> · 초과 {{ report.over_lines }}줄</template></span>
    </h2>
    <p v-if="error" class="err-text small" role="alert">{{ error }}</p>
    <p v-if="record.status === 'draft'" class="muted small">초안입니다. 확정하기 전에도 지금까지의 실적과 견줘 볼 수 있습니다. 확정한 뒤에는 사유를 적어야 고칠 수 있습니다.</p>
    <BudgetTable v-if="report" :rows="report.rows" :edit="editing" @planned="(id, v) => { if (editing) editing[id] = v }" />
    <div v-if="canRevise" class="revise">
      <button v-if="!editing" type="button" class="btn btn-sm" data-testid="budget-revise" @click="startRevise">예산 변경</button>
      <template v-else>
        <label class="field-label" for="budget-reason">변경 사유 <span class="req">*</span></label>
        <textarea id="budget-reason" v-model="reason" class="textarea" rows="2" data-testid="budget-reason" placeholder="왜 바꾸는지 적습니다. 누가 언제 바꿨는지와 함께 이력에 남습니다." />
        <div class="row" style="gap: 6px; margin-top: 6px">
          <button type="button" class="btn btn-primary btn-sm" :disabled="busy || !changed || !reason.trim()" data-testid="budget-revise-save" @click="saveRevise">변경 저장</button>
          <button type="button" class="btn btn-sm btn-ghost" @click="editing = null">그만두기</button>
        </div>
      </template>
    </div>
    <h3 class="hist-title">변경 이력</h3>
    <ol v-if="history.length" class="history" data-testid="budget-history">
      <li v-for="h in history" :key="h.seq" data-testid="budget-history-item" :data-event="h.event">
        <div><strong>{{ label(h) }}</strong> <span class="muted small">{{ fmtDateTime(h.at) }} · {{ h.actor ?? '시스템' }}<template v-if="h.source === 'mcp'"> · 에이전트</template></span></div>
        <div v-if="h.reason" class="small" data-testid="budget-history-reason">사유: {{ h.reason }}</div>
        <ul v-if="h.changes.length" class="small changes">
          <li v-for="(c, i) in h.changes" :key="i">{{ c.analytic_account_name }} {{ c.side === 'income' ? '매출' : '비용' }}<template v-if="c.month"> {{ c.month }}</template>:
            {{ c.kind === 'added' ? '추가' : c.kind === 'removed' ? '삭제' : '' }} {{ fmtMoney(c.from) }} → {{ fmtMoney(c.to) }}</li>
        </ul>
        <div v-if="h.event === 'BudgetRevised'" class="small muted">비용 계획 {{ fmtMoney(h.total_expense_before) }} → {{ fmtMoney(h.total_expense) }}, 매출 계획 {{ fmtMoney(h.total_income_before) }} → {{ fmtMoney(h.total_income) }}</div>
      </li>
    </ol>
    <p v-else class="muted small">아직 확정하지 않았습니다.</p>
  </section>
</template>

<style scoped>
.budget-panel { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line); }
.budget-panel h2 { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; font-size: 13px; }
.revise { margin-top: 10px; max-width: 560px; }
.hist-title { margin: 14px 0 6px; font-size: 13px; }
.history { margin: 0; padding-left: 18px; }
.history > li { margin-bottom: 8px; }
.changes { margin: 2px 0; padding-left: 16px; }
</style>

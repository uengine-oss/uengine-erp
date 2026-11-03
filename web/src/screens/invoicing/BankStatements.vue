<script setup lang="ts">
// What the bank says. A statement is saved whatever it says; the problems are for a person to look at.
import { computed, ref, watch } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { sendCommand } from '../../lib/commands'
import { fmtMoney, fmtDay } from '../../lib/format'
import { useLoad } from '../../lib/load'
import { writeBlock } from '../../lib/mode'
import type { Field, State } from '../../lib/types'
import { ask, toast } from '../../lib/ui'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'
import LoadError from '../../components/LoadError.vue'

interface Statement { id: string; name: string; date: string | null; balance_start: number; balance_end: number; balance_end_real: number | null; lines: number; first_date: string | null; last_date: string | null; is_complete: boolean; is_valid: boolean; problems: string[] }

const props = defineProps<{ journal: string }>()
defineEmits<{ next: [] }>()
const { data, loading, error, load } = useLoad(() => rpc<Statement[]>('erp_bank_statements', { p_journal_id: props.journal }))
watch(() => props.journal, load, { immediate: true })
const list = computed(() => data.value ?? [])
const canWrite = computed(() => !writeBlock.value)

async function asking(title: string, fields: Field[], values: State, send: (v: State) => Promise<unknown>, done: string) {
  let err = ''
  let current = values
  for (;;) {
    const answer = await ask({ title, error: err, fields, values: current, confirmLabel: '저장' })
    if (!answer) return
    current = answer.values
    try {
      await send(current)
      toast(done)
      await load()
      return
    } catch (e) {
      err = messageOf(e)
    }
  }
}
const today = () => fmtDay(new Date().toISOString())
function newStatement() {
  void asking('새 명세서', [
    { name: 'name', label: '이름', type: 'text', required: true },
    { name: 'date', label: '명세서 일자', type: 'date' },
    { name: 'balance_start', label: '시작 잔액', type: 'money', help: '비우면 앞 명세서의 종료 잔액입니다' },
    { name: 'balance_end_real', label: '종료 잔액', type: 'money', help: '은행이 말한 금액. 거래를 더한 값과 다르면 알려 줍니다' },
  ], { date: today() }, (v) => sendCommand({ type: 'bank_statement', command: 'create', payload: { ...v, journal_id: props.journal } }), '명세서를 만들었습니다.')
}
function newLine(statementId?: string) {
  void asking('거래 입력', [
    { name: 'date', label: '거래일', type: 'date', required: true },
    { name: 'amount', label: '금액', type: 'money', required: true, help: '들어온 돈은 양수, 나간 돈은 음수' },
    { name: 'payment_ref', label: '적요', type: 'text' },
    { name: 'partner_id', label: '거래처', type: 'ref', ref: 'partner' },
  ], { date: today() }, (v) => sendCommand({ type: 'bank_line', command: 'create', payload: { ...v, journal_id: props.journal, statement_id: statementId } }), '거래를 넣었습니다.')
}
async function assignLoose(s: Statement) {
  try {
    const lines = await rpc<{ id: string; statement_id: string | null }[]>('erp_bank_lines', { p_journal_id: props.journal, p_limit: 2000 })
    const loose = lines.filter((l) => !l.statement_id).map((l) => l.id)
    if (!loose.length) { toast('묶이지 않은 거래가 없습니다.'); return }
    await sendCommand({ type: 'bank_statement', id: s.id, command: 'assign', payload: { line_ids: loose } })
    toast(`거래 ${loose.length}건을 묶었습니다.`)
    await load()
  } catch (e) {
    toast(messageOf(e), 'error')
  }
}
</script>

<template>
  <div class="report-pad" data-testid="bank-statements">
    <div class="row-wrap" style="margin-bottom: 8px">
      <button v-if="canWrite" type="button" class="btn btn-primary" data-testid="bank-new-statement" @click="newStatement"><Icon name="plus" :size="13" />새 명세서</button>
      <button v-if="canWrite" type="button" class="btn" data-testid="bank-new-line" @click="newLine()">거래 입력</button>
      <router-link v-if="canWrite" class="btn" :to="{ name: 'import', query: { type: 'bank_line', journal_id: journal } }" data-testid="bank-import">파일에서 가져오기</router-link>
      <div class="grow"></div>
      <button type="button" class="btn" data-testid="bank-to-match" @click="$emit('next')">맞춰 보기로<Icon name="chevron-right" :size="12" /></button>
    </div>
    <LoadError :message="error" @retry="load" />
    <div class="scroll-x">
      <table v-if="list.length" class="tbl" data-testid="bank-statement-table">
        <thead><tr><th>이름</th><th>기간</th><th class="num">거래</th><th class="num">시작 잔액</th><th class="num">거래 합산 잔액</th><th class="num">입력한 종료 잔액</th><th>확인할 것</th><th v-if="canWrite"></th></tr></thead>
        <tbody>
          <tr v-for="s in list" :key="s.id" data-testid="bank-statement" :data-name="s.name">
            <td><router-link :to="{ name: 'record', params: { type: 'bank_statement', id: s.id } }">{{ s.name }}</router-link></td>
            <td>{{ s.first_date }}<template v-if="s.last_date && s.last_date !== s.first_date"> ~ {{ s.last_date }}</template></td>
            <td class="num">{{ s.lines }}</td><td class="num">{{ fmtMoney(s.balance_start) }}</td><td class="num" data-testid="statement-end">{{ fmtMoney(s.balance_end) }}</td><td class="num">{{ fmtMoney(s.balance_end_real) }}</td>
            <td class="wrap"><span v-if="!s.problems.length" class="pill pill-green" data-testid="statement-ok">맞음</span><span v-for="p in s.problems" :key="p" class="err-text small" style="display: block" data-testid="statement-problem">{{ p }}</span></td>
            <td v-if="canWrite" class="num"><button type="button" class="btn btn-sm" data-testid="statement-add-line" @click="newLine(s.id)">거래 입력</button> <button type="button" class="btn btn-sm btn-ghost" data-testid="statement-assign" @click="assignLoose(s)">안 묶인 거래 묶기</button></td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-else-if="!loading && !error" title="아직 명세서가 없습니다" text="은행에서 받은 내역을 입력하거나 CSV 파일로 가져오세요. 외부 은행에는 연결하지 않습니다." />
    </div>
  </div>
</template>

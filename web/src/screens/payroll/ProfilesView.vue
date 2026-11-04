<script setup lang="ts">
// What each person's register starts from: account, family, the amount of each item. Outside the ledger, so it can be erased, which is why it says what it keeps and what it does not.
import { computed, onMounted, ref } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { nudgeBus, onDataChanged, sendCommand } from '../../lib/commands'
import { db } from '../../lib/conn'
import { fmtMoney } from '../../lib/format'
import { rows as readRows } from '../../lib/load'
import { writeBlock } from '../../lib/mode'
import { catalogOf } from '../../lib/session'
import type { Field, State } from '../../lib/types'
import { ask, toast } from '../../lib/ui'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'
import LoadError from '../../components/LoadError.vue'

interface Person extends State { employee_id: string; name: string; employee_no: string; profile: State | null }
const people = ref<Person[]>([])
const items = ref<{ id: string; name: string; state: State }[]>([])
const loading = ref(true)
const error = ref('')
const canWrite = computed(() => !writeBlock.value)
const privateFields = computed<Field[]>(() => catalogOf('payroll_profile')?.private_fields ?? [])

async function load() {
  error.value = ''
  try {
    const [list, types] = await Promise.all([
      rpc<Person[]>('erp_payroll_roster'),
      readRows<{ id: string; name: string; state: State }>(db().from('erp_records').select('id,name,state').eq('type', 'pay_item').eq('active', true).order('name')),
    ])
    people.value = list
    items.value = types
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    loading.value = false
  }
}
// Someone hired a moment ago may still be on their way here. Asking the bus now shows them without waiting for cron.
onMounted(() => { void load(); nudgeBus() })
onDataChanged(load)

const payTotal = (p: Person) => Object.entries((p.profile?.pay ?? {}) as Record<string, number>).reduce((a, [id, v]) => (items.value.find((i) => i.id === id)?.state.kind === 'earning' ? a + Number(v) : a), 0)

async function edit(p: Person) {
  if (!canWrite.value) return
  const itemFields: Field[] = items.value.map((i) => ({ name: `pay:${i.id}`, label: `${i.name}${i.state.calc === 'overtime_hours' ? ' 시간당 단가' : ''}`, type: 'money' }))
  const values: State = { ...(p.profile ?? {}) }
  if (values.tax_ratio !== null && values.tax_ratio !== undefined) values.tax_ratio = String(values.tax_ratio)
  for (const i of items.value) values[`pay:${i.id}`] = p.profile?.pay?.[i.id] ?? null
  const answer = await ask({
    title: `${p.name} 급여 정보`,
    message: '이 칸들은 원장 밖에 따로 저장합니다. 이력에는 어느 칸이 바뀌었는지와 처리한 사람만 남고 값은 남지 않습니다. 주민등록번호는 받지 않으니 어느 칸에도 적지 마세요.',
    fields: [...privateFields.value, ...itemFields], values, confirmLabel: '저장', wide: true,
  })
  if (!answer) return
  const payload: State = { employee_id: p.employee_id, pay: {} }
  for (const f of privateFields.value) {
    const v = answer.values[f.name]
    const before = values[f.name] ?? null
    if ((v ?? null) !== before && (v ?? '') !== (before ?? '')) payload[f.name] = v === '' ? null : v
  }
  for (const i of items.value) {
    const v = answer.values[`pay:${i.id}`]
    const before = p.profile?.pay?.[i.id] ?? null
    if ((v === '' ? null : v ?? null) !== before) payload.pay[i.id] = v === '' ? null : v ?? null
  }
  if (!Object.keys(payload.pay).length) delete payload.pay
  if (Object.keys(payload).length === 1) return
  try {
    await sendCommand({ type: 'payroll_profile', command: 'set', payload })
    toast('급여 정보를 저장했습니다.')
    await load()
  } catch (e) {
    error.value = messageOf(e)
  }
}

async function erase(p: Person) {
  const answer = await ask({
    title: '급여 정보 지우기',
    message: '이 직원의 계좌, 가족 수, 항목별 금액을 모두 지웁니다. 되돌릴 수 없습니다. 이미 만든 명세서는 대장에 남습니다.\n사유도 원장에 남으니 지우는 값이나 금액을 적지 마세요.',
    danger: true, reason: true, reasonRequired: true, confirmLabel: '지우기', cancelLabel: '닫기',
  })
  if (!answer) return
  try {
    await sendCommand({ type: 'payroll_profile', command: 'erase', payload: { employee_id: p.employee_id }, reason: answer.reason })
    toast('급여 정보를 지웠습니다.')
    await load()
  } catch (e) {
    error.value = messageOf(e)
  }
}
</script>

<template>
  <div class="page" data-testid="payroll-profiles">
    <div class="page-head"><h1>직원 급여 정보</h1></div>
    <p class="banner banner-info banner-flush small" data-testid="profiles-note"><Icon name="lock" /><span>인사·급여 담당자와 관리자만 봅니다. 값은 원장에 남지 않습니다. 직원은 인사에서 등록하면 여기에 나타납니다.</span></p>
    <LoadError v-if="error" :message="error" @retry="load" />
    <div class="page-body page-pad">
      <EmptyState v-if="!loading && !error && !people.length" title="직원이 없습니다" text="인사에서 직원을 등록하세요." />
      <div v-else class="scroll-x">
        <table class="tbl">
          <thead><tr><th>사번</th><th>이름</th><th>부서</th><th>입사일</th><th>퇴사일</th><th class="num">가족</th><th class="num">자녀</th><th class="num">비율</th><th>구분</th><th>계좌</th><th class="num">지급 항목 합계</th><th></th></tr></thead>
          <tbody>
            <tr v-for="p in people" :key="p.employee_id" data-testid="profile-row" :data-name="p.name">
              <td>{{ p.employee_no }}</td><td>{{ p.name }}</td><td>{{ p.department_name }}</td><td>{{ p.hire_date }}</td><td>{{ p.leave_date }}</td>
              <td class="num">{{ p.profile?.family_count ?? 1 }}</td><td class="num">{{ p.profile?.child_count ?? 0 }}</td><td class="num">{{ p.profile?.tax_ratio ?? 100 }}%</td><td>{{ p.profile?.income_code ?? 'A01' }}</td>
              <td data-testid="profile-account">{{ p.profile?.bank_account ? '있음' : '없음' }}</td>
              <td class="num" data-testid="profile-total">{{ fmtMoney(payTotal(p)) }}</td>
              <td class="row-actions">
                <button type="button" class="btn btn-sm" :disabled="!canWrite" data-testid="profile-edit" @click="edit(p)">고치기</button>
                <button v-if="p.profile" type="button" class="btn btn-sm" :disabled="!canWrite" data-testid="profile-erase" @click="erase(p)">지우기</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.row-actions { white-space: nowrap; }
.row-actions .btn + .btn { margin-left: 4px; }
</style>

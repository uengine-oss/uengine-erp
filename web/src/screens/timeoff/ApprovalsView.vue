<script setup lang="ts">
// What waits for this person to decide. A boss sees their reports' requests with the reason beside them; people staff see the
// ones with no boss to go to. Requests are closed at the type level, so this comes from erp_leave_inbox, which picks the rows.
import { onMounted, ref } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { onDataChanged, sendCommand } from '../../lib/commands'
import { writeBlock } from '../../lib/mode'
import { ask, toast } from '../../lib/ui'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'
import { HALF_LABEL, dateRange, fmtDays } from './fmt'

interface Row { id: string; number: string; employee_name: string; department_name: string; leave_type_name: string; date_from: string; date_to: string; half_day: string | null; days: number; shortfall: number; route: 'manager' | 'hr'; reason: string | null; balances: { remaining: number; name: string; tracks_balance: boolean }[] }

const rows = ref<Row[] | null>(null)
const error = ref('')
const busyId = ref('')

async function load() {
  error.value = ''
  try {
    rows.value = await rpc<Row[]>('erp_leave_inbox')
  } catch (e) {
    error.value = messageOf(e)
  }
}
onMounted(load)
onDataChanged(load)

async function approve(r: Row) {
  busyId.value = r.id
  error.value = ''
  try {
    await sendCommand({ type: 'leave_request', id: r.id, command: 'approve', payload: {} })
    toast(`${r.employee_name}의 신청을 승인했습니다.`)
    await load()
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busyId.value = ''
  }
}

async function reject(r: Row) {
  const answer = await ask({
    title: '휴가 반려',
    message: '반려 사유는 원장 밖에 저장합니다. 신청자, 상사, 인사 담당자만 봅니다.',
    fields: [{ name: 'reject_reason', label: '반려 사유', type: 'text', required: true }],
    confirmLabel: '반려',
  })
  if (!answer) return
  busyId.value = r.id
  error.value = ''
  try {
    await sendCommand({ type: 'leave_request', id: r.id, command: 'reject', payload: { reject_reason: answer.values.reject_reason } })
    toast(`${r.employee_name}의 신청을 반려했습니다.`)
    await load()
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busyId.value = ''
  }
}
</script>

<template>
  <div class="page" data-testid="approvals">
    <div class="page-head"><h1>승인함<span v-if="rows?.length" class="page-count">{{ rows.length }}건</span></h1></div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert" data-testid="approvals-error"><Icon name="alert" /><span class="grow">{{ error }}</span></div>
    <div class="page-body page-pad">
      <p class="small dim">승인자는 상사입니다. 상사가 없거나 퇴사했거나 ERP 계정이 없으면 인사 담당자에게 옵니다. 자기 신청은 직접 결정할 수 없습니다.</p>
      <table v-if="rows?.length" class="tbl" data-testid="approvals-table">
        <thead><tr><th>번호</th><th>직원</th><th>유형</th><th>날짜</th><th class="num">일수</th><th class="num">남은 일수</th><th>사유</th><th>경로</th><th></th></tr></thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id" data-testid="approval-row" :data-number="r.number">
            <td>{{ r.number }}</td>
            <td>{{ r.employee_name }} <span class="muted small">{{ r.department_name }}</span></td>
            <td>{{ r.leave_type_name }}<span v-if="r.half_day" class="muted small"> {{ HALF_LABEL[r.half_day] }}</span></td>
            <td>{{ dateRange(r.date_from, r.date_to) }}</td>
            <td class="num">{{ fmtDays(r.days) }}</td>
            <td class="num"><template v-if="r.balances[0]?.tracks_balance">{{ fmtDays(r.balances[0].remaining) }}</template></td>
            <td class="small" data-testid="approval-reason">{{ r.reason }}</td>
            <td class="small" data-testid="approval-route">{{ r.route === 'manager' ? '상사' : '인사 담당자' }}</td>
            <td class="acts">
              <button type="button" class="btn btn-primary btn-sm" :disabled="!!writeBlock || busyId === r.id" data-testid="approval-approve" @click="approve(r)">승인</button>
              <button type="button" class="btn btn-sm" :disabled="!!writeBlock || busyId === r.id" data-testid="approval-reject" @click="reject(r)">반려</button>
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-else-if="rows" title="기다리는 신청이 없습니다" text="부하 직원이 휴가를 신청하면 여기에 나타납니다." />
    </div>
  </div>
</template>

<style scoped>
.acts { white-space: nowrap; text-align: right; }
.acts .btn + .btn { margin-left: 4px; }
</style>

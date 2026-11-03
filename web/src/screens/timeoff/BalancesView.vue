<script setup lang="ts">
// Everyone's days, for those who run people: what is left, what could not be checked, whose Article 61 dates are coming, and
// what a fiscal-year company still owes someone who has left.
import { computed, onMounted, ref, watch } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { onDataChanged, sendCommand } from '../../lib/commands'
import { writeBlock } from '../../lib/mode'
import { toast } from '../../lib/ui'
import Icon from '../../components/Icon.vue'
import LawNotice from '../docs/LawNotice.vue'
import { fmtDays } from './fmt'

interface Person {
  employee_id: string; employee_no: string; name: string; department_name: string; hire_date: string; leave_date: string | null; state: string; auto_grant: boolean; unverified: number; flags: string[]
  balances: { name: string; tracks_balance: boolean; granted: number; used: number; pending: number; remaining: number; expires: string | null }[]
  promotion: { article: string; notice_from: string; notice_to: string; designate_by: string; valid_to: string } | null
  settlement: { hire_basis_total: number; fiscal_total: number; gap: number } | null
}
interface Data { on: string; statutory: boolean; basis: string; people: Person[] }

const on = ref(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date()))
const data = ref<Data | null>(null)
const error = ref('')
const busy = ref(false)

const annual = (p: Person) => p.balances.find((b) => b.tracks_balance)
const anyUnverified = computed(() => (data.value?.people ?? []).some((p) => p.unverified > 0))

async function load() {
  error.value = ''
  try {
    data.value = await rpc<Data>('erp_leave_balances', { p_on: on.value, p_department: null })
  } catch (e) {
    error.value = messageOf(e)
  }
}
onMounted(load)
onDataChanged(load)
watch(on, load)

async function accrue() {
  busy.value = true
  try {
    await sendCommand({ type: 'leave_policy', command: 'accrue', payload: {} })
    toast('오늘까지의 부여를 계산했습니다.')
    await load()
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page" data-testid="leave-balances">
    <div class="page-head"><h1>잔여 현황</h1></div>
    <div class="toolbar">
      <label class="small dim" for="balances-on">기준일</label>
      <input id="balances-on" v-model="on" class="input" type="date" style="width: 140px" data-testid="balances-on" />
      <button type="button" class="btn btn-sm" :disabled="busy || !!writeBlock" data-testid="balances-accrue" @click="accrue">오늘까지 부여 계산</button>
      <router-link class="small" :to="{ name: 'timeoff-outlook' }" data-testid="balances-outlook">소진 전망</router-link>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert"><Icon name="alert" /><span class="grow">{{ error }}</span></div>
    <div class="page-body page-pad">
      <LawNotice kind="leave" />
      <p v-if="data?.statutory === false" class="small dim" data-testid="balances-off">회사가 제60조 적용을 껐습니다. 자동 부여가 멈춰 있습니다.</p>
      <p v-if="anyUnverified" class="small dim" data-testid="balances-unverified">출근율을 확인하지 못한 사람이 있습니다. 마감된 근태가 없으면 80% 판정을 할 수 없어 법이 정한 일수를 그대로 부여하고 그렇다고 표시합니다.</p>
      <table v-if="data?.people.length" class="tbl" data-testid="balances-table">
        <thead><tr><th>사번</th><th>이름</th><th>부서</th><th>입사일</th><th class="num">부여</th><th class="num">사용</th><th class="num">대기</th><th class="num">남음</th><th>소멸일</th><th>제61조 촉구</th><th>확인</th></tr></thead>
        <tbody>
          <tr v-for="p in data.people" :key="p.employee_id" data-testid="balance-row" :data-name="p.name">
            <td>{{ p.employee_no }}</td><td>{{ p.name }}<span v-if="p.state === 'left'" class="muted small"> 퇴사 {{ p.leave_date }}</span></td><td>{{ p.department_name }}</td><td>{{ p.hire_date }}</td>
            <td class="num">{{ fmtDays(annual(p)?.granted) }}</td><td class="num">{{ fmtDays(annual(p)?.used) }}</td><td class="num">{{ fmtDays(annual(p)?.pending) }}</td>
            <td class="num" data-testid="balance-row-remaining">{{ fmtDays(annual(p)?.remaining) }}</td><td>{{ annual(p)?.expires }}</td>
            <td class="small"><template v-if="p.promotion">{{ p.promotion.notice_from }} ~ {{ p.promotion.notice_to }}<div class="muted">지정 통보 {{ p.promotion.designate_by }}까지</div></template></td>
            <td class="small">
              <div v-if="p.unverified" data-testid="balance-row-unverified">출근율 미확인 {{ p.unverified }}건</div>
              <div v-if="!p.auto_grant">자동 부여 끔</div>
              <div v-for="f in p.flags" :key="f" class="err-text">{{ f }}</div>
              <div v-if="p.settlement && p.settlement.gap > 0" class="err-text" data-testid="balance-row-settlement">입사일 기준보다 {{ fmtDays(p.settlement.gap) }} 적습니다. 정산이 필요합니다</div>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else-if="data" class="muted">이 날 재직 중인 직원이 없습니다.</p>
    </div>
  </div>
</template>

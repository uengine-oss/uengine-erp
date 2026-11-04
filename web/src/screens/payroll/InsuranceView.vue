<script setup lang="ts">
// Who joined and left, for the agencies' acquisition and loss reports. Nothing is sent. A registration number is never held here, so the file has an empty column for it.
import { onMounted, ref, watch } from 'vue'
import { rpc } from '../../lib/api'
import { nudgeBus, onDataChanged } from '../../lib/commands'
import { fmtDay, fmtMoney } from '../../lib/format'
import { thisMonth, useLoad } from '../../lib/load'
import type { State } from '../../lib/types'
import { csvBlob, saveBlob } from '../../lib/ui'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'
import LoadError from '../../components/LoadError.vue'

const month = thisMonth(fmtDay(new Date().toISOString()))
const from = ref(month.from)
const to = ref(month.to)
const list = useLoad(() => rpc<State[]>('erp_insurance_list', { p_from: from.value, p_to: to.value }))
watch([from, to], () => { if (from.value && to.value) void list.load() }, { immediate: true })
// This list hears people through events. A departure recorded a moment ago may still be on its way, so ask for it now.
onMounted(nudgeBus)
onDataChanged(() => { void list.load() })

function exportCsv() {
  const rows = (list.data.value ?? []).map((r) => [
    { value: r.label, numeric: false }, { value: r.name, numeric: false }, { value: '', numeric: false }, { value: r.date, numeric: false },
    { value: r.monthly_pay, numeric: true }, { value: r.employee_no, numeric: false }, { value: r.department_name, numeric: false }, { value: r.job_title, numeric: false },
  ])
  saveBlob(csvBlob(['구분', '성명', '주민등록번호(직접 채움)', '자격 취득일·상실일', '월 소득액', '사번', '부서', '직책'], rows), `4대보험_${from.value}_${to.value}.csv`)
}
</script>

<template>
  <div class="page" data-testid="insurance">
    <div class="page-head"><h1>4대보험 자료</h1></div>
    <p class="banner banner-warn banner-flush small" data-testid="insurance-note"><Icon name="alert" /><span>전문가 검수 전입니다. <strong>전송하지 않습니다.</strong> 내보낸 파일로 회사가 4대사회보험 정보연계센터에 신고합니다. 주민등록번호는 앱이 받지 않으므로 파일에서 직접 채우세요. 상실일은 퇴직일의 다음 날입니다.</span></p>
    <div class="toolbar">
      <label class="small dim" for="ins-from">기간</label>
      <input id="ins-from" v-model="from" class="input" type="date" style="width: 150px" data-testid="insurance-from" />
      <input v-model="to" class="input" type="date" style="width: 150px" aria-label="끝" data-testid="insurance-to" />
      <button type="button" class="btn" :disabled="!list.data.value?.length" data-testid="insurance-export" @click="exportCsv"><Icon name="download" :size="13" /> 파일 내려받기</button>
    </div>
    <LoadError v-if="list.error.value" :message="list.error.value" @retry="list.load" />
    <div class="page-body page-pad">
      <EmptyState v-if="list.data.value && !list.data.value.length" title="이 기간에 입사와 퇴사가 없습니다" text="인사에서 입사나 퇴사를 기록하면 여기에 나타납니다." />
      <table v-else-if="list.data.value" class="tbl" data-testid="insurance-list">
        <thead><tr><th>구분</th><th>성명</th><th>취득일·상실일</th><th>입사일</th><th>퇴사일</th><th class="num">월 소득액</th><th>사번</th><th>부서</th></tr></thead>
        <tbody>
          <tr v-for="r in list.data.value" :key="r.kind + r.employee_id" data-testid="insurance-row" :data-kind="r.kind" :data-name="r.name">
            <td>{{ r.label }}</td><td>{{ r.name }}</td><td data-col="date">{{ r.date }}</td><td>{{ r.hire_date }}</td><td>{{ r.leave_date }}</td><td class="num">{{ fmtMoney(r.monthly_pay) }}</td><td>{{ r.employee_no }}</td><td>{{ r.department_name }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

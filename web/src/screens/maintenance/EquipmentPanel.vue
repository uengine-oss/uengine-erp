<script setup lang="ts">
// Under a machine's form: how it has been doing, read from the ledger when the form opens, and the requests made for it, newest first.
// Reporting a breakdown starts here, so the person is not sent looking for the machine again in another list.
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { messageOf, rpc } from '../../lib/api'
import { onDataChanged, sendCommand } from '../../lib/commands'
import { db } from '../../lib/conn'
import { fmtDate, fmtDateTime, fmtNumber } from '../../lib/format'
import { timeView, writeBlock } from '../../lib/mode'
import { catalogOf, hasRole } from '../../lib/session'
import type { CatalogDoc, ErpRecord, State } from '../../lib/types'
import StatusPill from '../../components/StatusPill.vue'

interface Machine { failures: number; repairs: number; open: number; mtbf_hours: number | null; mttr_hours: number | null; availability: number | null; next_failure_at: string | null; ready: boolean; down_now: boolean; downtime_hours: number }

const props = defineProps<{ record: ErpRecord | null; draft: State; doc: CatalogDoc; readonly: boolean }>()
const router = useRouter()
const stats = ref<Machine | null>(null)
const need = ref(3)
const requests = ref<ErpRecord[]>([])
const error = ref('')
const reqDoc = computed<CatalogDoc | undefined>(() => catalogOf('maintenance_request'))
const canReport = computed(() => !writeBlock.value && hasRole(['maintenance']) && props.record?.status === 'active')
const hours = (v: number | null | undefined) => (v === null || v === undefined ? '-' : `${fmtNumber(v)}시간`)
const KIND: Record<string, string> = { corrective: '고장 수리', preventive: '예방 점검' }

let seq = 0
async function load() {
  const id = props.record?.id
  if (!id) return
  const my = ++seq
  error.value = ''
  try {
    const [r, list] = await Promise.all([
      rpc<{ need: number; equipment: Machine[] }>('erp_maintenance_reliability', { p_equipment_id: id, p_as_of: timeView.at || null }),
      db().from('erp_records').select('id,type,name,status,version,state,created_at').eq('type', 'maintenance_request').eq('state->>equipment_id', id).order('created_at', { ascending: false }).limit(20),
    ])
    if (my !== seq) return
    stats.value = r.equipment[0] ?? null
    need.value = r.need
    requests.value = (list.data ?? []) as ErpRecord[]
  } catch (e) {
    if (my === seq) error.value = messageOf(e)
  }
}
watch(() => [props.record?.id, props.record?.version], load, { immediate: true })
onDataChanged(() => { void load() })

async function report() {
  if (!props.record) return
  try {
    const res = await sendCommand<{ id: string }>({ type: 'maintenance_request', command: 'create', payload: { name: `${props.record.state.name} 고장`, equipment_id: props.record.id, kind: 'corrective', priority: 'high' } })
    await router.push({ name: 'record', params: { type: 'maintenance_request', id: res.id } })
  } catch (e) {
    error.value = messageOf(e)
  }
}
</script>

<template>
  <section v-if="record" class="machine no-print" data-testid="equipment-panel">
    <h2>이 설비의 보전 기록 <button v-if="canReport" type="button" class="btn btn-sm" data-testid="equipment-report" @click="report">고장 신고</button></h2>
    <p v-if="error" class="err-text small" role="alert">{{ error }}</p>
    <div v-if="stats" class="figures" data-testid="equipment-stats">
      <div><span class="muted small">고장</span><strong data-testid="equipment-failures">{{ stats.failures }}번</strong></div>
      <div><span class="muted small">고장 간격(MTBF)</span><strong data-testid="equipment-mtbf">{{ hours(stats.mtbf_hours) }}</strong></div>
      <div><span class="muted small">수리 시간(MTTR)</span><strong data-testid="equipment-mttr">{{ hours(stats.mttr_hours) }}</strong></div>
      <div><span class="muted small">멈춘 시간</span><strong>{{ hours(stats.downtime_hours) }}</strong></div>
      <div><span class="muted small">다음 고장 예상</span>
        <strong data-testid="equipment-next">{{ stats.next_failure_at ? fmtDateTime(stats.next_failure_at).slice(0, 10) : stats.down_now ? '수리 중' : `고장 ${need}번부터` }}</strong></div>
    </div>
    <table v-if="requests.length && reqDoc" class="tbl" data-testid="equipment-requests">
      <thead><tr><th>번호</th><th>제목</th><th>유형</th><th>예정일</th><th class="num">정지 시간</th><th>단계</th></tr></thead>
      <tbody>
        <tr v-for="r in requests" :key="r.id" data-testid="equipment-request">
          <td><router-link :to="{ name: 'record', params: { type: 'maintenance_request', id: r.id } }">{{ r.state.number }}</router-link></td>
          <td>{{ r.state.name }}</td><td>{{ KIND[r.state.kind] ?? r.state.kind }}</td><td>{{ fmtDate(r.state.scheduled_date) }}</td>
          <td class="num">{{ r.state.downtime_hours === undefined || r.state.downtime_hours === null ? '' : hours(r.state.downtime_hours) }}</td>
          <td><StatusPill :doc="reqDoc" :value="r.status" /></td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.machine { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line); }
.machine h2 { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 13px; }
.figures { display: flex; flex-wrap: wrap; gap: 18px; margin-bottom: 10px; }
.figures div { display: flex; flex-direction: column; gap: 2px; }
.figures strong { font-size: 16px; font-weight: 650; font-variant-numeric: tabular-nums; }
</style>

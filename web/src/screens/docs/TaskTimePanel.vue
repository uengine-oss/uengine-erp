<script setup lang="ts">
// Hours on this task, and a quick way to add your own. An hour is its own record, never part of the task: see sql/67f_project.sql.
import { computed, ref, watch } from 'vue'
import { messageOf, toApiError } from '../../lib/api'
import { onDataChanged, sendCommand } from '../../lib/commands'
import { db } from '../../lib/conn'
import { fmtDay, fmtNumber } from '../../lib/format'
import { writeBlock } from '../../lib/mode'
import type { CatalogDoc, ErpRecord, State } from '../../lib/types'
import { toast } from '../../lib/ui'

const props = defineProps<{ record: ErpRecord | null; draft: State; doc: CatalogDoc; readonly: boolean }>()

const rows = ref<ErpRecord[]>([])
const day = ref(fmtDay(new Date().toISOString()))
const hours = ref('')
const note = ref('')
const busy = ref(false)
const error = ref('')
const total = computed(() => rows.value.reduce((n, r) => n + Number(r.state.hours ?? 0), 0))
const planned = computed(() => Number(props.record?.state.planned_hours ?? 0))
const canLog = computed(() => !writeBlock.value && props.record?.status !== 'cancelled')

let seq = 0
async function load() {
  const id = props.record?.id
  if (!id) { rows.value = []; return }
  const my = ++seq
  const { data, error: err, status } = await db().from('erp_records').select('id,type,name,status,version,state').eq('type', 'time_entry').eq('state->>task_id', id).order('created_at', { ascending: false })
  if (my !== seq) return
  if (err) { error.value = messageOf(toApiError(err, status)); return }
  rows.value = (data ?? []) as ErpRecord[]
}
watch(() => [props.record?.id, props.record?.version], load, { immediate: true })
onDataChanged(() => { void load() })

async function add() {
  if (!props.record || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await sendCommand({ type: 'time_entry', command: 'create', payload: { task_id: props.record.id, date: day.value || null, hours: hours.value === '' ? null : Number(hours.value), note: note.value || null } })
    hours.value = ''
    note.value = ''
    toast('시간을 기록했습니다.')
    await load()
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section v-if="record" class="time no-print" data-testid="task-time">
    <h2>시간 기록 <span class="muted small" data-testid="task-time-total">기록 {{ fmtNumber(total) }}시간<template v-if="planned"> / 계획 {{ fmtNumber(planned) }}시간</template></span></h2>
    <p v-if="error" class="err-text small" role="alert" data-testid="task-time-error">{{ error }}</p>
    <form v-if="canLog" class="add" @submit.prevent="add">
      <input v-model="day" class="input" type="date" aria-label="날짜" data-testid="task-time-date" />
      <input v-model="hours" class="input hours" inputmode="decimal" placeholder="시간" aria-label="시간" data-testid="task-time-hours" />
      <input v-model="note" class="input grow" placeholder="메모" aria-label="메모" data-testid="task-time-note" />
      <button type="submit" class="btn" :disabled="busy" data-testid="task-time-add">기록</button>
    </form>
    <table v-if="rows.length" class="tbl" data-testid="task-time-table">
      <thead><tr><th>날짜</th><th>사람</th><th class="num">시간</th><th>메모</th></tr></thead>
      <tbody>
        <tr v-for="r in rows" :key="r.id" data-testid="task-time-row"><td><router-link :to="{ name: 'record', params: { type: 'time_entry', id: r.id } }">{{ r.state.date }}</router-link></td><td>{{ r.state.person_name }}</td><td class="num">{{ fmtNumber(r.state.hours) }}</td><td>{{ r.state.note }}</td></tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.time { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line); max-width: 760px; }
.time h2 { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; font-size: 13px; }
.add { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.add input[type='date'] { width: 140px; }
.hours { width: 72px; }
.grow { flex: 1 1 160px; }
</style>

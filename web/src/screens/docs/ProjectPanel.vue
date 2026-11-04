<script setup lang="ts">
// A project's tasks and what has gone into them. Asks the database, because the hours live on their own records.
import { computed, ref, watch } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { onDataChanged } from '../../lib/commands'
import { fmtNumber } from '../../lib/format'
import { catalogOf } from '../../lib/session'
import type { CatalogDoc, ErpRecord, State } from '../../lib/types'
import StatusPill from '../../components/StatusPill.vue'

const props = defineProps<{ record: ErpRecord | null; draft: State; doc: CatalogDoc; readonly: boolean }>()

interface Row { id: string; number: string; name: string; status: string; person_name: string | null; deadline: string | null; planned: number | null; logged: number }
interface Summary { tasks: number; open: number; planned: number; logged: number; rows: Row[] }
const data = ref<Summary | null>(null)
const error = ref('')
const taskDoc = computed(() => catalogOf('project_task'))

let seq = 0
async function load() {
  const id = props.record?.id
  if (!id) { data.value = null; return }
  const my = ++seq
  try {
    const res = await rpc<Summary>('erp_project_summary', { p_project: id })
    if (my === seq) { data.value = res; error.value = '' }
  } catch (e) {
    if (my === seq) error.value = messageOf(e)
  }
}
watch(() => [props.record?.id, props.record?.version], load, { immediate: true })
onDataChanged(() => { void load() })
</script>

<template>
  <section v-if="record" class="tasks no-print" data-testid="project-panel">
    <h2>작업 <span v-if="data" class="muted small" data-testid="project-summary">{{ data.tasks }}건, 남은 작업 {{ data.open }}건, 기록 {{ fmtNumber(data.logged) }}시간 / 계획 {{ fmtNumber(data.planned) }}시간</span></h2>
    <p v-if="record.state.origin_cancelled" class="banner banner-warn" role="status" data-testid="project-origin-cancelled">원본 주문이 취소되었습니다. 이미 기록한 시간이 있어 프로젝트는 그대로 두었습니다. 계속할지 담당자가 정합니다.</p>
    <p v-if="error" class="err-text small" role="alert">{{ error }}</p>
    <table v-if="data?.rows.length" class="tbl" data-testid="project-tasks">
      <thead><tr><th>번호</th><th>이름</th><th>단계</th><th>담당</th><th>기한</th><th class="num">기록 / 계획</th></tr></thead>
      <tbody>
        <tr v-for="t in data.rows" :key="t.id" data-testid="project-task">
          <td><router-link :to="{ name: 'record', params: { type: 'project_task', id: t.id } }">{{ t.number }}</router-link></td><td>{{ t.name }}</td>
          <td><StatusPill v-if="taskDoc" :doc="taskDoc" :value="t.status" /></td><td>{{ t.person_name }}</td><td>{{ t.deadline }}</td>
          <td class="num">{{ fmtNumber(t.logged) }}<template v-if="t.planned"> / {{ fmtNumber(t.planned) }}</template></td>
        </tr>
      </tbody>
    </table>
    <p v-else-if="data" class="muted small" data-testid="project-no-tasks">작업이 없습니다. 작업 메뉴에서 만듭니다.</p>
  </section>
</template>

<style scoped>
.tasks { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line); }
.tasks h2 { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; font-size: 13px; }
</style>

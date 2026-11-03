<script setup lang="ts">
// Saving a report's choices under a name. Someone's default opens the report as they left it.
import { onMounted, ref } from 'vue'
import { messageOf, rpc } from '../lib/api'
import { sendCommand } from '../lib/commands'
import { writeBlock } from '../lib/mode'
import { catalogOf } from '../lib/session'
import type { State } from '../lib/types'
import { ask, toast } from '../lib/ui'

interface Saved { id: string; name: string; filters: State | null; group_by: string[] | null; is_default: boolean | null; shared: boolean | null; mine: boolean }

const props = defineProps<{ report: string; filters: State; groupBy: string[] }>()
const emit = defineEmits<{ apply: [filters: State, groupBy: string[]] }>()
const saved = ref<Saved[]>([])
const chosen = ref('')
const usable = () => !!catalogOf('saved_search')

async function load(applyDefault = false) {
  if (!usable()) return
  try {
    saved.value = await rpc<Saved[]>('erp_saved_searches', { p_report: props.report })
    const first = applyDefault ? saved.value.find((s) => s.is_default) : undefined
    if (first) pick(first.id)
  } catch { saved.value = [] }
}
onMounted(() => { void load(true) })

function pick(id: string) {
  chosen.value = id
  const s = saved.value.find((x) => x.id === id)
  if (s) emit('apply', s.filters ?? {}, s.group_by ?? [])
}

async function save() {
  const answer = await ask({
    title: '이 조건 저장', confirmLabel: '저장',
    fields: [
      { name: 'name', label: '이름', type: 'text', required: true },
      { name: 'is_default', label: '이 보고서를 열 때 기본으로', type: 'boolean', default: false },
      { name: 'shared', label: '다른 사용자와 공유', type: 'boolean', default: false },
    ],
  })
  if (!answer) return
  try {
    const res = await sendCommand({ type: 'saved_search', command: 'create', payload: { ...answer.values, report: props.report, filters: props.filters, group_by: props.groupBy } })
    toast('저장했습니다.')
    await load()
    chosen.value = res.id
  } catch (e) {
    toast(messageOf(e), 'error')
  }
}

async function remove() {
  const s = saved.value.find((x) => x.id === chosen.value)
  if (!s) return
  try {
    await sendCommand({ type: 'saved_search', id: s.id, command: 'delete' })
    chosen.value = ''
    await load()
  } catch (e) {
    toast(messageOf(e), 'error')
  }
}
</script>

<template>
  <span v-if="usable()" class="row" data-testid="saved-search">
    <select class="select" style="width: 150px" aria-label="저장한 조건" :value="chosen" data-testid="saved-search-select" @change="pick(($event.target as HTMLSelectElement).value)">
      <option value="">저장한 조건</option>
      <option v-for="s in saved" :key="s.id" :value="s.id">{{ s.name }}{{ s.mine ? '' : ' (공유)' }}</option>
    </select>
    <button v-if="!writeBlock" type="button" class="btn btn-sm" data-testid="saved-search-save" @click="save">저장</button>
    <button v-if="!writeBlock && chosen && saved.find((s) => s.id === chosen)?.mine" type="button" class="btn btn-sm btn-ghost" data-testid="saved-search-delete" @click="remove">지우기</button>
  </span>
</template>

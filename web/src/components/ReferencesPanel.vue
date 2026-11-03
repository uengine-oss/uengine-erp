<script setup lang="ts">
// What points at this record. Read only when someone opens it: most forms are opened for something else.
import { ref } from 'vue'
import { messageOf, rpc } from '../lib/api'

interface Group { type: string; label: string; field: string; count: number; rows: { id: string; name: string | null; status: string | null }[] }

const props = defineProps<{ id: string }>()
const groups = ref<Group[] | null>(null)
const error = ref('')

async function onToggle(e: Event) {
  if (!(e.target as HTMLDetailsElement).open || groups.value) return
  try {
    groups.value = await rpc<Group[]>('erp_references', { p_id: props.id, p_limit: 10 })
  } catch (err) {
    error.value = messageOf(err)
  }
}
</script>

<template>
  <details class="refs no-print" data-testid="references" @toggle="onToggle">
    <summary>이 문서를 가리키는 곳</summary>
    <p v-if="error" class="err-text small">{{ error }}</p>
    <p v-else-if="groups && !groups.length" class="muted small" data-testid="references-empty">가리키는 문서가 없습니다.</p>
    <div v-for="g in groups ?? []" :key="`${g.type}.${g.field}`" class="refs-group" data-testid="references-group">
      <strong class="small">{{ g.label }} {{ g.count }}건</strong>
      <span class="refs-links"><router-link v-for="r in g.rows" :key="r.id" :to="{ name: 'record', params: { type: g.type, id: r.id } }">{{ r.name ?? r.id.slice(0, 8) }}</router-link></span>
    </div>
  </details>
</template>

<style scoped>
.refs { margin-top: 14px; }
.refs-group { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 6px; }
.refs-links { display: inline-flex; flex-wrap: wrap; gap: 4px 8px; }
</style>

<script setup lang="ts">
// Contacts that may be the same. Merging one is a person's call; merging all shows first what it would do.
import { computed, ref, watch } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { sendCommand } from '../../lib/commands'
import { useLoad } from '../../lib/load'
import { writeBlock } from '../../lib/mode'
import { hasRole } from '../../lib/session'
import { ask, toast } from '../../lib/ui'
import EmptyState from '../../components/EmptyState.vue'
import LoadError from '../../components/LoadError.vue'

interface Who { id: string; name: string }
interface Group { values: Record<string, string>; partners: Who[] }
interface Plan { dry_run: boolean; merged: number; groups: { into: Who; merge: Who[] }[] }

const FIELDS = [{ value: 'email', label: '이메일' }, { value: 'name', label: '이름' }, { value: 'tax_id', label: '사업자등록번호' }, { value: 'phone', label: '전화' }, { value: 'company_type', label: '회사 여부' }, { value: 'parent_id', label: '소속 회사' }]
const fields = ref<string[]>(['email'])
const keep = ref<Record<string, string>>({})
const busy = ref(false)
const canMerge = computed(() => hasRole(['sales', 'purchase', 'accounting']) && !writeBlock.value)

const { data, loading, error, load } = useLoad(() => rpc<Group[]>('erp_partner_duplicates', { p_fields: fields.value }))
watch(fields, () => { if (fields.value.length) void load() }, { immediate: true, deep: true })
const groups = computed(() => data.value ?? [])
const keyOf = (g: Group) => g.partners.map((p) => p.id).join('|')
const keptOf = (g: Group) => keep.value[keyOf(g)] ?? g.partners[0].id
const toggle = (f: string) => { fields.value = fields.value.includes(f) ? fields.value.filter((x) => x !== f) : [...fields.value, f] }

async function mergeGroup(g: Group) {
  const into = keptOf(g)
  const others = g.partners.filter((p) => p.id !== into)
  const answer = await ask({ title: '연락처 합치기', message: `${others.map((p) => p.name).join(', ')} 을(를) ${g.partners.find((p) => p.id === into)?.name} 으로 합칩니다. 이력은 이벤트로 남습니다.`, danger: true, reason: true, confirmLabel: '합치기' })
  if (!answer) return
  busy.value = true
  try {
    for (const p of others) await sendCommand({ type: 'partner', id: p.id, command: 'merge', payload: { into }, reason: answer.reason || null })
    toast('합쳤습니다.')
    await load()
  } catch (e) {
    toast(messageOf(e), 'error')
    await load()
  } finally {
    busy.value = false
  }
}

async function mergeAll() {
  busy.value = true
  try {
    const plan = await rpc<Plan>('erp_partner_merge_duplicates', { p_fields: fields.value, p_dry_run: true })
    const count = plan.groups.reduce((n, g) => n + g.merge.length, 0)
    if (!count) { toast('자동으로 합칠 수 있는 연락처가 없습니다. 분개에 쓰인 연락처는 빠집니다.'); return }
    const lines = plan.groups.map((g) => `${g.into.name} ← ${g.merge.map((m) => m.name).join(', ')}`).join('\n')
    const answer = await ask({ title: `${count}건을 한 번에 합칠까요?`, message: `가장 먼저 만든 연락처로 합칩니다. 분개에 쓰인 연락처는 빠집니다.\n\n${lines}`, danger: true, confirmLabel: '모두 합치기', wide: true })
    if (!answer) return
    const done = await rpc<Plan>('erp_partner_merge_duplicates', { p_fields: fields.value, p_dry_run: false })
    toast(`${done.merged}건을 합쳤습니다.`)
    await load()
  } catch (e) {
    toast(messageOf(e), 'error')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page" data-testid="duplicates">
    <div class="page-head">
      <h1>중복 연락처<span class="page-count">{{ groups.length }}묶음</span></h1>
      <div class="grow"></div>
      <button v-if="canMerge && groups.length" type="button" class="btn" :disabled="busy" data-testid="duplicates-merge-all" @click="mergeAll">모두 합치기</button>
    </div>
    <div class="toolbar chip-row">
      <span class="muted small">같은지 볼 항목</span>
      <button v-for="f in FIELDS" :key="f.value" type="button" class="toggle" :class="{ on: fields.includes(f.value) }" :aria-pressed="fields.includes(f.value)" :data-testid="`dup-field-${f.value}`" @click="toggle(f.value)">{{ f.label }}</button>
    </div>
    <LoadError :message="error" @retry="load" />
    <div class="page-body report-pad">
      <p v-if="!fields.length" class="muted">비교할 항목을 하나 이상 고르세요.</p>
      <section v-for="g in groups" :key="keyOf(g)" class="dup" data-testid="duplicate-group">
        <div class="dup-head"><span class="small dim">{{ Object.values(g.values).join(' · ') }}</span><button v-if="canMerge" type="button" class="btn btn-sm" :disabled="busy" data-testid="duplicate-merge" @click="mergeGroup(g)">합치기</button></div>
        <label v-for="p in g.partners" :key="p.id" class="check dup-row">
          <input type="radio" :name="keyOf(g)" :checked="keptOf(g) === p.id" :aria-label="`${p.name} 남기기`" @change="keep[keyOf(g)] = p.id" />
          <router-link :to="{ name: 'record', params: { type: 'partner', id: p.id } }">{{ p.name }}</router-link>
          <span v-if="keptOf(g) === p.id" class="tag">남길 연락처</span>
        </label>
      </section>
      <EmptyState v-if="fields.length && !groups.length && !loading && !error" title="겹치는 연락처가 없습니다" text="비어 있는 값은 같은 것으로 보지 않습니다." />
    </div>
  </div>
</template>

<style scoped>
.dup { padding: 8px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
.dup + .dup { margin-top: 8px; }
.dup-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
.dup-row { display: flex; }
</style>

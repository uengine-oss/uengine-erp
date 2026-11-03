<script setup lang="ts">
// Where a slip came from, and sending goods back. A return lists quantities per line, so the catalog alone cannot ask it.
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ApiError, messageOf } from '../../lib/api'
import { sendCommand } from '../../lib/commands'
import { db } from '../../lib/conn'
import { writeBlock } from '../../lib/mode'
import { catalogOf, hasRole } from '../../lib/session'
import type { ErpRecord, Field, State } from '../../lib/types'
import { ask, toast } from '../../lib/ui'

const props = defineProps<{ record: ErpRecord | null }>()
const router = useRouter()

const origin = computed(() => {
  const s = props.record?.state
  return s?.origin_type && s?.origin_id && catalogOf(s.origin_type) ? { type: s.origin_type as string, id: s.origin_id as string, name: (s.origin_name as string) ?? '원본 문서' } : null
})
const canReturn = computed(() => props.record?.status === 'done' && hasRole(['inventory']) && !writeBlock.value)

/* What came of this slip: what was scrapped from it, and what it left for later */
const scraps = ref(0)
const backorders = ref(0)
const countOf = async (type: string, field: string, id: string) => (await db().from('erp_records').select('id', { count: 'exact', head: true }).eq('type', type).eq(`state->>${field}`, id)).count ?? 0
async function loadCounts() {
  const id = props.record?.id
  if (!id) return
  ;[scraps.value, backorders.value] = await Promise.all([catalogOf('scrap') ? countOf('scrap', 'origin_picking_id', id) : 0, countOf('picking', 'backorder_of', id)])
}
watch(() => [props.record?.id, props.record?.version], () => { void loadCounts() }, { immediate: true })

const canScrap = computed(() => !!catalogOf('scrap') && hasRole(['inventory']) && !writeBlock.value && props.record?.status !== 'cancelled')

async function scrapFromSlip() {
  const r = props.record
  if (!r) return
  const moves: State[] = (r.state.moves ?? []).filter((m: State) => m.variant_id)
  const fields: Field[] = [
    { name: 'variant_id', label: '제품', type: 'enum', required: true, options: moves.map((m) => ({ value: m.variant_id, label: m.name ?? m.variant_id })) },
    { name: 'qty', label: '수량', type: 'number', required: true, default: 1 },
    { name: 'reason', label: '사유', type: 'text' },
  ]
  // Goods coming in are scrapped where they arrived, goods going out from where they left.
  const location = r.state.picking_type === 'incoming' ? r.state.location_to : r.state.location_from
  let values: State = { variant_id: moves[0]?.variant_id, qty: 1 }
  let error = ''
  for (;;) {
    const answer = await ask({ title: '이 전표에서 폐기', message: '폐기 문서를 만들고 바로 처리합니다. 전표의 수량은 바뀌지 않습니다.', error, fields, values, confirmLabel: '폐기', danger: true })
    if (!answer) return
    values = answer.values
    try {
      const made = await sendCommand({ type: 'scrap', command: 'create', payload: { origin_picking_id: r.id, variant_id: values.variant_id, qty: values.qty, reason: values.reason || undefined, location_id: location ?? undefined } })
      await validateScrap(made.id, made.version)
      toast('폐기했습니다.')
      await loadCounts()
      return
    } catch (e) {
      error = messageOf(e)
    }
  }
}
async function validateScrap(id: string, version: number) {
  try {
    await sendCommand({ type: 'scrap', id, command: 'validate', expectedVersion: version })
  } catch (e) {
    if ((e as ApiError).code !== 'ERP_SCRAP_SHORT') throw e
    const again = await ask({ title: '재고보다 많이 폐기합니다', message: (e as ApiError).message.replace(/\s*\([a-z_]+\)\.?$/, ''), confirmLabel: '그래도 폐기', danger: true })
    if (again) await sendCommand({ type: 'scrap', id, command: 'validate', payload: { force: true }, expectedVersion: version })
  }
}

async function makeReturn() {
  const moves: State[] = props.record?.state.moves ?? []
  const fields: Field[] = moves.filter((m) => (m.done ?? 0) > 0).map((m) => ({ name: m.id, label: m.name ?? '이동', type: 'number', default: m.done }))
  let values: State = {}
  let error = ''
  for (;;) {
    const answer = await ask({ title: '반품 전표 만들기', message: '수량을 돌려받을 만큼 고치세요. 원 전표의 위치를 뒤집어 바로 확정합니다.', error, fields, values, confirmLabel: '만들기' })
    if (!answer || !props.record) return
    values = answer.values
    try {
      const res = await sendCommand({
        type: 'picking', command: 'create',
        payload: { return_of: props.record.id, moves: Object.entries(values).filter(([, q]) => Number(q) > 0).map(([id, qty]) => ({ id, qty })) },
      })
      toast('반품 전표를 만들었습니다.')
      await router.push({ name: 'record', params: { type: 'picking', id: res.id } })
      return
    } catch (e) {
      error = messageOf(e)
    }
  }
}
</script>

<template>
  <span class="row-wrap" data-testid="doc-extras">
    <router-link v-if="origin" class="btn btn-sm btn-ghost" :to="{ name: 'record', params: { type: origin.type, id: origin.id } }" data-testid="picking-origin">{{ origin.name }}</router-link>
    <router-link v-if="record?.state.backorder_of" class="btn btn-sm btn-ghost" :to="{ name: 'record', params: { type: 'picking', id: record.state.backorder_of } }" data-testid="picking-backorder-of">백오더 원본</router-link>
    <router-link v-if="backorders && record" class="btn btn-sm btn-ghost" :to="{ name: 'list', params: { type: 'picking' }, query: { 'eq.backorder_of': record.id } }" data-testid="picking-backorders">백오더 {{ backorders }}건</router-link>
    <button v-if="canReturn" type="button" class="btn" data-testid="picking-return" @click="makeReturn">반품</button>
    <button v-if="canScrap" type="button" class="btn" data-testid="picking-scrap" @click="scrapFromSlip">폐기</button>
    <router-link v-if="scraps && record" class="btn btn-sm btn-ghost" :to="{ name: 'list', params: { type: 'scrap' }, query: { 'eq.origin_picking_id': record.id } }" data-testid="picking-scraps">폐기 내역 {{ scraps }}건</router-link>
    <router-link v-if="record" class="btn" :to="{ name: 'print', params: { type: 'picking', id: record.id } }" data-testid="doc-print">출력</router-link>
  </span>
</template>

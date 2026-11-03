<script setup lang="ts">
// Where a slip came from, and sending goods back. A return lists quantities per line, so the catalog alone cannot ask it.
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { messageOf } from '../../lib/api'
import { sendCommand } from '../../lib/commands'
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
    <button v-if="canReturn" type="button" class="btn" data-testid="picking-return" @click="makeReturn">반품</button>
  </span>
</template>

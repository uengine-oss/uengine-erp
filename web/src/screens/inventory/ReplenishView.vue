<script setup lang="ts">
// What the reorder rules say is needed, for someone to adjust and order. The quantities are the database's own sums.
import { computed, onMounted, reactive, ref } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { tellResult } from '../../lib/bulk'
import { onDataChanged, sendCommand } from '../../lib/commands'
import { fmtNumber } from '../../lib/format'
import { useLoad } from '../../lib/load'
import { writeBlock } from '../../lib/mode'
import { ensureNames, refLabel } from '../../lib/refs'
import { hasRole } from '../../lib/session'
import { ask, toast } from '../../lib/ui'
import EmptyState from '../../components/EmptyState.vue'
import LoadError from '../../components/LoadError.vue'
import NumberInput from '../../components/NumberInput.vue'

interface Need { rule_id: string; name: string | null; variant_id: string; location_id: string; min_qty: number; max_qty: number; multiple: number; trigger: string; last_error: string | null; on_hand: number; incoming: number; outgoing: number; rfq_qty: number; pending_qty: number; forecast: number; qty_to_order: number; lead_days: number; horizon: string; vendor_id: string | null; replenish_by: string }

const { data, loading, error, load } = useLoad(async () => {
  const list = await rpc<Need[]>('erp_replenish_list')
  await ensureNames(list.flatMap((r) => [r.variant_id, r.location_id, r.vendor_id]))
  return list
})
onMounted(load)
onDataChanged(() => { void load() })

const showAll = ref(false)
const picked = ref<Set<string>>(new Set())
const qty = reactive<Record<string, number | null>>({})
const open = ref('')
const busy = ref(false)
const list = computed(() => (data.value ?? []).filter((r) => showAll.value || Number(r.qty_to_order) > 0))
const canOrder = computed(() => hasRole(['inventory', 'purchase']) && !writeBlock.value)
const qtyOf = (r: Need) => (r.rule_id in qty ? qty[r.rule_id] : Number(r.qty_to_order))

function toggle(id: string) {
  const next = new Set(picked.value)
  if (next.has(id)) next.delete(id); else next.add(id)
  picked.value = next
}
async function order(r: Need) {
  busy.value = true
  try {
    await sendCommand({ type: 'reorder_rule', id: r.rule_id, command: 'replenish', payload: { qty: qtyOf(r) } })
    toast(`${refLabel(r.variant_id)} 을(를) 주문했습니다.`)
    delete qty[r.rule_id]
    await load()
  } catch (e) {
    toast(messageOf(e), 'error')
  } finally {
    busy.value = false
  }
}
/** Up to the maximum whether or not the minimum has been crossed: someone is filling shelves ahead of time. */
async function orderToMax() {
  const chosen = (data.value ?? []).filter((r) => picked.value.has(r.rule_id))
  const answer = await ask({ title: `${chosen.length}개 규칙을 최대까지 주문`, message: '최소 수량 아래가 아니어도 각 규칙의 최대 수량까지 주문합니다.', confirmLabel: '주문' })
  if (!answer) return
  busy.value = true
  const failed: { name: string; message: string }[] = []
  let done = 0
  for (const r of chosen) {
    try {
      await sendCommand({ type: 'reorder_rule', id: r.rule_id, command: 'replenish', payload: { to_max: true } })
      done++
    } catch (e) {
      failed.push({ name: refLabel(r.variant_id), message: messageOf(e) })
    }
  }
  busy.value = false
  picked.value = new Set()
  await tellResult('주문했습니다', done, failed)
  await load()
}
async function snooze(r: Need) {
  const answer = await ask({ title: '일시 중지', message: '이 날짜까지 목록과 자동 주문에서 빠집니다.', confirmLabel: '중지', fields: [{ name: 'until', label: '언제까지', type: 'date', required: true }] })
  if (!answer) return
  try {
    await sendCommand({ type: 'reorder_rule', id: r.rule_id, command: 'snooze', payload: { until: answer.values.until } })
    await load()
  } catch (e) {
    toast(messageOf(e), 'error')
  }
}
</script>

<template>
  <div class="page" data-testid="replenish">
    <div class="page-head">
      <h1>보충<span class="page-count">{{ list.length }}건</span></h1>
      <div class="grow"></div>
      <router-link class="btn" :to="{ name: 'list', params: { type: 'reorder_rule' } }">재주문 규칙</router-link>
    </div>
    <div class="toolbar">
      <label class="check small dim"><input v-model="showAll" type="checkbox" data-testid="replenish-all" />주문할 것이 없는 규칙도 보기</label>
      <div class="grow"></div>
      <button v-if="canOrder && picked.size" type="button" class="btn" :disabled="busy" data-testid="replenish-to-max" @click="orderToMax">선택 {{ picked.size }}건 최대까지 주문</button>
    </div>
    <LoadError :message="error" @retry="load" />
    <div class="page-body" style="background: var(--surface)">
      <table v-if="list.length" class="tbl" data-testid="replenish-table">
        <thead><tr><th v-if="canOrder" style="width: 30px"></th><th>제품</th><th>위치</th><th>공급처</th><th class="num">최소</th><th class="num">최대</th><th class="num">예측</th><th class="num" style="width: 110px">주문 수량</th><th v-if="canOrder" style="width: 210px"></th></tr></thead>
        <tbody>
          <template v-for="r in list" :key="r.rule_id">
            <tr data-testid="replenish-row" :data-rule="r.rule_id">
              <td v-if="canOrder"><input type="checkbox" :checked="picked.has(r.rule_id)" :aria-label="`${refLabel(r.variant_id)} 선택`" data-testid="replenish-pick" @change="toggle(r.rule_id)" /></td>
              <td>{{ refLabel(r.variant_id) }}<span v-if="r.last_error" class="tag" :title="r.last_error" style="margin-left: 4px" data-testid="replenish-error">멈춤</span></td>
              <td>{{ refLabel(r.location_id) }}</td><td data-testid="replenish-vendor">{{ r.replenish_by === 'make' ? '직접 제조' : r.vendor_id ? refLabel(r.vendor_id) : '없음' }}</td><td class="num">{{ fmtNumber(r.min_qty) }}</td><td class="num">{{ fmtNumber(r.max_qty) }}</td>
              <td class="num" :class="{ neg: r.forecast < 0 }" data-testid="replenish-forecast">{{ fmtNumber(r.forecast) }}</td>
              <td class="num"><NumberInput :model-value="qtyOf(r)" :aria-label="`${refLabel(r.variant_id)} 주문 수량`" :disabled="!canOrder" data-testid="replenish-qty" @update:model-value="qty[r.rule_id] = $event" /></td>
              <td v-if="canOrder" class="num">
                <button type="button" class="btn btn-sm btn-ghost" :aria-expanded="open === r.rule_id" data-testid="replenish-info" @click="open = open === r.rule_id ? '' : r.rule_id">정보</button>
                <button type="button" class="btn btn-sm btn-ghost" data-testid="replenish-snooze" @click="snooze(r)">중지</button>
                <button type="button" class="btn btn-sm btn-primary" :disabled="busy || !qtyOf(r)" data-testid="replenish-order" @click="order(r)">주문</button>
              </td>
            </tr>
            <tr v-if="open === r.rule_id" data-testid="replenish-detail">
              <td :colspan="canOrder ? 9 : 7" class="wrap detail">
                납기 <strong>{{ r.lead_days }}일</strong>, 예측일 <strong data-testid="replenish-horizon">{{ r.horizon }}</strong>. 이 날까지의 입출고만 셉니다.
                현재고 {{ fmtNumber(r.on_hand) }} − 출고 {{ fmtNumber(r.outgoing) }} + 입고 {{ fmtNumber(r.incoming) }} + 구매 견적·제조 계획 {{ fmtNumber(r.rfq_qty) }} + 요청 중 {{ fmtNumber(r.pending_qty) }} = 예측 {{ fmtNumber(r.forecast) }}.
                <template v-if="r.last_error"><br /><span class="err-text">{{ r.last_error }}</span></template>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
      <EmptyState v-else-if="!loading && !error" :title="showAll ? '재주문 규칙이 없습니다' : '지금 주문할 것이 없습니다'" text="재주문 규칙의 최소 수량 아래로 예측이 내려가면 여기에 나타납니다." />
    </div>
  </div>
</template>

<style scoped>
.detail { padding: 6px 12px; background: var(--ink-50); line-height: 1.6; }
</style>

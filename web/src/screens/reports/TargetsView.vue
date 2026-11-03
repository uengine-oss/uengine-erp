<script setup lang="ts">
// Orders with something left to invoice. The invoicing module works this out from its own documents.
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { messageOf, rpc } from '../../lib/api'
import { onDataChanged, sendCommand } from '../../lib/commands'
import { writeBlock } from '../../lib/mode'
import { ensureNames, refLabel } from '../../lib/refs'
import { fmtMoney } from '../../lib/format'
import { hasRole } from '../../lib/session'
import { toast } from '../../lib/ui'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'

interface Target { order_id: string; order_type: string; number: string; partner_id: string | null; date_order: string | null; amount: number }

const router = useRouter()
const kind = ref<'sales' | 'purchase'>('sales')
const rows = ref<Target[]>([])
const loading = ref(true)
const error = ref('')
const busy = ref('')
let seq = 0

async function load() {
  const my = ++seq
  error.value = ''
  try {
    const list = await rpc<Target[]>('erp_invoice_targets', { p_kind: kind.value, p_limit: 200 })
    await ensureNames(list.map((r) => r.partner_id))
    if (my === seq) rows.value = list
  } catch (e) {
    if (my === seq) { rows.value = []; error.value = messageOf(e) }
  } finally {
    if (my === seq) loading.value = false
  }
}
onMounted(load)
watch(kind, load)
onDataChanged(() => { void load() })

const canMake = computed(() => hasRole(['accounting']) && !writeBlock.value)

async function make(r: Target) {
  busy.value = r.order_id
  try {
    const payload = kind.value === 'sales' ? { from_sales_order: r.order_id, method: 'regular' } : { from_purchase_order: r.order_id }
    const res = await sendCommand({ type: 'account_move', command: 'create', payload })
    toast('청구서 초안을 만들었습니다.')
    await router.push({ name: 'record', params: { type: 'account_move', id: res.id } })
  } catch (e) {
    toast(messageOf(e), 'error')
    await load()
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div class="page" data-testid="targets">
    <div class="page-head"><h1>청구 대상<span class="page-count">{{ rows.length }}건</span></h1></div>
    <div class="toolbar">
      <div class="seg" role="group" aria-label="구분">
        <button type="button" :class="{ on: kind === 'sales' }" :aria-pressed="kind === 'sales'" data-testid="targets-sales" @click="kind = 'sales'">고객 청구</button>
        <button type="button" :class="{ on: kind === 'purchase' }" :aria-pressed="kind === 'purchase'" data-testid="targets-purchase" @click="kind = 'purchase'">공급사 청구</button>
      </div>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert" data-testid="targets-error"><Icon name="alert" /><span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" @click="load">다시 시도</button></div>
    <div class="page-body" style="background: var(--surface)">
      <table v-if="rows.length" class="tbl" data-testid="targets-table">
        <thead><tr><th>주문</th><th>거래처</th><th class="num">청구할 금액</th><th v-if="canMake" style="width: 130px"></th></tr></thead>
        <tbody>
          <tr v-for="r in rows" :key="r.order_id" data-testid="target-row" :data-number="r.number">
            <td><router-link :to="{ name: 'record', params: { type: r.order_type, id: r.order_id } }">{{ r.number }}</router-link></td>
            <td>{{ r.partner_id ? refLabel(r.partner_id) : '-' }}</td>
            <td class="num">{{ fmtMoney(r.amount) }}</td>
            <td v-if="canMake" class="num"><button type="button" class="btn btn-sm" :disabled="busy === r.order_id" data-testid="target-make" @click="make(r)">청구서 만들기</button></td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-else-if="!loading && !error" title="청구할 주문이 없습니다" :text="kind === 'sales' ? '주문이 확정되거나 납품되면 청구 방식에 따라 여기에 나타납니다.' : '구매 주문이 확정되거나 입고되면 청구 방식에 따라 여기에 나타납니다.'" />
    </div>
  </div>
</template>

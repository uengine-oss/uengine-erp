<script setup lang="ts">
// Picking products into a document by looking, rather than by knowing their names. Each pick is an ordinary update of the
// document's lines, so the database prices it the same way as a line typed on the form.
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { messageOf, rpc } from '../../lib/api'
import { sendCommand } from '../../lib/commands'
import { db } from '../../lib/conn'
import { fmtMoney, fmtNumber } from '../../lib/format'
import { rows as readRows, useLoad } from '../../lib/load'
import { writeBlock } from '../../lib/mode'
import { ensureNames, ensureStates, refLabel, refStates } from '../../lib/refs'
import { catalogOf } from '../../lib/session'
import type { CommandResult, ErpRecord, State } from '../../lib/types'
import { toast } from '../../lib/ui'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'
import LoadError from '../../components/LoadError.vue'
import RefSelect from '../../components/RefSelect.vue'

interface Item { key: string; productId: string; variantId: string | null; name: string; detail: string; price: number | null; minQty: number | null; values: string[] }

const props = defineProps<{ kind: 'sales' | 'purchase' }>()
const route = useRoute()
const router = useRouter()
const orderType = computed(() => (props.kind === 'sales' ? 'sales_order' : 'purchase_order'))
const orderId = computed(() => String(route.query.order ?? ''))
const pickOrder = ref<string | null>(null)
watch(pickOrder, (id) => { if (id) void router.replace({ query: { ...route.query, order: id } }) })

const order = ref<ErpRecord | null>(null)
const orderError = ref('')
async function loadOrder() {
  order.value = null
  orderError.value = ''
  if (!orderId.value) return
  try {
    const list = await readRows<ErpRecord>(db().from('erp_records').select('*').eq('id', orderId.value).eq('type', orderType.value))
    order.value = list[0] ?? null
    if (!order.value) orderError.value = '이 문서를 찾을 수 없습니다.'
  } catch (e) {
    orderError.value = messageOf(e)
  }
}
watch(orderId, () => { void loadOrder().then(() => items.load()) })

const search = ref('')
const category = ref<string | null>(null)
const attribute = ref<string | null>(null)
const attrValue = ref('')
const attrValues = computed<State[]>(() => (attribute.value ? refStates.get(attribute.value)?.values ?? [] : []))
watch(attribute, (a) => { attrValue.value = ''; if (a) void ensureStates([a]) })

/** A product with several variants shows one row for each: those are what goes on a line. */
function variantRows(p: { id: string; name: string | null; state: State }): Item[] {
  const list: State[] = (p.state.variants ?? []).filter((v: State) => v.active !== false)
  return list.map((v) => ({ key: v.id, productId: p.id, variantId: v.id, name: v.name ?? p.name ?? '', detail: v.sku ?? p.state.internal_ref ?? '', price: Number(p.state.list_price ?? 0) + Number(v.price_extra ?? 0), minQty: null, values: v.values ?? [] }))
}
const items = useLoad(async (): Promise<Item[]> => {
  if (props.kind === 'purchase') {
    const partner = order.value?.state.partner_id
    if (!partner) return []
    const list = await rpc<State[]>('erp_vendor_catalog', { p_partner_id: partner })
    return list.map((x) => ({ key: `${x.product_id}|${x.min_qty}`, productId: x.product_id, variantId: null, name: x.name, detail: x.vendor_code ?? '', price: Number(x.price ?? 0), minQty: Number(x.min_qty ?? 0), values: [] }))
  }
  let q = db().from('erp_records').select('id,name,state').eq('type', 'product').eq('active', true).contains('state', { sale_ok: true }).order('name').limit(200)
  if (category.value) q = q.eq('state->>category_id', category.value)
  if (attribute.value) q = q.contains('state', { attributes: [{ attribute_id: attribute.value }] })
  const list = await readRows<{ id: string; name: string | null; state: State }>(q)
  return list.flatMap(variantRows).filter((i) => !attrValue.value || i.values.includes(attrValue.value))
})
watch([category, attribute, attrValue], items.load)
onMounted(async () => { await loadOrder(); await items.load() })

const shown = computed(() => {
  const t = search.value.trim().toLowerCase()
  return (items.data.value ?? []).filter((i) => !t || `${i.name} ${i.detail}`.toLowerCase().includes(t))
})
const lines = computed<State[]>(() => order.value?.state.lines ?? [])
const inOrder = (i: Item) => lines.value.filter((l) => !l.display_type && (i.variantId ? l.variant_id === i.variantId : l.product_id === i.productId)).reduce((n, l) => n + Number(l.qty ?? 0), 0)
const editable = computed(() => !!order.value && !writeBlock.value && ['draft', 'sent'].includes(String(order.value.status)))
const busy = ref('')

async function put(i: Item, by: number) {
  if (!order.value) return
  busy.value = i.key
  const list = [...lines.value]
  const at = list.findIndex((l) => !l.display_type && (i.variantId ? l.variant_id === i.variantId : l.product_id === i.productId))
  if (at >= 0) {
    const qty = Number(list[at].qty ?? 0) + by
    if (qty <= 0) list.splice(at, 1)
    else list[at] = { ...list[at], qty }
  } else if (by > 0) {
    list.push(i.variantId ? { variant_id: i.variantId, qty: by } : { product_id: i.productId, qty: Math.max(by, i.minQty ?? 0) })
  }
  try {
    const res = await sendCommand<CommandResult>({ type: orderType.value, id: order.value.id, command: 'update', payload: { lines: list }, expectedVersion: order.value.version })
    order.value = { ...order.value, version: res.version, state: res.state }
  } catch (e) {
    toast(messageOf(e), 'error')
    await loadOrder()
  } finally {
    busy.value = ''
  }
}
const canUse = computed(() => !!catalogOf(orderType.value))
const orderLabel = computed(() => (props.kind === 'sales' ? '견적' : '견적 요청'))
watch(order, (o) => { if (o) void ensureNames([o.state.partner_id]) })
</script>

<template>
  <div class="page" data-testid="catalog">
    <div class="page-head">
      <h1>{{ kind === 'sales' ? '제품 카탈로그' : '공급사 카탈로그' }}<span v-if="order" class="page-count" data-testid="catalog-order">{{ order.name }} · {{ refLabel(order.state.partner_id) }}</span></h1>
      <div class="grow"></div>
      <strong v-if="order" class="num" data-testid="catalog-total">{{ fmtMoney(order.state.amount_total) }}</strong>
      <router-link v-if="order" class="btn btn-primary" :to="{ name: 'record', params: { type: orderType, id: order.id } }" data-testid="catalog-back">문서로 돌아가기</router-link>
    </div>
    <div v-if="!orderId && canUse" class="toolbar">
      <span class="dim small">담을 {{ orderLabel }}</span>
      <span style="width: 240px"><RefSelect v-model="pickOrder" :ref-type="orderType" placeholder="문서를 고르세요" :aria-label="`담을 ${orderLabel}`" /></span>
    </div>
    <div class="toolbar row-wrap">
      <label class="search"><Icon name="search" :size="13" /><span class="sr-only">검색</span><input v-model="search" class="input" type="search" placeholder="제품 검색" data-testid="catalog-search" /></label>
      <template v-if="kind === 'sales'">
        <span style="width: 170px"><RefSelect v-model="category" ref-type="product_category" placeholder="제품 분류" aria-label="제품 분류" /></span>
        <span v-if="catalogOf('attribute')" style="width: 150px"><RefSelect v-model="attribute" ref-type="attribute" placeholder="속성" aria-label="속성" /></span>
        <select v-if="attribute" v-model="attrValue" class="select" style="width: 130px" aria-label="속성 값" data-testid="catalog-value"><option value="">모든 값</option><option v-for="v in attrValues" :key="v.id" :value="v.id">{{ v.name }}</option></select>
      </template>
    </div>
    <div v-if="order && !editable" class="banner banner-info banner-flush no-print" data-testid="catalog-closed"><Icon name="info" /><span>이 문서는 더 담을 수 없는 상태입니다.</span></div>
    <LoadError :message="orderError || items.error.value" @retry="items.load" />
    <div class="page-body" style="background: var(--surface)">
      <table v-if="shown.length" class="tbl" data-testid="catalog-table">
        <thead><tr><th>제품</th><th>코드</th><th class="num">{{ kind === 'sales' ? '판매가' : '공급 단가' }}</th><th v-if="kind === 'purchase'" class="num">최소 수량</th><th class="num" style="width: 150px">담은 수량</th></tr></thead>
        <tbody>
          <tr v-for="i in shown" :key="i.key" data-testid="catalog-row" :data-name="i.name">
            <td>{{ i.name }}</td><td>{{ i.detail }}</td><td class="num">{{ fmtMoney(i.price) }}</td><td v-if="kind === 'purchase'" class="num">{{ fmtNumber(i.minQty) }}</td>
            <td class="num">
              <button v-if="inOrder(i) && editable" type="button" class="btn btn-sm btn-icon" :disabled="!!busy" aria-label="하나 빼기" data-testid="catalog-minus" @click="put(i, -1)">−</button>
              <span class="qty" data-testid="catalog-qty">{{ fmtNumber(inOrder(i)) }}</span>
              <button v-if="editable" type="button" class="btn btn-sm" :disabled="!!busy" data-testid="catalog-add" @click="put(i, 1)"><Icon name="plus" :size="11" />담기</button>
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-else-if="!items.loading.value && !items.error.value" :title="kind === 'purchase' && !order ? '문서를 먼저 고르세요' : '조건에 맞는 제품이 없습니다'" :text="kind === 'purchase' ? '제품의 공급사 가격에 이 공급사를 넣으면 여기에 나타납니다.' : '검색어나 조건을 바꾸어 보세요.'" />
    </div>
  </div>
</template>

<style scoped>
.qty { display: inline-block; min-width: 26px; padding: 0 4px; text-align: right; }
</style>

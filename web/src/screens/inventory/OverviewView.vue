<script setup lang="ts">
// What waits in each warehouse, by kind of work. Every number opens the list it counts.
import { computed, onMounted } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { nudgeBus, onDataChanged } from '../../lib/commands'
import { useLoad } from '../../lib/load'
import { writeBlock } from '../../lib/mode'
import { ensureNames, refLabel } from '../../lib/refs'
import { hasRole } from '../../lib/session'
import { toast } from '../../lib/ui'
import EmptyState from '../../components/EmptyState.vue'
import LoadError from '../../components/LoadError.vue'

interface Card { warehouse_id: string | null; picking_type: string; ready: number; waiting: number; draft: number; late: number; backorders: number }
const KIND: Record<string, string> = { incoming: '입고', outgoing: '출고', internal: '내부 이동' }

const { data, loading, error, load } = useLoad(async () => {
  const list = await rpc<Card[]>('erp_stock_overview')
  await ensureNames(list.map((c) => c.warehouse_id))
  return list
})
onMounted(load)
onDataChanged(() => { void load() })

const cards = computed(() => data.value ?? [])
const OPEN = 'confirmed,waiting,ready'
const to = (c: Card, query: Record<string, string>) => ({ name: 'list', params: { type: 'picking' }, query: { 'eq.picking_type': c.picking_type, ...(c.warehouse_id ? { 'eq.warehouse_id': c.warehouse_id } : {}), ...query } })
const lateQuery = () => ({ 'lt.scheduled_date': new Date().toISOString(), 'in.status': OPEN })
const canCheck = computed(() => hasRole(['inventory']) && !writeBlock.value)

async function checkAll() {
  try {
    const res = await rpc<{ changed: number }>('erp_stock_check_all', { p_ids: null })
    nudgeBus()
    toast(res.changed ? `${res.changed}건의 예약이 바뀌었습니다.` : '바뀐 전표가 없습니다. 재고가 모자란 전표는 대기로 남습니다.')
    await load()
  } catch (e) {
    toast(messageOf(e), 'error')
  }
}
</script>

<template>
  <div class="page" data-testid="stock-overview">
    <div class="page-head">
      <h1>재고 개요</h1>
      <div class="grow"></div>
      <button v-if="canCheck" type="button" class="btn" data-testid="overview-check-all" @click="checkAll">대기 전표 모두 재고 확인</button>
    </div>
    <LoadError :message="error" @retry="load" />
    <div class="page-body">
      <div v-if="cards.length" class="cards">
        <section v-for="c in cards" :key="`${c.warehouse_id}|${c.picking_type}`" class="op-card" data-testid="overview-card" :data-kind="c.picking_type">
          <h2>{{ KIND[c.picking_type] ?? c.picking_type }}<span v-if="c.warehouse_id" class="muted small"> · {{ refLabel(c.warehouse_id) }}</span></h2>
          <div class="stat-row">
            <router-link class="stat" :to="to(c, { status: 'ready' })" data-testid="overview-ready"><span class="stat-label">처리 대상</span><span class="stat-value">{{ c.ready }}</span></router-link>
            <router-link class="stat" :to="to(c, { 'in.status': 'confirmed,waiting' })" data-testid="overview-waiting"><span class="stat-label">대기</span><span class="stat-value">{{ c.waiting }}</span></router-link>
            <router-link class="stat" :class="{ 'stat-bad': c.late }" :to="to(c, lateQuery())" data-testid="overview-late"><span class="stat-label">지연</span><span class="stat-value">{{ c.late }}</span></router-link>
            <router-link class="stat" :class="{ 'stat-warn': c.backorders }" :to="to(c, { 'nn.backorder_of': '1', 'in.status': OPEN })" data-testid="overview-backorders"><span class="stat-label">백오더</span><span class="stat-value">{{ c.backorders }}</span></router-link>
          </div>
        </section>
      </div>
      <EmptyState v-else-if="!loading && !error" title="아직 전표가 없습니다" text="주문을 확정하거나 전표를 만들면 여기에 나타납니다." />
    </div>
  </div>
</template>

<style scoped>
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; padding: 12px 16px 24px; }
.op-card { padding: 10px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); min-width: 0; }
.op-card h2 { margin-bottom: 8px; font-size: 13px; }
.op-card .stat-row { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.op-card .stat { padding: 6px 8px; }
@media (max-width: 720px) { .cards { grid-template-columns: minmax(0, 1fr); } }
</style>

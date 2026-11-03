<script setup lang="ts">
// Where buying stands, for everyone and for this buyer. The counts are the database's; each opens the list it counts.
import { onMounted } from 'vue'
import { rpc } from '../../lib/api'
import { onDataChanged } from '../../lib/commands'
import { fmtMoney, fmtNumber } from '../../lib/format'
import { useLoad } from '../../lib/load'
import { session } from '../../lib/session'
import LoadError from '../../components/LoadError.vue'

interface Dash { to_send: number; waiting_reply: number; to_approve: number; late: number; mine_to_send: number; mine_waiting: number; mine_late: number; amount_7d: number; lead_days_7d: number | null; sent_7d: number }

const { data, error, load } = useLoad(() => rpc<Dash>('erp_purchase_dashboard'))
onMounted(load)
onDataChanged(() => { void load() })

const list = (query: Record<string, string>) => ({ name: 'list', params: { type: 'purchase_order' }, query })
const lateQuery = (extra: Record<string, string> = {}) => ({ 'in.status': 'draft,sent,to_approve', 'lt.date_order': new Date().toISOString(), ...extra })
const mine = (): Record<string, string> => (session.me?.record_id ? { 'eq.buyer_id': session.me.record_id } : {})
</script>

<template>
  <div class="page" data-testid="purchase-dashboard">
    <div class="page-head">
      <h1>구매 현황</h1>
      <div class="grow"></div>
      <router-link class="btn" to="/purchase/analysis">구매 분석</router-link>
      <router-link class="btn btn-primary" :to="{ name: 'new', params: { type: 'purchase_order' } }" data-testid="dashboard-new">견적 요청 만들기</router-link>
    </div>
    <LoadError :message="error" @retry="load" />
    <div v-if="data" class="page-body report-pad">
      <section class="report-section">
        <h2>전체</h2>
        <div class="stat-row">
          <router-link class="stat" :to="list({ status: 'draft' })" data-testid="dash-to-send"><span class="stat-label">보낼 견적 요청</span><span class="stat-value">{{ data.to_send }}</span></router-link>
          <router-link class="stat" :to="list({ status: 'sent' })" data-testid="dash-waiting"><span class="stat-label">회신 대기</span><span class="stat-value">{{ data.waiting_reply }}</span></router-link>
          <router-link class="stat" :to="list({ status: 'to_approve' })" data-testid="dash-approve"><span class="stat-label">승인 대기</span><span class="stat-value">{{ data.to_approve }}</span></router-link>
          <router-link class="stat" :class="{ 'stat-bad': data.late }" :to="list(lateQuery())" data-testid="dash-late"><span class="stat-label">마감 지남</span><span class="stat-value">{{ data.late }}</span></router-link>
        </div>
      </section>
      <section class="report-section">
        <h2>내 담당</h2>
        <div class="stat-row">
          <router-link class="stat" :to="list({ status: 'draft', ...mine() })" data-testid="dash-mine-send"><span class="stat-label">보낼 견적 요청</span><span class="stat-value">{{ data.mine_to_send }}</span></router-link>
          <router-link class="stat" :to="list({ status: 'sent', ...mine() })" data-testid="dash-mine-waiting"><span class="stat-label">회신 대기</span><span class="stat-value">{{ data.mine_waiting }}</span></router-link>
          <router-link class="stat" :class="{ 'stat-bad': data.mine_late }" :to="list(lateQuery(mine()))" data-testid="dash-mine-late"><span class="stat-label">마감 지남</span><span class="stat-value">{{ data.mine_late }}</span></router-link>
        </div>
      </section>
      <section class="report-section">
        <h2>지난 7일</h2>
        <div class="stat-row">
          <div class="stat"><span class="stat-label">확정한 구매 금액</span><span class="stat-value" data-testid="dash-amount">{{ fmtMoney(data.amount_7d) }}</span></div>
          <div class="stat"><span class="stat-label">확정에서 입고까지</span><span class="stat-value" data-testid="dash-lead">{{ data.lead_days_7d === null ? '-' : `${fmtNumber(Math.round(data.lead_days_7d * 10) / 10)}일` }}</span></div>
          <div class="stat"><span class="stat-label">보낸 견적 요청</span><span class="stat-value" data-testid="dash-sent">{{ data.sent_7d }}</span></div>
        </div>
      </section>
    </div>
  </div>
</template>

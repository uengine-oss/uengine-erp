<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { messageOf, rpc } from '../../lib/api'
import { fmtMoney } from '../../lib/format'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'

const props = defineProps<{ account: string }>()
const route = useRoute()

interface Line { date: string; event_seq: number; move_id: string; name: string | null; number: string | null; debit: number; credit: number; balance: number }
interface Ledger { account: string; code: string; opening: number; closing: number; rows: Line[] }

const data = ref<Ledger | null>(null)
const error = ref('')
const loading = ref(true)
const from = computed(() => String(route.query.from ?? '') || null)
const to = computed(() => String(route.query.to ?? '') || null)

async function load() {
  error.value = ''
  try {
    data.value = await rpc<Ledger>('erp_general_ledger', { p_account: props.account, p_from: from.value, p_to: to.value })
  } catch (e) {
    data.value = null
    error.value = messageOf(e)
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(() => [props.account, from.value, to.value], load)
</script>

<template>
  <div class="page" data-testid="general-ledger">
    <div class="page-head">
      <div class="crumbs"><router-link :to="{ path: '/accounting/trial-balance' }">시산표</router-link><Icon class="muted" name="chevron-right" :size="12" /><h1>{{ data?.code }} {{ data?.account ?? '계정별 원장' }}</h1></div>
      <span class="muted small">{{ from ?? '처음' }} ~ {{ to ?? '지금' }}</span>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert"><Icon name="alert" /><span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" @click="load">다시 시도</button></div>
    <div class="page-body" style="background: var(--surface)">
      <table v-if="data?.rows.length" class="tbl" data-testid="gl-table">
        <thead><tr><th style="width: 100px">날짜</th><th>전표</th><th>내용</th><th class="num">차변</th><th class="num">대변</th><th class="num">잔액</th></tr></thead>
        <tbody>
          <tr><td></td><td class="muted" colspan="4">기초 잔액</td><td class="num">{{ fmtMoney(data.opening) }}</td></tr>
          <tr v-for="r in data.rows" :key="`${r.event_seq}|${r.move_id}|${r.debit}|${r.credit}|${r.name}`" data-testid="gl-row"><td>{{ r.date }}</td><td><router-link :to="{ name: 'record', params: { type: 'journal_entry', id: r.move_id } }">{{ r.number }}</router-link></td><td>{{ r.name }}</td><td class="num">{{ fmtMoney(r.debit) }}</td><td class="num">{{ fmtMoney(r.credit) }}</td><td class="num">{{ fmtMoney(r.balance) }}</td></tr>
        </tbody>
      </table>
      <EmptyState v-else-if="!loading && !error" title="이 기간의 움직임이 없습니다" />
    </div>
  </div>
</template>

<style scoped>
.crumbs { display: flex; align-items: center; gap: 6px; }
</style>

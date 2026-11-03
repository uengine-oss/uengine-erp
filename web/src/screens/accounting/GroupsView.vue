<script setup lang="ts">
// Balances by code range, each account under the narrowest group that holds it.
import { computed, ref, watch } from 'vue'
import { rpc } from '../../lib/api'
import { fmtMoney } from '../../lib/format'
import { useLoad } from '../../lib/load'
import EmptyState from '../../components/EmptyState.vue'
import LoadError from '../../components/LoadError.vue'

interface Acc { id: string; code: string; name: string; opening?: number; debit?: number; credit?: number; closing: number }
interface Group { id: string; name: string; code_prefix_start: string; code_prefix_end: string; opening: number; debit: number; credit: number; closing: number; accounts: Acc[] }
interface Report { groups: Group[]; ungrouped: Acc[] }

const from = ref('')
const to = ref('')
const { data, loading, error, load } = useLoad(() => rpc<Report>('erp_account_groups', { p_from: from.value || null, p_to: to.value || null }))
watch([from, to], load, { immediate: true })
const groups = computed(() => (data.value?.groups ?? []).filter((g) => g.accounts.length))
const ledgerTo = (a: Acc) => ({ name: 'general-ledger', params: { account: a.id }, query: { from: from.value || undefined, to: to.value || undefined } })
</script>

<template>
  <div class="page" data-testid="account-groups">
    <div class="page-head"><h1>계정 그룹 잔액</h1><div class="grow"></div><router-link class="btn" :to="{ name: 'list', params: { type: 'account_group' } }">그룹 관리</router-link></div>
    <div class="toolbar row-wrap">
      <label class="field-inline">부터 <input v-model="from" class="input" type="date" data-testid="groups-from" /></label>
      <label class="field-inline">까지 <input v-model="to" class="input" type="date" data-testid="groups-to" /></label>
    </div>
    <LoadError :message="error" @retry="load" />
    <div class="page-body" style="background: var(--surface)">
      <table v-if="groups.length" class="tbl" data-testid="groups-table">
        <thead><tr><th>코드</th><th>이름</th><th class="num">기초</th><th class="num">차변</th><th class="num">대변</th><th class="num">기말</th></tr></thead>
        <tbody>
          <template v-for="g in groups" :key="g.id">
            <tr class="group-row" data-testid="group-row"><td>{{ g.code_prefix_start }}~{{ g.code_prefix_end }}</td><td>{{ g.name }}</td><td class="num">{{ fmtMoney(g.opening) }}</td><td class="num">{{ fmtMoney(g.debit) }}</td><td class="num">{{ fmtMoney(g.credit) }}</td><td class="num" data-testid="group-closing">{{ fmtMoney(g.closing) }}</td></tr>
            <tr v-for="a in g.accounts" :key="a.id" data-testid="group-account"><td class="indent">{{ a.code }}</td><td><router-link :to="ledgerTo(a)">{{ a.name }}</router-link></td><td class="num">{{ fmtMoney(a.opening) }}</td><td class="num">{{ fmtMoney(a.debit) }}</td><td class="num">{{ fmtMoney(a.credit) }}</td><td class="num">{{ fmtMoney(a.closing) }}</td></tr>
          </template>
          <template v-if="data?.ungrouped.length">
            <tr class="group-row"><td></td><td colspan="4">그룹 없음</td><td></td></tr>
            <tr v-for="a in data.ungrouped" :key="a.id" data-testid="group-ungrouped"><td class="indent">{{ a.code }}</td><td colspan="4"><router-link :to="ledgerTo(a)">{{ a.name }}</router-link></td><td class="num">{{ fmtMoney(a.closing) }}</td></tr>
          </template>
        </tbody>
      </table>
      <EmptyState v-else-if="!loading && !error" title="계정 그룹이 없습니다" text="계정 그룹을 만들면 코드 범위대로 묶어 보여 줍니다." />
    </div>
  </div>
</template>

<style scoped>
.group-row td { font-weight: 650; background: var(--ink-50); }
.indent { padding-left: 22px !important; }
</style>

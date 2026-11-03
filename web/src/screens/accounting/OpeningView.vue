<script setup lang="ts">
// Opening balances typed against the chart of accounts. They become one ordinary entry of their own kind, which the
// database accepts only if it balances.
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { messageOf } from '../../lib/api'
import { sendCommand } from '../../lib/commands'
import { db } from '../../lib/conn'
import { fmtDay, fmtMoney } from '../../lib/format'
import { rows as readRows, useLoad } from '../../lib/load'
import { writeBlock } from '../../lib/mode'
import { toast } from '../../lib/ui'
import type { State } from '../../lib/types'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'
import LoadError from '../../components/LoadError.vue'
import NumberInput from '../../components/NumberInput.vue'

const router = useRouter()
const date = ref(fmtDay(new Date().toISOString()))
const debit = reactive<Record<string, number | null>>({})
const credit = reactive<Record<string, number | null>>({})
const search = ref('')
const error2 = ref('')
const busy = ref(false)

const { data, loading, error, load } = useLoad(() => readRows<{ id: string; state: State }>(db().from('erp_records').select('id,state').eq('type', 'account').eq('active', true).order('state->>code')))
onMounted(load)
const accounts = computed(() => data.value ?? [])
const shown = computed(() => { const t = search.value.trim().toLowerCase(); return accounts.value.filter((a) => !t || `${a.state.code} ${a.state.name}`.toLowerCase().includes(t)) })
const sum = (m: Record<string, number | null>) => Object.values(m).reduce<number>((n, v) => n + Number(v ?? 0), 0)
const totalDebit = computed(() => sum(debit))
const totalCredit = computed(() => sum(credit))
const gap = computed(() => totalDebit.value - totalCredit.value)
const canSave = computed(() => !writeBlock.value && !busy.value && (totalDebit.value > 0 || totalCredit.value > 0) && !!date.value)

async function save() {
  busy.value = true
  error2.value = ''
  try {
    const lines = accounts.value.filter((a) => Number(debit[a.id] ?? 0) || Number(credit[a.id] ?? 0)).map((a) => ({ account_id: a.id, name: '기초 잔액', debit: Number(debit[a.id] ?? 0), credit: Number(credit[a.id] ?? 0) }))
    const res = await sendCommand({ type: 'journal_entry', command: 'create', payload: { date: date.value, kind: 'opening', ref: '기초 잔액', post: true, lines } })
    toast('기초 잔액 전표를 게시했습니다.')
    await router.push({ name: 'record', params: { type: 'journal_entry', id: res.id } })
  } catch (e) {
    error2.value = messageOf(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page" data-testid="opening">
    <div class="page-head">
      <h1>기초 잔액 입력</h1>
      <div class="grow"></div>
      <router-link class="btn" :to="{ name: 'list', params: { type: 'journal_entry' }, query: { 'eq.kind': 'opening' } }" data-testid="opening-existing">이미 넣은 기초 잔액</router-link>
      <button type="button" class="btn btn-primary" :disabled="!canSave" data-testid="opening-save" @click="save">전표로 게시</button>
    </div>
    <div class="toolbar row-wrap">
      <label class="field-inline">회계일 <input v-model="date" class="input" type="date" data-testid="opening-date" /></label>
      <label class="search"><Icon name="search" :size="13" /><span class="sr-only">계정 검색</span><input v-model="search" class="input" type="search" placeholder="계정 검색" data-testid="opening-search" /></label>
      <div class="grow"></div>
      <span class="small" data-testid="opening-totals">차변 {{ fmtMoney(totalDebit) }} / 대변 {{ fmtMoney(totalCredit) }}</span>
      <span class="small" :class="gap ? 'err-text' : 'dim'" data-testid="opening-gap">차이 {{ fmtMoney(gap) }}</span>
    </div>
    <div v-if="error2" class="banner banner-error banner-flush" role="alert" data-testid="opening-error"><Icon name="alert" /><span>{{ error2 }}</span></div>
    <LoadError :message="error" @retry="load" />
    <div class="page-body" style="background: var(--surface)">
      <table v-if="shown.length" class="tbl" data-testid="opening-table">
        <thead><tr><th style="width: 90px">코드</th><th>계정</th><th class="num" style="width: 150px">차변</th><th class="num" style="width: 150px">대변</th></tr></thead>
        <tbody>
          <tr v-for="a in shown" :key="a.id" data-testid="opening-row" :data-code="a.state.code">
            <td>{{ a.state.code }}</td><td>{{ a.state.name }}</td>
            <td class="num"><NumberInput v-model="debit[a.id]" kind="money" :aria-label="`${a.state.name} 차변`" data-testid="opening-debit" /></td>
            <td class="num"><NumberInput v-model="credit[a.id]" kind="money" :aria-label="`${a.state.name} 대변`" data-testid="opening-credit" /></td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-else-if="!loading && !error" title="계정이 없습니다" />
    </div>
  </div>
</template>

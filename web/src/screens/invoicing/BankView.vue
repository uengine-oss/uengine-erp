<script setup lang="ts">
// One flow for one bank account: what the bank says, matching it to the books, and what is still apart.
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { db } from '../../lib/conn'
import { rows as readRows, useLoad } from '../../lib/load'
import EmptyState from '../../components/EmptyState.vue'
import LoadError from '../../components/LoadError.vue'
import BankDiff from './BankDiff.vue'
import BankMatch from './BankMatch.vue'
import BankStatements from './BankStatements.vue'

const route = useRoute()
const router = useRouter()
const STEPS = [{ key: 'statements', label: '1. 명세서' }, { key: 'match', label: '2. 맞춰 보기' }, { key: 'difference', label: '3. 차이 확인' }]
const step = computed(() => String(route.query.step ?? 'statements'))
const go = (patch: Record<string, string>) => void router.replace({ query: { ...route.query, ...patch } })

const { data, loading, error, load } = useLoad(() => readRows<{ id: string; name: string | null; state: { journal_type: string; code: string } }>(
  db().from('erp_records').select('id,name,state').eq('type', 'journal').eq('active', true).in('state->>journal_type', ['bank', 'cash', 'credit']).order('name')))
onMounted(load)
const journals = computed(() => data.value ?? [])
// The first bank unless the address names one. Not written to the address: a redirect here could cancel someone leaving.
const journal = computed(() => {
  const named = String(route.query.j ?? '')
  if (journals.value.some((j) => j.id === named)) return named
  return (journals.value.find((j) => j.state.journal_type === 'bank') ?? journals.value[0])?.id ?? ''
})
</script>

<template>
  <div class="page" data-testid="bank">
    <div class="page-head">
      <h1>은행 대사</h1>
      <div class="grow"></div>
      <select class="select" style="width: 170px" aria-label="분개장" :value="journal" data-testid="bank-journal" @change="go({ j: ($event.target as HTMLSelectElement).value })"><option v-for="j in journals" :key="j.id" :value="j.id">{{ j.name }}</option></select>
      <router-link class="btn" :to="{ name: 'list', params: { type: 'journal' } }">분개장</router-link>
    </div>
    <div class="toolbar">
      <div class="seg" role="group" aria-label="단계">
        <button v-for="s in STEPS" :key="s.key" type="button" :class="{ on: step === s.key }" :aria-pressed="step === s.key" :data-testid="`bank-step-${s.key}`" @click="go({ step: s.key })">{{ s.label }}</button>
      </div>
    </div>
    <LoadError :message="error" @retry="load" />
    <div class="page-body">
      <template v-if="journal">
        <BankStatements v-if="step === 'statements'" :journal="journal" @next="go({ step: 'match' })" />
        <BankMatch v-else-if="step === 'match'" :journal="journal" @next="go({ step: 'difference' })" />
        <BankDiff v-else :journal="journal" @back="go({ step: 'match' })" />
      </template>
      <EmptyState v-else-if="!loading && !error" title="은행·현금·카드 분개장이 없습니다" text="분개장을 만들면 여기서 명세서를 맞출 수 있습니다." />
    </div>
  </div>
</template>

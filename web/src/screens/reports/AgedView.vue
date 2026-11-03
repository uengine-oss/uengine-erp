<script setup lang="ts">
// Who owes what, and how late. The database splits it by each installment's due date.
import { computed, onMounted, ref, watch } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { fmtDay, fmtMoney } from '../../lib/format'
import { timeView } from '../../lib/mode'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'

interface Buckets { not_due: number; d1_30: number; d31_60: number; d61_90: number; over_90: number; total: number }
interface Report { kind: string; at: string; rows: (Buckets & { partner_id: string; partner_name: string | null })[]; totals: Buckets }

const kind = ref<'receivable' | 'payable'>('receivable')
const at = ref(timeView.date || fmtDay(new Date().toISOString()))
const report = ref<Report | null>(null)
const loading = ref(true)
const error = ref('')
let seq = 0

async function load() {
  const my = ++seq
  error.value = ''
  try {
    const r = await rpc<Report>('erp_aged', { p_kind: kind.value, p_at: at.value || null })
    if (my === seq) report.value = r
  } catch (e) {
    if (my === seq) { report.value = null; error.value = messageOf(e) }
  } finally {
    if (my === seq) loading.value = false
  }
}
onMounted(load)
watch([kind, at], load)
watch(() => timeView.date, (d) => { at.value = d || fmtDay(new Date().toISOString()) })

const COLS: { key: keyof Buckets; label: string }[] = [
  { key: 'not_due', label: '기한 전' }, { key: 'd1_30', label: '1~30일' }, { key: 'd31_60', label: '31~60일' }, { key: 'd61_90', label: '61~90일' }, { key: 'over_90', label: '90일 넘음' }, { key: 'total', label: '합계' },
]
const rows = computed(() => report.value?.rows ?? [])
</script>

<template>
  <div class="page" data-testid="aged">
    <div class="page-head"><h1>미수금·미지급금</h1></div>
    <div class="toolbar">
      <div class="seg" role="group" aria-label="구분">
        <button type="button" :class="{ on: kind === 'receivable' }" :aria-pressed="kind === 'receivable'" data-testid="aged-receivable" @click="kind = 'receivable'">받을 돈</button>
        <button type="button" :class="{ on: kind === 'payable' }" :aria-pressed="kind === 'payable'" data-testid="aged-payable" @click="kind = 'payable'">줄 돈</button>
      </div>
      <label class="check small dim">기준일 <input v-model="at" class="input" type="date" style="width: 130px" data-testid="aged-at" /></label>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert" data-testid="aged-error"><Icon name="alert" /><span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" @click="load">다시 시도</button></div>
    <div class="page-body" style="background: var(--surface)">
      <table v-if="rows.length" class="tbl" data-testid="aged-table">
        <thead><tr><th>거래처</th><th v-for="c in COLS" :key="c.key" class="num">{{ c.label }}</th></tr></thead>
        <tbody><tr v-for="r in rows" :key="r.partner_id" data-testid="aged-row"><td>{{ r.partner_name }}</td><td v-for="c in COLS" :key="c.key" class="num">{{ fmtMoney(r[c.key]) }}</td></tr></tbody>
        <tfoot v-if="report"><tr class="foot"><td>합계</td><td v-for="c in COLS" :key="c.key" class="num" :data-testid="`aged-total-${c.key}`">{{ fmtMoney(report.totals[c.key]) }}</td></tr></tfoot>
      </table>
      <EmptyState v-else-if="!loading && !error" title="남은 금액이 없습니다" text="게시한 청구서에 받을 돈이 남으면 여기에 나타납니다." />
    </div>
  </div>
</template>

<style scoped>
.foot td { font-weight: 650; border-top: 1px solid var(--line-strong); }
</style>

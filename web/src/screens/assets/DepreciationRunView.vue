<script setup lang="ts">
// Depreciation run for a month or a whole year. What it would charge and book is on screen before anything happens,
// and the database works it out. Undoing a run goes through the run's own history, as any work does.
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { messageOf, rpc } from '../../lib/api'
import { onDataChanged, sendCommand } from '../../lib/commands'
import { db } from '../../lib/conn'
import { fmtDay, fmtMoney } from '../../lib/format'
import { rows as readRows, thisMonth, useLoad } from '../../lib/load'
import { timeView, writeBlock } from '../../lib/mode'
import { catalogOf } from '../../lib/session'
import type { State } from '../../lib/types'
import { toast } from '../../lib/ui'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'
import LoadError from '../../components/LoadError.vue'
import ReviewNotice from '../../components/ReviewNotice.vue'

interface Line { asset_id: string; asset_name: string; asset_number: string; from_month: string; to_month: string; amount: number; accumulated: number; book_value: number; done: boolean }
interface Entry { account_id: string; code: string; name: string; debit: number; credit: number }
interface Preview { through: string; lines: Line[]; total: number; locked: string | null; active_assets: number; entry: Entry[] }

const router = useRouter()
const today = () => timeView.date || fmtDay(new Date().toISOString())
const grain = ref<'month' | 'year'>('month')
const month = ref(today().slice(0, 7))
const year = ref(Number(today().slice(0, 4)))
const through = computed(() => (grain.value === 'month' ? thisMonth(`${month.value || today().slice(0, 7)}-01`).to : `${year.value || today().slice(0, 4)}-12-31`))
const { data, loading, error, load } = useLoad(async () => {
  const [preview, runs] = await Promise.all([
    rpc<Preview>('erp_depreciation_preview', { p_through: through.value }),
    readRows<{ id: string; state: State; name: string }>(db().from('erp_records').select('id,state,name').eq('type', 'depreciation_run').order('created_at', { ascending: false }).limit(10)),
  ])
  return { preview, runs }
})
watch(through, load, { immediate: true })
onDataChanged(() => { void load() })
const p = computed(() => data.value?.preview ?? null)
const busy = ref(false)
const failure = ref('')
const canRun = computed(() => !writeBlock.value && !busy.value && !!p.value?.lines.length && !p.value.locked)
const booksOn = computed(() => !!catalogOf('journal_entry'))

async function run() {
  busy.value = true
  failure.value = ''
  try {
    const res = await sendCommand({ type: 'depreciation_run', command: 'create', payload: { through: through.value } })
    toast('감가상각을 실행했습니다.')
    await router.push({ name: 'record', params: { type: 'depreciation_run', id: res.id } })
  } catch (e) {
    failure.value = messageOf(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page" data-testid="depreciation">
    <div class="page-head"><h1>감가상각 실행</h1><div class="grow"></div><router-link class="btn" :to="{ name: 'list', params: { type: 'asset' } }">고정자산 목록</router-link></div>
    <ReviewNotice />
    <div class="toolbar row-wrap">
      <div class="seg" role="group" aria-label="단위">
        <button type="button" :class="{ on: grain === 'month' }" :aria-pressed="grain === 'month'" data-testid="dep-grain-month" @click="grain = 'month'">월별</button>
        <button type="button" :class="{ on: grain === 'year' }" :aria-pressed="grain === 'year'" data-testid="dep-grain-year" @click="grain = 'year'">연별</button>
      </div>
      <input v-if="grain === 'month'" v-model="month" class="input" type="month" style="width: 150px" aria-label="월" data-testid="dep-month" />
      <input v-else v-model.number="year" class="input" type="number" style="width: 84px" aria-label="연도" data-testid="dep-year" />
      <span class="small dim" data-testid="dep-through">{{ through }} 까지, 그날 자로 잡습니다.</span>
    </div>
    <LoadError :message="error" @retry="load" />
    <div v-if="failure" class="banner banner-error banner-flush" role="alert" data-testid="dep-error"><Icon name="alert" /><span class="grow">{{ failure }}</span></div>
    <div v-if="p?.locked" class="banner banner-flush" data-testid="dep-locked"><Icon name="lock" /><span class="grow">{{ p.locked }}</span></div>
    <div v-if="p" class="page-body report-pad">
      <section class="report-section">
        <div class="row-wrap" style="justify-content: space-between">
          <h2>자산별 금액</h2>
          <button type="button" class="btn btn-primary" :disabled="!canRun" data-testid="dep-run" @click="run">감가상각 실행</button>
        </div>
        <div class="scroll-x">
          <table v-if="p.lines.length" class="tbl" data-testid="dep-lines">
            <thead><tr><th>번호</th><th>자산</th><th>기간</th><th class="num">감가상각비</th><th class="num">상각 누계</th><th class="num">장부가액</th></tr></thead>
            <tbody><tr v-for="l in p.lines" :key="l.asset_id" data-testid="dep-line"><td>{{ l.asset_number }}</td><td>{{ l.asset_name }}<span v-if="l.done" class="pill pill-blue">이번에 끝남</span></td><td>{{ l.from_month }} ~ {{ l.to_month }}</td><td class="num">{{ fmtMoney(l.amount) }}</td><td class="num">{{ fmtMoney(l.accumulated) }}</td><td class="num">{{ fmtMoney(l.book_value) }}</td></tr></tbody>
            <tfoot><tr class="foot"><td colspan="3">합계</td><td class="num" data-testid="dep-total">{{ fmtMoney(p.total) }}</td><td colspan="2"></td></tr></tfoot>
          </table>
          <EmptyState v-else-if="!loading" :title="`${through} 까지 상각할 금액이 없습니다`" :text="`상각 중인 자산 ${p.active_assets}건. 이미 상각한 달은 다시 잡지 않습니다.`" />
        </div>
      </section>
      <section v-if="p.entry.length" class="report-section">
        <h2>{{ booksOn ? '이 실행이 만들 전표' : '회계를 켜면 만들어질 전표' }}</h2>
        <div class="scroll-x">
          <table class="tbl" style="max-width: 620px" data-testid="dep-entry">
            <thead><tr><th>계정</th><th class="num">차변</th><th class="num">대변</th></tr></thead>
            <tbody><tr v-for="e in p.entry" :key="e.account_id" data-testid="dep-entry-row"><td>{{ e.code }} {{ e.name }}</td><td class="num">{{ fmtMoney(e.debit) }}</td><td class="num">{{ fmtMoney(e.credit) }}</td></tr></tbody>
          </table>
        </div>
      </section>
      <section v-if="data?.runs.length" class="report-section">
        <h2>지난 실행</h2>
        <div class="scroll-x">
          <table class="tbl" data-testid="dep-runs">
            <thead><tr><th>번호</th><th>회계일</th><th class="num">감가상각비</th></tr></thead>
            <tbody><tr v-for="r in data.runs" :key="r.id" class="clickable" tabindex="0" data-testid="dep-run-row" @click="$router.push({ name: 'record', params: { type: 'depreciation_run', id: r.id } })" @keydown.enter="$router.push({ name: 'record', params: { type: 'depreciation_run', id: r.id } })"><td>{{ r.state.number }}</td><td>{{ r.state.date }}</td><td class="num">{{ fmtMoney(r.state.total) }}</td></tr></tbody>
          </table>
        </div>
        <p class="small dim">잘못 실행했으면 그 실행을 열어 이력에서 되돌립니다. 뒤의 실행이 있으면 함께 되돌아갑니다.</p>
      </section>
      <p class="small dim" data-testid="dep-rules">자산 대장은 세법 상각범위액 기준이 기본이고, 달은 사업에 사용한 달부터 온전히 칩니다. 자본적 지출, 재평가, 손상, 세무 조정은 다루지 않습니다.</p>
    </div>
  </div>
</template>

<style scoped>
.foot td { font-weight: 650; border-top: 1px solid var(--line-strong); }
</style>

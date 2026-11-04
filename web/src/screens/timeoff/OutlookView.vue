<script setup lang="ts">
// Will the annual leave people hold be used before it lapses, and what would a different policy give. Both read only the
// ledger, so they answer after the module is off, and both say how little they know: a range, never one number presented as fact.
import { computed, onMounted, ref } from 'vue'
import { fetchModels, type ModelRow } from '../../lib/analytics'
import { messageOf, rpc } from '../../lib/api'
import { timeView } from '../../lib/mode'
import Icon from '../../components/Icon.vue'
import { STATE_COLOR, STATE_LABEL } from '../analytics/fmt'
import LawNotice from '../docs/LawNotice.vue'
import { fmtDays } from './fmt'

interface OutRow { grant_id: string; name: string; department_name: string; granted: number; taken: number; planned: number; waiting: number; remaining: number; valid_to: string; lapse_low: number; lapse_high: number; promote_now: boolean; promotion: { notice_from: string; notice_to: string; designate_by: string; article: string } }
interface Outlook { on: string; band_ready: boolean; based_on: { people_with_pace: number }; totals: { granted: number; remaining: number; lapse_low: number; lapse_high: number; promote_now: number }; people: OutRow[] }
interface WhatIf { on: string; until: string; current_days: number; candidate_days: number; delta: number; low: number; high: number; attrition_per_year: number; indistinguishable: boolean; people: { employee_id: string; name: string; current_days: number; candidate_days: number; delta: number }[] }

const burn = ref<ModelRow | null>(null)
const what = ref<ModelRow | null>(null)
const out = ref<Outlook | null>(null)
const result = ref<WhatIf | null>(null)
const error = ref('')
const whatError = ref('')
const running = ref(false)
const policy = ref({ base_days: 15, max_days: 25, step_years: 2, step_days: 1, monthly_days: 1 })

const asOf = () => timeView.at || null
const locked = computed(() => burn.value?.state === 'locked')

async function load() {
  error.value = ''
  try {
    const models = await fetchModels()
    burn.value = models.find((m) => m.id === 'leave_burn') ?? null
    what.value = models.find((m) => m.id === 'whatif_leave_policy') ?? null
    if (burn.value && !burn.value.forbidden) out.value = await rpc<Outlook>('erp_leave_outlook', { p_on: null, p_as_of: asOf() })
  } catch (e) {
    error.value = messageOf(e)
  }
}
onMounted(load)

async function run() {
  running.value = true
  whatError.value = ''
  try {
    result.value = await rpc<WhatIf>('erp_leave_whatif', { p_policy: policy.value, p_on: null, p_as_of: asOf() })
  } catch (e) {
    whatError.value = messageOf(e)
  } finally {
    running.value = false
  }
}
</script>

<template>
  <div class="page" data-testid="leave-outlook">
    <div class="page-head">
      <div class="crumbs">
        <router-link to="/analytics/models">예측·what-if</router-link><Icon class="muted" name="chevron-right" :size="12" />
        <h1>연차 소진 전망</h1>
        <span v-if="burn" class="pill" :class="`pill-${STATE_COLOR[burn.state]}`" data-testid="outlook-state">{{ STATE_LABEL[burn.state] }}</span>
      </div>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert"><Icon name="alert" /><span class="grow">{{ error }}</span></div>
    <div class="page-body page-pad">
      <LawNotice kind="leave" />
      <section v-if="locked" class="panel" data-testid="outlook-locked"><p>{{ burn?.evidence.message }}</p></section>
      <section v-else-if="burn?.forbidden" class="panel"><p>{{ burn.evidence.message }}</p></section>
      <template v-else-if="out">
        <p v-if="burn?.state === 'insufficient'" class="small dim" data-testid="outlook-short">{{ burn.evidence.message }}. 근거가 모자라 소멸 일수를 0일부터 남은 일수 전부까지의 범위로만 보여 줍니다.</p>
        <p v-if="burn?.stale_modules?.length" class="small dim">{{ burn.evidence.message }}</p>
        <section class="panel" data-testid="outlook-totals">
          <div class="headline">
            <strong data-testid="outlook-lapse">{{ fmtDays(out.totals.lapse_low) }} ~ {{ fmtDays(out.totals.lapse_high) }}</strong>
            <span class="muted small">{{ out.on }} 기준 소멸할 수 있는 일수. 남은 일수 {{ fmtDays(out.totals.remaining) }}. 근거: 사람들의 실제 사용 속도(하위 10%~상위 10%), {{ out.based_on.people_with_pace }}명. 정답을 재서 맞춘 모델이 아닙니다.</span>
          </div>
          <p class="small" data-testid="outlook-promote">지금 제61조 촉구 기간에 든 사람: {{ out.totals.promote_now }}명</p>
        </section>
        <section v-if="out.people.length" class="panel">
          <table class="tbl" data-testid="outlook-table">
            <thead><tr><th>이름</th><th>부서</th><th class="num">부여</th><th class="num">쓴 일수</th><th class="num">남음</th><th>소멸일</th><th>소멸 범위</th><th>제61조</th></tr></thead>
            <tbody>
              <tr v-for="p in out.people" :key="p.grant_id" data-testid="outlook-row" :data-name="p.name">
                <td>{{ p.name }}</td><td>{{ p.department_name }}</td><td class="num">{{ fmtDays(p.granted) }}</td><td class="num">{{ fmtDays(Number(p.taken) + Number(p.planned)) }}</td><td class="num">{{ fmtDays(p.remaining) }}</td><td>{{ p.valid_to }}</td>
                <td>{{ fmtDays(p.lapse_low) }} ~ {{ fmtDays(p.lapse_high) }}</td>
                <td class="small"><span v-if="p.promote_now" class="pill pill-amber" data-testid="outlook-row-promote">촉구 대상</span><div class="muted">{{ p.promotion.article }} {{ p.promotion.notice_from }} ~ {{ p.promotion.notice_to }}, 지정 {{ p.promotion.designate_by }}까지</div></td>
              </tr>
            </tbody>
          </table>
        </section>
        <p class="small dim">촉구는 서면으로 회사가 합니다. 이 화면은 날짜만 알려 주고, 촉구를 했는지는 알지 못합니다.</p>
      </template>

      <section v-if="what && what.state !== 'locked' && !what.forbidden" class="panel" data-testid="whatif-panel">
        <h2>what-if: 부여 정책을 바꾸면 <span class="muted small">앞으로 1년의 부여 일수. 원장을 바꾸지 않습니다</span></h2>
        <form class="whatif" @submit.prevent="run">
          <label class="small">기본 일수 <input v-model.number="policy.base_days" class="input" type="number" min="0" step="1" data-testid="whatif-base" /></label>
          <label class="small">한도 일수 <input v-model.number="policy.max_days" class="input" type="number" min="0" step="1" data-testid="whatif-max" /></label>
          <label class="small">가산 주기(년) <input v-model.number="policy.step_years" class="input" type="number" min="1" step="1" data-testid="whatif-step" /></label>
          <button type="submit" class="btn btn-primary" :disabled="running" data-testid="whatif-run">{{ running ? '계산 중…' : '계산' }}</button>
        </form>
        <p v-if="whatError" class="err-text small" role="alert">{{ whatError }}</p>
        <template v-if="result">
          <p data-testid="whatif-result">
            <template v-if="result.indistinguishable">효과를 구분할 수 없습니다. 지금 {{ fmtDays(result.current_days) }}, 바꾸면 {{ fmtDays(result.candidate_days) }}입니다.</template>
            <template v-else>{{ result.on }}부터 {{ result.until }}까지 지금 정책으로 {{ fmtDays(result.current_days) }}, 바꾸면 {{ fmtDays(result.candidate_days) }}. 변화는 <strong>{{ fmtDays(result.low) }} ~ {{ fmtDays(result.high) }}</strong>입니다.</template>
          </p>
          <p class="small dim">범위는 지난 2년의 퇴사율(연 {{ Math.round(result.attrition_per_year * 1000) / 10 }}%)로 잡았습니다. 출근율은 모두 80% 이상으로 가정합니다.</p>
          <table class="tbl" data-testid="whatif-table">
            <thead><tr><th>이름</th><th class="num">지금</th><th class="num">바꾸면</th><th class="num">차이</th></tr></thead>
            <tbody><tr v-for="p in result.people" :key="p.employee_id" data-testid="whatif-row"><td>{{ p.name }}</td><td class="num">{{ fmtDays(p.current_days) }}</td><td class="num">{{ fmtDays(p.candidate_days) }}</td><td class="num">{{ fmtDays(p.delta) }}</td></tr></tbody>
          </table>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.crumbs { display: flex; align-items: center; gap: 6px; }
.panel { padding: 12px 14px; margin-bottom: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); max-width: 980px; }
.panel h2 { margin-bottom: 8px; }
.headline { display: flex; align-items: baseline; flex-wrap: wrap; gap: 10px; margin-bottom: 8px; }
.headline strong { font-size: 24px; font-weight: 650; font-variant-numeric: tabular-nums; }
.whatif { display: flex; flex-wrap: wrap; align-items: end; gap: 10px; margin-bottom: 8px; }
.whatif label { display: flex; flex-direction: column; gap: 2px; }
.whatif .input { width: 90px; }
</style>

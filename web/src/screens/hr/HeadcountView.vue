<script setup lang="ts">
// Who was here on a day, by department, and how the number moved. Everything comes from the ledger (M8), so this still
// answers after the module is turned off, and it holds no private details because the ledger holds none.
import { computed, onMounted, ref, watch } from 'vue'
import { fetchModels, type ModelRow } from '../../lib/analytics'
import { messageOf, rpc } from '../../lib/api'
import { fmtDay } from '../../lib/format'
import { timeView } from '../../lib/mode'
import { catalogOf } from '../../lib/session'
import Icon from '../../components/Icon.vue'
import { STATE_COLOR, STATE_LABEL } from '../analytics/fmt'

interface Person { id: string; employee_no: string; name: string; job_title: string | null; department_id: string; department_name: string; hire_date: string; leave_date: string | null }
interface Headcount { on: string; total: number; people: Person[]; departments: { department_id: string; name: string; count: number }[] }
interface Month { period: string; hired: number; left: number; headcount: number }

const today = () => timeView.date || fmtDay(new Date().toISOString())
const on = ref(today())
const data = ref<Headcount | null>(null)
const months = ref<Month[]>([])
const model = ref<ModelRow | null>(null)
const error = ref('')
let seq = 0

const canOpen = computed(() => !!catalogOf('employee'))
const ready = computed(() => model.value?.state === 'ready')
const locked = computed(() => model.value?.state === 'locked')

async function load() {
  if (!on.value) return
  const my = ++seq
  error.value = ''
  try {
    const asOf = timeView.at || null
    const end = today()
    const from = `${Number(end.slice(0, 4)) - 2}${end.slice(4, 7)}-01`
    const [count, trend, models] = await Promise.all([
      rpc<Headcount>('erp_headcount', { p_on: on.value, p_as_of: asOf }),
      rpc<{ rows: Month[] }>('erp_headcount_trend', { p_from: from, p_to: end, p_as_of: asOf }),
      fetchModels(),
    ])
    if (my !== seq) return
    data.value = count
    months.value = [...trend.rows].reverse()
    model.value = models.find((m) => m.id === 'stat_headcount') ?? null
  } catch (e) {
    if (my !== seq) return
    data.value = null
    months.value = []
    error.value = messageOf(e)
  }
}
onMounted(load)
watch(on, load)
watch(() => timeView.at, () => { on.value = today(); void load() })
</script>

<template>
  <div class="page" data-testid="headcount">
    <div class="page-head">
      <div class="crumbs">
        <router-link to="/analytics/models">예측·what-if</router-link><Icon class="muted" name="chevron-right" :size="12" />
        <h1>인원 현황</h1>
        <span v-if="model" class="pill" :class="`pill-${STATE_COLOR[model.state]}`" data-testid="headcount-state">{{ STATE_LABEL[model.state] }}</span>
      </div>
    </div>
    <div class="toolbar">
      <label class="small dim" for="headcount-on">이 날의 재직 인원</label>
      <input id="headcount-on" v-model="on" class="input" type="date" style="width: 140px" data-testid="headcount-on" />
      <span v-if="timeView.at" class="muted small" data-testid="headcount-asof">{{ timeView.date }} 까지 원장에 기록된 것으로 셉니다.</span>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert"><Icon name="alert" /><span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" @click="load">다시 시도</button></div>
    <div class="page-body page-pad">
      <section v-if="locked" class="panel" data-testid="headcount-locked">
        <p>{{ model?.evidence.message }}</p>
      </section>
      <template v-else-if="data">
        <p v-if="model?.stale_modules?.length" class="small dim" data-testid="headcount-stale">{{ model.evidence.message }}</p>
        <section class="panel" data-testid="headcount-day">
          <div class="headline"><strong data-testid="headcount-total">{{ data.total }}명</strong><span class="muted small">{{ data.on }} 기준. 입사일과 퇴사일 당일도 재직으로 셉니다.</span></div>
          <table v-if="data.departments.length" class="tbl" data-testid="headcount-departments">
            <thead><tr><th>부서</th><th class="num" style="width: 80px">인원</th></tr></thead>
            <tbody><tr v-for="d in data.departments" :key="d.department_id" data-testid="headcount-department"><td>{{ d.name }}</td><td class="num">{{ d.count }}</td></tr></tbody>
          </table>
          <p v-else class="muted" data-testid="headcount-empty">이 날에는 재직 중인 직원이 없습니다.</p>
        </section>
        <section v-if="data.people.length" class="panel" data-testid="headcount-people">
          <h2>명단</h2>
          <table class="tbl">
            <thead><tr><th>사번</th><th>이름</th><th>부서</th><th>직책</th><th>입사일</th></tr></thead>
            <tbody>
              <tr v-for="p in data.people" :key="p.id" data-testid="headcount-person">
                <td>{{ p.employee_no }}</td>
                <td><router-link v-if="canOpen" :to="{ name: 'record', params: { type: 'employee', id: p.id } }">{{ p.name }}</router-link><template v-else>{{ p.name }}</template></td>
                <td>{{ p.department_name }}</td><td>{{ p.job_title }}</td><td>{{ p.hire_date }}</td>
              </tr>
            </tbody>
          </table>
        </section>
        <section class="panel" data-testid="headcount-trend">
          <h2>인원 추이와 입퇴사 <span class="muted small">최근 2년, 달 끝 기준</span></h2>
          <table v-if="ready && months.length" class="tbl">
            <thead><tr><th>달</th><th class="num">입사</th><th class="num">퇴사</th><th class="num">달 끝 인원</th></tr></thead>
            <tbody><tr v-for="m in months" :key="m.period" data-testid="headcount-month"><td>{{ m.period }}</td><td class="num">{{ m.hired }}</td><td class="num">{{ m.left }}</td><td class="num">{{ m.headcount }}</td></tr></tbody>
          </table>
          <p v-else class="muted" data-testid="headcount-short">{{ model?.evidence.message }}. 추이를 말하기에 아직 짧습니다.</p>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.crumbs { display: flex; align-items: center; gap: 6px; }
.panel { padding: 12px 14px; margin-bottom: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); max-width: 760px; }
.panel h2 { margin-bottom: 8px; }
.headline { display: flex; align-items: baseline; flex-wrap: wrap; gap: 10px; margin-bottom: 10px; }
.headline strong { font-size: 26px; font-weight: 650; font-variant-numeric: tabular-nums; }
</style>

<script setup lang="ts">
// How the helpdesk keeps its promises, read from the ledger (M8): SLA compliance with its band, how long answers and solutions take,
// what is waiting where, and the open tickets as the clock stands now. Below 20 decided tickets the rate is counted, not trusted, and
// the screen says so.
import { computed, onMounted, ref, watch } from 'vue'
import { fetchModels, type ModelRow } from '../../lib/analytics'
import { messageOf, rpc } from '../../lib/api'
import { fmtDateTime, fmtNumber } from '../../lib/format'
import { timeView, writeBlock } from '../../lib/mode'
import { toast } from '../../lib/ui'
import Icon from '../../components/Icon.vue'
import { STATE_COLOR, STATE_LABEL } from '../analytics/fmt'
import { CLOCK, type Sla } from './sla'

interface Rate { decided: number; met?: number; breached: number; rate: number | null; low: number | null; high: number | null; measured?: number; median_hours?: number | null }
interface Stats {
  tickets: number; open: number; with_sla: number; need: number
  sla: Rate; response: Rate; resolve: Rate
  reopened: { tickets: number; reopens: number; solved: number }
  by_stage: { stage: string; label: string; count: number }[]
  by_priority: { priority: string; label: string; count: number; breached: number }[]
  by_type: { name: string; count: number; breached: number }[]
}

const stats = ref<Stats | null>(null)
const open = ref<Sla[]>([])
const models = ref<ModelRow[]>([])
const error = ref('')
const ticking = ref(false)
let seq = 0
const model = computed(() => models.value.find((m) => m.id === 'helpdesk_sla') ?? null)
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '-' : `${Math.round(v * 100)}%`)
// Under an hour reads in minutes: "0시간" would say nothing about a quick answer.
const hrs = (v: number | null | undefined) => {
  if (v === null || v === undefined) return '-'
  const h = Number(v)
  if (h < 1) return Math.round(h * 60) < 1 ? '1분 미만' : `${Math.round(h * 60)}분`
  return `${fmtNumber(Math.round(h * 10) / 10)}시간`
}
const maxStage = computed(() => Math.max(1, ...(stats.value?.by_stage ?? []).map((s) => s.count)))

async function load() {
  const my = ++seq
  error.value = ''
  try {
    const asOf = timeView.at || null
    const [s, o, m] = await Promise.all([
      rpc<Stats>('erp_helpdesk_stats', { p_from: null, p_to: null, p_as_of: asOf }),
      asOf ? Promise.resolve([] as Sla[]) : rpc<Sla[]>('erp_helpdesk_sla', { p_ids: null, p_at: null }),
      fetchModels(),
    ])
    if (my !== seq) return
    stats.value = s
    open.value = o
    models.value = m
  } catch (e) {
    if (my === seq) error.value = messageOf(e)
  }
}
onMounted(load)
watch(() => timeView.at, load)

// The minute job records passed deadlines; this asks it now instead of waiting for it.
async function tickNow() {
  ticking.value = true
  try {
    const r = await rpc<{ breached: number }>('erp_helpdesk_sla_tick', {})
    toast(r.breached ? `기한이 지난 ${r.breached}건을 위반으로 기록했습니다.` : '새로 지난 기한이 없습니다.')
    await load()
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    ticking.value = false
  }
}
</script>

<template>
  <div class="page" data-testid="hd-analysis">
    <div class="page-head">
      <div class="crumbs">
        <router-link to="/analytics/models">예측·what-if</router-link><Icon class="muted" name="chevron-right" :size="12" />
        <h1>헬프데스크 분석</h1>
      </div>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert"><Icon name="alert" /><span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" @click="load">다시 시도</button></div>
    <div v-if="stats" class="page-body page-pad">
      <section class="panel" data-testid="hd-compliance">
        <h2>SLA 준수율 <span v-if="model" class="pill" :class="`pill-${STATE_COLOR[model.state]}`" data-testid="hd-compliance-state">{{ STATE_LABEL[model.state] }}</span></h2>
        <p class="muted small">전체 티켓 {{ stats.tickets }}건, SLA 가 걸린 티켓 {{ stats.with_sla }}건. 기한을 넘겼거나 모든 시계를 마친 티켓만 셉니다. 아직 진행 중인 티켓은 빼고 셉니다.</p>
        <p class="headline" data-testid="hd-compliance-rate">
          <strong>{{ pct(stats.sla.rate) }}</strong>
          <span class="muted small"> 판단한 {{ stats.sla.decided }}건 중 지킴 {{ stats.sla.met }}건 · 위반 {{ stats.sla.breached }}건<template v-if="stats.sla.decided"> · 80% 구간 {{ pct(stats.sla.low) }} ~ {{ pct(stats.sla.high) }}</template></span>
        </p>
        <p v-if="model && model.state !== 'ready'" class="small dim" data-testid="hd-compliance-short">{{ model.evidence.message }}</p>
        <table class="tbl" data-testid="hd-clocks">
          <thead><tr><th>시계</th><th class="num">판단</th><th class="num">위반</th><th class="num">준수율</th><th class="num">걸린 시간(중앙값)</th></tr></thead>
          <tbody>
            <tr data-testid="hd-clock-response"><td>첫 응답</td><td class="num">{{ stats.response.decided }}</td><td class="num">{{ stats.response.breached }}</td><td class="num">{{ pct(stats.response.rate) }}</td><td class="num" data-testid="hd-median-response">{{ hrs(stats.response.median_hours) }} <span class="dim small">({{ stats.response.measured }}건)</span></td></tr>
            <tr data-testid="hd-clock-resolve"><td>해결</td><td class="num">{{ stats.resolve.decided }}</td><td class="num">{{ stats.resolve.breached }}</td><td class="num">{{ pct(stats.resolve.rate) }}</td><td class="num" data-testid="hd-median-resolve">{{ hrs(stats.resolve.median_hours) }} <span class="dim small">({{ stats.resolve.measured }}건)</span></td></tr>
          </tbody>
        </table>
        <p class="small dim" data-testid="hd-reopened">해결한 {{ stats.reopened.solved }}건 중 다시 열린 티켓 {{ stats.reopened.tickets }}건(모두 {{ stats.reopened.reopens }}번).</p>
      </section>

      <section class="panel" data-testid="hd-open">
        <h2>열린 티켓의 SLA
          <button v-if="!timeView.at" type="button" class="btn btn-sm" :disabled="ticking || !!writeBlock" data-testid="hd-tick" @click="tickNow">기한 지금 확인</button>
        </h2>
        <p class="muted small">분마다 지난 기한을 위반으로 기록합니다. 위험은 남은 시간이 목표의 4분의 1 이하입니다.</p>
        <table v-if="open.length" class="tbl" data-testid="hd-open-table">
          <thead><tr><th>티켓</th><th>단계</th><th>SLA</th><th>첫 응답 기한</th><th>해결 기한</th></tr></thead>
          <tbody>
            <tr v-for="t in open" :key="t.id" data-testid="hd-open-row" :data-number="t.number" :data-status="t.status">
              <td><router-link :to="{ name: 'record', params: { type: 'helpdesk_ticket', id: t.id } }">{{ t.number }}</router-link> {{ t.subject }}</td>
              <td>{{ stats.by_stage.find((s) => s.stage === t.stage)?.label ?? t.stage }}</td>
              <td><span class="pill" :class="`pill-${CLOCK[t.status].color}`">{{ CLOCK[t.status].label }}</span></td>
              <td>{{ t.response.due ? fmtDateTime(t.response.due).slice(5, 16) : '' }} <span v-if="t.response.status !== 'none'" class="dim small">{{ CLOCK[t.response.status].label }}</span></td>
              <td>{{ t.resolve.paused ? '멈춤' : t.resolve.due ? fmtDateTime(t.resolve.due).slice(5, 16) : '' }} <span v-if="t.resolve.status !== 'none'" class="dim small">{{ CLOCK[t.resolve.status].label }}</span></td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted" data-testid="hd-open-empty">{{ timeView.at ? '지난 시점에서는 지금의 기한을 보여 주지 않습니다.' : '열린 티켓이 없습니다.' }}</p>
      </section>

      <div class="grid2">
        <section class="panel" data-testid="hd-backlog">
          <h2>단계별 티켓</h2>
          <div v-for="s in stats.by_stage" :key="s.stage" class="bar-row" data-testid="hd-stage" :data-stage="s.stage">
            <span class="bar-label">{{ s.label }}</span><span class="bar"><i :style="{ width: `${(s.count / maxStage) * 100}%` }"></i></span><span class="num">{{ s.count }}</span>
          </div>
        </section>
        <section class="panel" data-testid="hd-by-priority">
          <h2>우선순위별</h2>
          <table class="tbl">
            <thead><tr><th>우선순위</th><th class="num">티켓</th><th class="num">위반</th></tr></thead>
            <tbody><tr v-for="p in stats.by_priority" :key="p.priority" data-testid="hd-priority-row" :data-priority="p.priority"><td>{{ p.label }}</td><td class="num">{{ p.count }}</td><td class="num">{{ p.breached }}</td></tr></tbody>
          </table>
          <h2 style="margin-top: 12px">유형별</h2>
          <table class="tbl" data-testid="hd-by-type">
            <thead><tr><th>유형</th><th class="num">티켓</th><th class="num">위반</th></tr></thead>
            <tbody><tr v-for="t in stats.by_type" :key="t.name" data-testid="hd-type-row"><td>{{ t.name }}</td><td class="num">{{ t.count }}</td><td class="num">{{ t.breached }}</td></tr></tbody>
          </table>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.crumbs { display: flex; align-items: center; gap: 6px; }
.panel { padding: 12px 14px; margin-bottom: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); max-width: 960px; }
.panel h2 { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.headline { margin: 8px 0; }
.headline strong { font-size: 26px; font-weight: 650; font-variant-numeric: tabular-nums; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; max-width: 960px; }
.grid2 .panel { margin-bottom: 0; }
.bar-row { display: grid; grid-template-columns: 70px 1fr 36px; align-items: center; gap: 8px; padding: 3px 0; }
.bar { height: 10px; background: var(--ink-50); border-radius: 5px; overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--navy-600); }
</style>

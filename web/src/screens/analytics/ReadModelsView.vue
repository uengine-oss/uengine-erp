<script setup lang="ts">
// 읽기 모델: what the read side holds, how far behind it is, and two things an admin can do. Rebuild throws a model away
// and fills it again from the first event. Compare asks one question both ways and times each.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { messageOf } from '../../lib/api'
import { fmtBytes, fmtDateTime, fmtNumber, josa } from '../../lib/format'
import { agoText, compareReadModels, readModelStatus, rebuildReadModels, tickReadModels, type Comparison, type ModelStatus, type ReadModelStatus } from '../../lib/readModels'
import { isAdmin } from '../../lib/session'
import { ask, toast } from '../../lib/ui'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'
import LoadError from '../../components/LoadError.vue'
import { fmtMoneyPlain } from './fmt'

const admin = computed(() => isAdmin())
const status = shallowRef<ReadModelStatus | null>(null)
const error = ref('')
const busy = ref('')
const left = ref(0)
const compared = shallowRef<Comparison | null>(null)
const comparing = ref(false)
const nowMs = ref(Date.now())

async function load() {
  if (!admin.value) return
  try {
    status.value = await readModelStatus(true)
    error.value = ''
  } catch (e) { error.value = messageOf(e) }
}

let every: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  void load()
  every = setInterval(() => { nowMs.value = Date.now(); if (!busy.value && !document.hidden) void load() }, 5000)
})
onBeforeUnmount(() => clearInterval(every))
watch(admin, (v) => { if (v) void load() })

const secs = (ms: number | null | undefined) => (ms === null || ms === undefined ? '-' : ms < 1000 ? `${fmtNumber(Math.round(ms))} ms` : `${fmtNumber(Math.round(ms / 100) / 10)}초`)
const stateOf = (m: ModelStatus): { text: string; color: string } => {
  if (m.failures > 0) return { text: '멈춤', color: 'red' }
  if (m.reset_at && !m.rebuilt_at) return { text: '다시 만드는 중', color: 'amber' }
  if (m.behind > 0) return { text: '반영 대기', color: 'amber' }
  return { text: '최신', color: 'green' }
}

async function rebuild(m: ModelStatus | null) {
  const what = m ? m.label : '모든 읽기 모델'
  const answer = await ask({
    title: `${what} 다시 만들기`,
    message: '지금 가진 행을 비우고 원장의 첫 이벤트부터 다시 채웁니다. 원장은 바뀌지 않습니다. 다 채울 때까지 현황판의 숫자가 모자랄 수 있습니다.',
    confirmLabel: '다시 만들기',
  })
  if (!answer) return
  busy.value = m?.name ?? 'all'
  const t0 = performance.now()
  try {
    await rebuildReadModels(m?.name ?? null)
    for (;;) {
      const st = await readModelStatus(true)
      status.value = st
      const mine = st.models.filter((x) => !m || x.name === m.name)
      if (mine.some((x) => x.failures > 0)) throw new Error(mine.find((x) => x.failures > 0)?.last_error ?? '반영이 멈췄습니다')
      left.value = mine.reduce((a, x) => a + x.behind, 0)
      if (left.value === 0) break
      await tickReadModels(4000)
    }
    const work = (status.value?.models ?? []).filter((x) => !m || x.name === m.name).reduce((a, x) => a + Number(x.rebuild_ms ?? 0), 0)
    toast(`${josa(what, '을', '를')} 다시 만들었습니다. ${secs(performance.now() - t0)} 걸렸습니다(계산 ${secs(work)}).`)
  } catch (e) {
    toast(e instanceof Error && !('code' in e) ? e.message : messageOf(e), 'error')
  } finally {
    busy.value = ''
    left.value = 0
    await load()
  }
}

async function compare() {
  comparing.value = true
  try {
    compared.value = await compareReadModels(12)
  } catch (e) { toast(messageOf(e), 'error') } finally { comparing.value = false }
}
const ratio = computed(() => {
  const c = compared.value
  if (!c || !Number(c.read_model.ms)) return ''
  const r = Number(c.ledger.ms) / Number(c.read_model.ms)
  return r >= 1.5 ? `${fmtNumber(Math.round(r))}배 빠릅니다` : ''
})
const ledgerOf = (month: string) => compared.value?.ledger.rows.find((r) => r.month === month)?.revenue
</script>

<template>
  <div class="page" data-testid="read-models">
    <div class="page-head">
      <h1>읽기 모델</h1>
      <span class="muted small head-note">원장의 이벤트를 받는 대로 미리 모아 둔 숫자입니다. 언제든 비우고 처음부터 다시 만들 수 있습니다.</span>
      <div class="grow"></div>
      <template v-if="admin">
        <button type="button" class="btn" :disabled="comparing || !!busy" data-testid="rm-compare" @click="compare"><Icon name="analytics" :size="13" />비교</button>
        <button type="button" class="btn" :disabled="!!busy" data-testid="rm-rebuild-all" @click="rebuild(null)">모두 다시 만들기</button>
        <button type="button" class="btn" :disabled="!!busy" data-testid="rm-refresh" @click="load"><Icon name="refresh" :size="13" />새로 고침</button>
      </template>
    </div>
    <div v-if="!admin" class="page-body">
      <EmptyState title="관리자만 볼 수 있습니다" text="읽기 모델의 상태와 다시 만들기는 관리자가 다룹니다." />
    </div>
    <template v-else>
      <LoadError :message="error" @retry="load" />
      <div v-if="status && !status.cron" class="banner banner-info banner-flush" data-testid="rm-no-cron">
        <Icon name="info" /><span class="grow">이 프로젝트에는 pg_cron 이 없어, 화면이 열려 있을 때 반영합니다.</span>
      </div>
      <div class="page-body page-pad">
        <p v-if="busy" class="small" data-testid="rm-progress"><Icon name="refresh" :size="12" /> 다시 만드는 중입니다. 남은 이벤트 {{ left.toLocaleString('ko-KR') }}건</p>
        <div v-if="status" class="scroll">
          <table class="tbl" data-testid="rm-table">
            <thead><tr><th>모델</th><th>상태</th><th class="num">반영 대기</th><th>마지막으로 반영한 이벤트</th><th>마지막 반영</th><th class="num">행</th><th class="num">크기</th><th>다시 만든 때</th><th></th></tr></thead>
            <tbody>
              <tr v-for="m in status.models" :key="m.name" data-testid="rm-row" :data-name="m.name">
                <td><strong>{{ m.label }}</strong> <code class="muted small">{{ m.name }}</code></td>
                <td><span class="pill" :class="`pill-${stateOf(m).color}`" data-testid="rm-state">{{ stateOf(m).text }}</span></td>
                <td class="num" data-testid="rm-behind">{{ m.behind.toLocaleString('ko-KR') }}건</td>
                <td :title="fmtDateTime(m.last_event_at)">{{ agoText(m.last_event_at, nowMs) }}</td>
                <td :title="fmtDateTime(m.refreshed_at)">{{ m.refreshed_at ? `${agoText(m.refreshed_at, nowMs)} · 이벤트 ${(m.refresh_events ?? 0).toLocaleString('ko-KR')}건, ${secs(m.refresh_ms)}` : '-' }}</td>
                <td class="num" data-testid="rm-rows">{{ (m.rows ?? 0).toLocaleString('ko-KR') }}</td>
                <td class="num">{{ fmtBytes(m.bytes ?? 0) }}</td>
                <td data-testid="rm-rebuilt">{{ m.rebuilt_at ? `${fmtDateTime(m.rebuilt_at)} · 계산 ${secs(m.rebuild_ms)}` : m.reset_at ? '다시 만드는 중' : '-' }}</td>
                <td><button type="button" class="btn btn-sm" :disabled="!!busy" data-testid="rm-rebuild" @click="rebuild(m)">다시 만들기</button></td>
              </tr>
            </tbody>
          </table>
          <p v-for="m in status.models.filter((x) => x.failures > 0)" :key="m.name" class="stall small" data-testid="rm-error">{{ m.label }}: {{ m.last_error }}</p>
        </div>

        <section v-if="compared" class="panel" data-testid="rm-comparison">
          <h2>최근 12개월 월별 매출, 두 가지로 읽기</h2>
          <dl class="duel">
            <div><dt>읽기 모델</dt><dd data-testid="rm-ms-model">{{ fmtNumber(Number(compared.read_model.ms)) }} ms</dd></div>
            <div><dt>원장에서 계산</dt><dd data-testid="rm-ms-ledger">{{ fmtNumber(Number(compared.ledger.ms)) }} ms</dd></div>
            <div><dt>결과</dt><dd data-testid="rm-same" :class="compared.same ? 'ok' : 'bad'">{{ compared.same ? '같은 값입니다' : '값이 다릅니다' }}<template v-if="ratio"> · {{ ratio }}</template></dd></div>
          </dl>
          <p class="muted small">원장 쪽은 이벤트 {{ Number(compared.events).toLocaleString('ko-KR') }}건에서 주문을 다시 계산합니다. 읽기 모델은 미리 모아 둔 행에서 더하기만 합니다.<template v-if="compared.behind"> 반영 대기 {{ compared.behind }}건이 있어 값이 다를 수 있습니다.</template></p>
          <details class="small">
            <summary>월별 값</summary>
            <table class="tbl months">
              <thead><tr><th>월</th><th class="num">읽기 모델</th><th class="num">원장</th></tr></thead>
              <tbody><tr v-for="r in compared.read_model.rows" :key="r.month"><td>{{ r.month }}</td><td class="num">{{ fmtMoneyPlain(Number(r.revenue)) }}</td><td class="num">{{ ledgerOf(r.month) === undefined ? '-' : fmtMoneyPlain(Number(ledgerOf(r.month))) }}</td></tr></tbody>
            </table>
          </details>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.scroll { overflow-x: auto; }
.panel { margin-top: 16px; padding: 10px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); max-width: 900px; }
.panel h2 { margin-bottom: 8px; font-size: 13px; }
.duel { display: flex; flex-wrap: wrap; gap: 8px 28px; margin: 0 0 8px; }
.duel dt { color: var(--text-2); font-size: 12px; }
.duel dd { margin: 0; font-size: 18px; font-weight: 650; font-variant-numeric: tabular-nums; }
.duel dd.ok { color: var(--green-fg); }
.duel dd.bad { color: var(--red-fg); }
.months { margin-top: 6px; max-width: 420px; }
.stall { margin-top: 8px; padding: 6px 8px; background: var(--red-bg); border: 1px solid var(--red-line); border-radius: var(--radius-sm); color: var(--red-fg); overflow-wrap: anywhere; }
@media (max-width: 720px) { .head-note { display: none; } }
</style>

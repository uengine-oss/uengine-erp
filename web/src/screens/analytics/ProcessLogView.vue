<script setup lang="ts">
// The ledger as a process-mining event log: cases, events and the most common flows, and the files a mining tool or Process GPT reads.
// Files are built here from the same pages the preview counts, so what is downloaded is what is shown.
import { computed, onMounted, ref, watch } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { LABELS } from '../../lib/eventLabels'
import { fmtDay } from '../../lib/format'
import { timeView } from '../../lib/mode'
import { session } from '../../lib/session'
import { copyText, saveBlob, toast } from '../../lib/ui'
import { NOTIONS, fileName, fmtSpan, loadProcessLog, stats, toCsv, toOcel, toXes, variantSummary, type PlLog } from '../../lib/processLog'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'

const today = () => timeView.date || fmtDay(new Date().toISOString())
const yearBack = (day: string) => `${Number(day.slice(0, 4)) - 1}${day.slice(4)}`

const notion = ref('sales_order')
const docType = ref('')
const to = ref(today())
const from = ref(yearBack(to.value))
const major = ref(true)
const log = ref<PlLog | null>(null)
const loading = ref(false)
const progress = ref({ rows: 0, cases: 0 })
const error = ref('')
let seq = 0

const query = computed(() => (notion.value === 'document' && docType.value ? `document:${docType.value}` : notion.value))
const typeOptions = computed(() => session.catalog.filter((c) => !c.hidden).map((c) => ({ value: c.type, label: c.label })))
const notions = computed(() => NOTIONS.filter((n) => !n.needs || session.catalog.some((c) => c.type === n.needs)))

async function load() {
  if (!from.value || !to.value) return
  const my = ++seq
  loading.value = true
  error.value = ''
  progress.value = { rows: 0, cases: 0 }
  try {
    const got = await loadProcessLog(
      (fn, args) => rpc(fn, { ...args, p_as_of: timeView.at || null }),
      { notion: query.value, from: from.value, to: to.value, major: major.value },
      (rows, cases) => { if (my === seq) progress.value = { rows, cases } },
      () => my !== seq,
    )
    if (my !== seq) return
    log.value = got
  } catch (e) {
    if (my !== seq) return
    log.value = null
    error.value = messageOf(e)
  } finally {
    if (my === seq) loading.value = false
  }
}
onMounted(load)
watch([query, from, to, major], load)
watch(() => timeView.at, () => { to.value = today(); from.value = yearBack(to.value) })

const summary = computed(() => (log.value ? stats(log.value.rows) : null))
const top = computed(() => summary.value?.variants.slice(0, 10) ?? [])
const notionHint = computed(() => NOTIONS.find((n) => n.value === notion.value)?.hint ?? '')
const leftOut = LABELS.minor.map((m) => m.name).join(', ')
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const logName = computed(() => `${session.company?.state?.name ?? 'uEngine ERP'} ${NOTIONS.find((n) => n.value === notion.value)?.label ?? ''} ${from.value}~${to.value}`)

function download(kind: 'csv' | 'xes' | 'ocel') {
  if (!log.value) return
  const name = fileName(query.value, from.value, to.value, kind === 'ocel' ? 'ocel.json' : kind)
  if (kind === 'csv') saveBlob(new Blob([toCsv(log.value.rows)], { type: 'text/csv;charset=utf-8' }), name)
  else if (kind === 'xes') saveBlob(new Blob([toXes(log.value.rows, logName.value)], { type: 'application/xml' }), name)
  else saveBlob(new Blob([JSON.stringify(toOcel(log.value))], { type: 'application/json' }), name)
}

const copied = ref('')
async function copySummary() {
  if (!summary.value) return
  const text = variantSummary(summary.value, { notion: notion.value, from: from.value, to: to.value })
  if (await copyText(text)) { copied.value = text; toast('변형 요약을 복사했습니다. Process GPT 의 프로세스 생성 대화에 붙여 넣으세요.') }
  else toast('복사하지 못했습니다. 브라우저가 클립보드를 막았습니다.', 'error')
}
</script>

<template>
  <div class="page" data-testid="process-log">
    <div class="page-head">
      <h1>프로세스 마이닝 로그</h1>
      <span class="muted small">원장을 사례별 이벤트 로그로 내려받아 프로세스 마이닝 도구나 Process GPT 에 올립니다.</span>
    </div>
    <div class="toolbar row-wrap">
      <div class="seg" role="group" aria-label="사례 묶음">
        <button v-for="n in notions" :key="n.value" type="button" :class="{ on: notion === n.value }" :aria-pressed="notion === n.value" :data-testid="`pl-notion-${n.value}`" @click="notion = n.value">{{ n.label }}</button>
      </div>
      <select v-if="notion === 'document'" v-model="docType" class="select" style="width: 150px" aria-label="문서 유형" data-testid="pl-doc-type">
        <option value="">모든 유형</option>
        <option v-for="o in typeOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
      <input v-model="from" class="input" type="date" style="width: 130px" aria-label="시작일" data-testid="pl-from" />
      <span class="muted">~</span>
      <input v-model="to" class="input" type="date" style="width: 130px" aria-label="종료일" data-testid="pl-to" />
      <label class="check small dim" :title="`빼는 것: ${leftOut}`"><input v-model="major" type="checkbox" data-testid="pl-major" /> 주요 활동만</label>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert" data-testid="pl-error">
      <Icon name="alert" /><span class="grow">{{ error }}</span><button type="button" class="btn btn-sm" @click="load">다시 시도</button>
    </div>
    <div class="page-body page-pad">
      <p class="muted small hint" data-testid="pl-hint">{{ notionHint }} 기간은 사례가 시작한 날로 고르고, 그 사례의 뒤 이벤트도 모두 싣습니다.<template v-if="major"> 주요 활동만 보면 {{ leftOut }} 기록은 뺍니다.</template></p>
      <div v-if="loading" class="progress" data-testid="pl-progress">
        <span class="small dim">원장을 읽는 중입니다. 사례 {{ progress.cases.toLocaleString('ko-KR') }}건, 이벤트 {{ progress.rows.toLocaleString('ko-KR') }}건</span>
        <div class="meter indeterminate" role="progressbar" aria-label="읽는 중"><i></i></div>
      </div>
      <template v-if="summary && summary.cases && !loading">
        <dl class="tiles" data-testid="pl-counts">
          <div><dt>사례</dt><dd data-testid="pl-cases">{{ summary.cases.toLocaleString('ko-KR') }}건</dd></div>
          <div><dt>이벤트</dt><dd data-testid="pl-events">{{ summary.events.toLocaleString('ko-KR') }}건</dd></div>
          <div><dt>활동</dt><dd data-testid="pl-activities">{{ summary.activities }}가지</dd></div>
          <div><dt>변형</dt><dd data-testid="pl-variants">{{ summary.variants.length.toLocaleString('ko-KR') }}가지</dd></div>
        </dl>
        <div class="actions">
          <button type="button" class="btn" data-testid="pl-csv" @click="download('csv')"><Icon name="download" />CSV</button>
          <button type="button" class="btn" data-testid="pl-xes" @click="download('xes')"><Icon name="download" />XES</button>
          <button type="button" class="btn" data-testid="pl-ocel" @click="download('ocel')"><Icon name="download" />OCEL 2.0</button>
          <button type="button" class="btn btn-primary" data-testid="pl-copy" @click="copySummary"><Icon name="copy" />변형 요약 복사</button>
        </div>
        <section class="panel">
          <h2>자주 나온 흐름</h2>
          <div class="scroll">
            <table class="tbl" data-testid="pl-top">
              <thead><tr><th class="num" style="width: 32px">#</th><th>활동 순서</th><th class="num">사례</th><th class="num">비율</th><th class="num nowrap">걸린 시간(중앙값)</th></tr></thead>
              <tbody>
                <tr v-for="(v, i) in top" :key="i" data-testid="pl-variant">
                  <td class="num muted">{{ i + 1 }}</td>
                  <td class="flow wrap"><template v-for="(a, j) in v.activities" :key="j"><span v-if="j" class="arrow" aria-hidden="true">→</span><span class="step">{{ a }}</span></template></td>
                  <td class="num">{{ v.count.toLocaleString('ko-KR') }}</td>
                  <td class="num">{{ pct(v.share) }}</td>
                  <td class="num nowrap">{{ fmtSpan(v.medianMs) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="summary.variants.length > top.length" class="muted small more">그 밖의 흐름 {{ (summary.variants.length - top.length).toLocaleString('ko-KR') }}가지는 파일에 모두 들어 있습니다.</p>
        </section>
        <section v-if="copied" class="panel">
          <h2>복사한 내용</h2>
          <pre class="copied" data-testid="pl-copied">{{ copied }}</pre>
        </section>
      </template>
      <EmptyState v-else-if="!loading && !error && log" title="이 기간에 시작한 사례가 없습니다" text="기간을 넓히거나 다른 묶음을 골라 보세요. 역할에 따라 읽을 수 없는 문서는 사례에 들어가지 않습니다." />
    </div>
  </div>
</template>

<style scoped>
.hint { margin: 0 0 10px; max-width: 760px; }
.progress { display: flex; flex-direction: column; gap: 4px; max-width: 520px; margin-bottom: 12px; }
.meter.indeterminate i { width: 30%; animation: slide 1.2s ease-in-out infinite; }
@keyframes slide { from { margin-left: 0; } to { margin-left: 70%; } }
@media (prefers-reduced-motion: reduce) { .meter.indeterminate i { animation: none; width: 100%; opacity: 0.4; } }
.tiles { display: flex; flex-wrap: wrap; gap: 8px 28px; margin: 0 0 12px; }
.tiles dt { color: var(--text-2); font-size: 12px; }
.tiles dd { margin: 0; font-size: 18px; font-weight: 650; font-variant-numeric: tabular-nums; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.panel { margin-bottom: 12px; padding: 10px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); min-width: 0; }
.panel h2 { margin-bottom: 8px; font-size: 13px; }
.panel .tbl th { position: static; }
.scroll { overflow-x: auto; }
.flow { line-height: 1.9; }
.step { display: inline-block; padding: 0 6px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--ink-50); white-space: nowrap; font-size: 12px; line-height: 20px; }
.arrow { margin: 0 4px; color: var(--text-3, var(--text-2)); }
.more { margin: 6px 0 0; }
.copied { margin: 0; padding: 8px 10px; font-family: inherit; background: var(--ink-50); border: 1px solid var(--line); border-radius: var(--radius); font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
</style>

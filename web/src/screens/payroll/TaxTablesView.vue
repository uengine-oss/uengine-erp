<script setup lang="ts">
// The simplified tax table is data a company enters from the official file, with where it came from. None ships with the app.
// The file is read here and sent as rows; a table never changes once entered, and a new one starts on its own date.
import { computed, onMounted, ref } from 'vue'
import { messageOf } from '../../lib/api'
import { onDataChanged, sendCommand } from '../../lib/commands'
import { db } from '../../lib/conn'
import { rows as readRows } from '../../lib/load'
import { writeBlock } from '../../lib/mode'
import { readSheet } from '../../lib/spreadsheet'
import type { State } from '../../lib/types'
import { toast } from '../../lib/ui'
import Icon from '../../components/Icon.vue'
import LoadError from '../../components/LoadError.vue'

interface Row { id: string; name: string; active: boolean; state: State }
const tables = ref<Row[]>([])
const error = ref('')
const busy = ref(false)
const parseError = ref('')
const form = ref({ name: '', valid_from: '', source: '', source_url: '', checked_on: '', child_credit_one: '', child_credit_two: '', child_credit_more: '', collect_floor: '', unit: '1000', brackets: '' })
const parsed = ref<{ rows: number[][]; top_income: number | null; top_taxes: number[] | null; skipped: number } | null>(null)
const canWrite = computed(() => !writeBlock.value)
const ready = computed(() => !!parsed.value && parsed.value.rows.length > 0 && !!form.value.name.trim() && !!form.value.valid_from && !!form.value.source.trim() && !!form.value.checked_on)

async function load() {
  error.value = ''
  try {
    tables.value = await readRows<Row>(db().from('erp_records').select('id,name,active,state').eq('type', 'payroll_tax_table').order('name'))
  } catch (e) {
    error.value = messageOf(e)
  }
}
onMounted(load)
onDataChanged(load)

const num = (v: string) => { const t = String(v ?? '').replace(/[,\s]/g, ''); if (t === '-' || t === '') return 0; const n = Number(t); return Number.isFinite(n) ? n : null }

/** Columns in order: from, under, then family of one to eleven. A row with no "under" is the top row. Anything else, such as a heading, is left out and counted. */
async function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  parsed.value = null
  parseError.value = ''
  if (!file) return
  try {
    const sheet = await readSheet(file)
    const unit = Number(form.value.unit)
    const all = [sheet.headers, ...sheet.rows.map((r) => sheet.headers.map((h) => r[h] ?? ''))]
    const rows: number[][] = []
    let topIncome: number | null = null
    let topTaxes: number[] | null = null
    let skipped = 0
    for (const r of all) {
      const cells = r.map((c) => String(c).trim())
      const taxes = cells.slice(2, 13).map(num)
      const lo = /^[\d,]+$/.test(cells[0] ?? '') ? num(cells[0]) : null
      if (lo === null || taxes.length !== 11 || taxes.some((t) => t === null)) { skipped++; continue }
      if (cells[1] === '') { topIncome = lo * unit; topTaxes = taxes as number[]; continue }
      if (!/^[\d,]+$/.test(cells[1])) { skipped++; continue }
      rows.push([lo * unit, (num(cells[1]) as number) * unit, ...(taxes as number[])])
    }
    if (!rows.length) { parseError.value = '읽을 수 있는 줄이 없습니다. 열 순서는 이상, 미만, 가족 1~11명입니다.'; return }
    parsed.value = { rows, top_income: topIncome, top_taxes: topTaxes, skipped }
  } catch {
    parseError.value = '파일을 읽지 못했습니다. CSV 또는 XLSX 로 저장해 다시 넣으세요.'
  }
}

/** One bracket a line: over, up to (empty at the end), add, share of the excess in per cent, rate in per cent. */
function brackets(): State[] {
  return form.value.brackets.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [over, upto, add, ratio, rate] = l.split(',').map((x) => x.trim())
    return { over: num(over), upto: upto ? num(upto) : null, add: num(add), ratio: num(ratio), rate: num(rate) }
  })
}

async function save() {
  if (!parsed.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await sendCommand({ type: 'payroll_tax_table', command: 'create', payload: {
      name: form.value.name.trim(), valid_from: form.value.valid_from, source: form.value.source.trim(), source_url: form.value.source_url.trim() || null, checked_on: form.value.checked_on,
      rows: parsed.value.rows, top_income: parsed.value.top_income, top_taxes: parsed.value.top_taxes, brackets: brackets(),
      child_credit_one: num(form.value.child_credit_one), child_credit_two: num(form.value.child_credit_two), child_credit_more: num(form.value.child_credit_more), collect_floor: num(form.value.collect_floor),
    } })
    toast('세액표를 넣었습니다.')
    parsed.value = null
    form.value = { ...form.value, name: '', valid_from: '', source: '', source_url: '', checked_on: '', brackets: '' }
    await load()
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page" data-testid="tax-tables">
    <div class="page-head"><h1>간이세액표</h1></div>
    <p class="banner banner-warn banner-flush small" data-testid="tax-table-note"><Icon name="alert" /><span>제품에는 세액표가 들어 있지 않습니다. 소득세법 시행령 별표 2 나 국세청이 낸 파일을 회사가 확인해 넣습니다. 전문가 검수 전이며, 신고 책임은 회사에 있습니다.</span></p>
    <LoadError v-if="error" :message="error" @retry="load" />
    <div class="page-body page-pad">
      <table v-if="tables.length" class="tbl" data-testid="tax-table-list">
        <thead><tr><th>자료</th><th>시작일</th><th>출처</th><th>확인한 날</th><th class="num">줄 수</th><th>내용 해시</th></tr></thead>
        <tbody>
          <tr v-for="t in tables" :key="t.id" data-testid="tax-table-row">
            <td>{{ t.name }}</td><td>{{ t.state.valid_from }}</td><td><a v-if="t.state.source_url" :href="t.state.source_url" target="_blank" rel="noreferrer noopener">{{ t.state.source }}</a><template v-else>{{ t.state.source }}</template></td>
            <td>{{ t.state.checked_on }}</td><td class="num" data-testid="tax-table-rows">{{ t.state.rows_count }}</td><td class="small dim">{{ String(t.state.sha256 ?? '').slice(0, 12) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted" data-testid="tax-table-empty">아직 넣은 세액표가 없습니다. 없으면 소득세 칸은 대장에서 직접 입력해야 합니다.</p>

      <section v-if="canWrite" class="panel" data-testid="tax-table-import">
        <h2>세액표 넣기</h2>
        <div class="field-grid">
          <label class="field"><span class="field-label">자료 이름</span><input v-model="form.name" class="input" data-testid="tt-name" /></label>
          <label class="field"><span class="field-label">시작일</span><input v-model="form.valid_from" class="input" type="date" data-testid="tt-valid-from" /></label>
          <label class="field"><span class="field-label">출처</span><input v-model="form.source" class="input" data-testid="tt-source" /></label>
          <label class="field"><span class="field-label">출처 주소</span><input v-model="form.source_url" class="input" data-testid="tt-source-url" /></label>
          <label class="field"><span class="field-label">확인한 날</span><input v-model="form.checked_on" class="input" type="date" data-testid="tt-checked-on" /></label>
          <label class="field"><span class="field-label">월급여 칸 단위</span><select v-model="form.unit" class="select" data-testid="tt-unit"><option value="1000">천 원</option><option value="1">원</option></select></label>
          <label class="field"><span class="field-label">자녀 1명 공제</span><input v-model="form.child_credit_one" class="input" inputmode="numeric" data-testid="tt-child-one" /></label>
          <label class="field"><span class="field-label">자녀 2명 공제</span><input v-model="form.child_credit_two" class="input" inputmode="numeric" data-testid="tt-child-two" /></label>
          <label class="field"><span class="field-label">자녀 2명 초과 1명당</span><input v-model="form.child_credit_more" class="input" inputmode="numeric" data-testid="tt-child-more" /></label>
          <label class="field"><span class="field-label">소액 부징수 기준</span><input v-model="form.collect_floor" class="input" inputmode="numeric" data-testid="tt-floor" /></label>
        </div>
        <label class="field"><span class="field-label">표 파일 (CSV, XLSX)</span><input class="input" type="file" accept=".csv,.xlsx" data-testid="tt-file" @change="onFile" /></label>
        <p class="small dim">열 순서: 이상, 미만, 가족 1~11명. "-" 는 0 입니다. 미만을 비운 줄은 최고 구간입니다. 제목 줄처럼 숫자가 아닌 줄은 건너뜁니다.</p>
        <label class="field"><span class="field-label">최고 구간 위의 계산식</span>
          <textarea v-model="form.brackets" class="textarea" rows="3" placeholder="초과, 이하, 더할 금액, 초과분에 적용할 비율(%), 세율(%)" data-testid="tt-brackets"></textarea></label>
        <p v-if="parseError" class="err-text small" role="alert" data-testid="tt-parse-error">{{ parseError }}</p>
        <p v-if="parsed" class="small" data-testid="tt-parsed">{{ parsed.rows.length }}줄을 읽었습니다<template v-if="parsed.top_income">. 최고 구간 {{ parsed.top_income.toLocaleString('ko-KR') }}원</template><template v-if="parsed.skipped">. 건너뛴 줄 {{ parsed.skipped }}개</template>.</p>
        <button type="button" class="btn btn-primary" :disabled="!ready || busy" data-testid="tt-save" @click="save">{{ busy ? '넣는 중…' : '세액표 넣기' }}</button>
      </section>
    </div>
  </div>
</template>

<style scoped>
.panel { margin-top: 14px; padding: 12px 14px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); max-width: 760px; display: grid; gap: 8px; }
.textarea { width: 100%; }
</style>

<script setup lang="ts">
// Who is away on which days: names and dates and nothing else, because the database hands over nothing else. Kinds of leave and
// reasons can say something about a person's health or family, and the team does not need them to plan a week.
import { computed, onMounted, ref, watch } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { onDataChanged } from '../../lib/commands'
import { db } from '../../lib/conn'
import { hasRole } from '../../lib/session'
import Icon from '../../components/Icon.vue'

interface Row { name: string; date_from: string; date_to: string }
interface Cal { rows: Row[]; linked: boolean; all?: boolean }

const staff = computed(() => hasRole(['hr']))
const now = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())
const month = ref(now.slice(0, 7))
const department = ref('')
const departments = ref<{ id: string; name: string }[]>([])
const cal = ref<Cal | null>(null)
const error = ref('')
let seq = 0

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
const bounds = computed(() => {
  const [y, m] = month.value.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { y, m, last, from: iso(y, m, 1), to: iso(y, m, last), firstDow: new Date(Date.UTC(y, m - 1, 1)).getUTCDay() }
})
const cells = computed(() => {
  const b = bounds.value
  const out: ({ date: string; day: number; dow: number; names: string[] } | null)[] = Array.from({ length: b.firstDow }, () => null)
  for (let d = 1; d <= b.last; d++) {
    const date = iso(b.y, b.m, d)
    out.push({ date, day: d, dow: (b.firstDow + d - 1) % 7, names: (cal.value?.rows ?? []).filter((r) => r.date_from <= date && r.date_to >= date).map((r) => r.name) })
  }
  return out
})

async function load() {
  const my = ++seq
  error.value = ''
  try {
    const res = await rpc<Cal>('erp_team_calendar', { p_from: bounds.value.from, p_to: bounds.value.to, p_department: department.value || null })
    if (my === seq) cal.value = res
  } catch (e) {
    if (my === seq) error.value = messageOf(e)
  }
}
function shift(n: number) {
  const b = bounds.value
  const d = new Date(Date.UTC(b.y, b.m - 1 + n, 1))
  month.value = d.toISOString().slice(0, 7)
}
onMounted(async () => {
  await load()
  if (staff.value) {
    const { data } = await db().from('erp_records').select('id,name').eq('type', 'department').eq('active', true).order('name')
    departments.value = (data ?? []) as { id: string; name: string }[]
  }
})
onDataChanged(load)
watch([month, department], load)
</script>

<template>
  <div class="page" data-testid="team-calendar">
    <div class="page-head"><h1>팀 달력</h1></div>
    <div class="toolbar">
      <button type="button" class="btn btn-sm" aria-label="이전 달" data-testid="calendar-prev" @click="shift(-1)"><Icon name="chevron-left" :size="14" /></button>
      <strong data-testid="calendar-month">{{ month }}</strong>
      <button type="button" class="btn btn-sm" aria-label="다음 달" data-testid="calendar-next" @click="shift(1)"><Icon name="chevron-right" :size="14" /></button>
      <select v-if="staff" v-model="department" class="input" style="width: 160px" aria-label="부서" data-testid="calendar-department"><option value="">전체 부서</option><option v-for="d in departments" :key="d.id" :value="d.id">{{ d.name }}</option></select>
      <span class="small dim" data-testid="calendar-note">{{ staff ? '승인된 휴가를 이름과 날짜만 보여 줍니다.' : '내 부서와 내 부하 직원의 승인된 휴가를 이름과 날짜만 보여 줍니다.' }}</span>
    </div>
    <div v-if="error" class="banner banner-error banner-flush" role="alert"><Icon name="alert" /><span class="grow">{{ error }}</span></div>
    <div class="page-body page-pad">
      <p v-if="cal && !cal.linked && !staff" class="muted" data-testid="calendar-unlinked">이 계정에 연결된 직원이 없어 팀을 알 수 없습니다.</p>
      <div class="grid head"><div v-for="w in ['일', '월', '화', '수', '목', '금', '토']" :key="w" class="dow">{{ w }}</div></div>
      <div class="grid">
        <template v-for="(c, i) in cells" :key="i">
          <div v-if="c" class="cell" :class="{ weekend: c.dow === 0 || c.dow === 6 }" data-testid="calendar-day" :data-date="c.date">
            <span class="num small dim">{{ c.day }}</span>
            <span v-for="n in c.names" :key="n" class="who small" data-testid="calendar-name">{{ n }}</span>
          </div>
          <div v-else class="cell blank"></div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); max-width: 1000px; }
.head { border-bottom: 0; }
.dow { padding: 4px 6px; background: var(--navy-50); text-align: center; font-size: 12px; }
.cell { min-height: 76px; padding: 4px 6px; background: var(--surface); display: flex; flex-direction: column; gap: 2px; }
.cell.weekend { background: var(--navy-50); }
.cell.blank { background: transparent; }
.who { padding: 0 4px; border-radius: 3px; background: var(--green-50, #e8f5ec); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.num { text-align: right; }
</style>

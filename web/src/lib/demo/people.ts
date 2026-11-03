// The people of the made-up company. This story has its own random stream and is merged in by day, so turning it on or
// changing it cannot move a single sale: the what-if figures quoted in the tutorials stay what they were.
import { isoOf, rng, uuid } from './world.ts'
import type { DemoStep } from './generate.ts'

interface Person { name: string; dept: string; title: string; ago: number; boss?: string; account?: boolean }

const DEPARTMENTS = ['영업', '물류', '경영지원']

// Days before the module is turned on. Bosses come first, since a boss has to exist to be named.
const STAFF: Person[] = [
  { name: '김대표', dept: '경영지원', title: '대표', ago: 1005, account: true },
  { name: '박영업', dept: '영업', title: '영업 팀장', ago: 990, boss: '김대표', account: true },
  { name: '이재고', dept: '물류', title: '물류 팀장', ago: 590, boss: '김대표', account: true },
  { name: '최구매', dept: '물류', title: '구매 담당', ago: 400, boss: '이재고', account: true },
  { name: '정회계', dept: '경영지원', title: '회계 담당', ago: 225, boss: '김대표', account: true },
  { name: '한인사', dept: '경영지원', title: '인사 담당', ago: 20, boss: '김대표', account: true },
  { name: '오수도', dept: '영업', title: '수도권 영업', ago: 880, boss: '박영업' },
  { name: '강영남', dept: '영업', title: '영남 영업', ago: 700, boss: '박영업' },
  { name: '윤호남', dept: '영업', title: '호남 영업', ago: 520, boss: '박영업' },
  { name: '서창고', dept: '물류', title: '창고 담당', ago: 550, boss: '이재고' },
  { name: '임배송', dept: '물류', title: '배송 담당', ago: 350, boss: '이재고' },
]
// Someone who had already gone when the module came on: entered with both dates, so the count is right for those years.
const GONE: Person & { leftAgo: number } = { name: '문이직', dept: '영업', title: '영업 사원', ago: 960, leftAgo: 305, boss: '박영업' }
// Still here when the module came on, gone a little later.
const LEAVER: Person & { leavesIn: number } = { name: '배퇴직', dept: '물류', title: '배송 담당', ago: 790, leavesIn: 75, boss: '이재고' }
const JOINER: Person & { joinsIn: number } = { name: '조신입', dept: '영업', title: '영업 사원', ago: 0, joinsIn: 31, boss: '박영업' }
const MOVER = { name: '서창고', to: '영업', movesIn: 45 }

const id = (name: string) => uuid(`employee:${name}`)
const dept = (name: string) => uuid(`department:${name}`)

/** Who is here on which days, for the stories that follow people. Everyone was hired before `onDay` except the newcomer. */
export function peopleStory(onDay: number) {
  const names = [...STAFF.map((p) => p.name), LEAVER.name, JOINER.name]
  return {
    names,
    joined: (name: string) => (name === JOINER.name ? onDay + JOINER.joinsIn : onDay - 1),
    left: (name: string) => (name === LEAVER.name ? onDay + LEAVER.leavesIn : Number.MAX_SAFE_INTEGER),
  }
}

/** Steps by business day. `end` is the first day that does not happen. */
export function peopleSteps(seed: number, onDay: number, end: number): Map<number, DemoStep[]> {
  const r = rng(seed * 15485863 + 101)
  const out = new Map<number, DemoStep[]>()
  const add = (d: number, ...steps: DemoStep[]) => { if (d < end) out.set(d, [...(out.get(d) ?? []), ...steps]) }
  const at = (d: number) => `${isoOf(d)}T08:30:00+09:00`
  const cmd = (d: number, type: string, recordId: string | null, command: string, payload: unknown, as?: string): DemoStep =>
    ({ kind: 'cmd', at: at(d), type, id: recordId ?? '', command, payload, ...(as ? { as } : {}) })

  const hire = (d: number, p: Person, hired: number) => cmd(d, 'employee', id(p.name), 'create', {
    name: p.name,
    hire_date: isoOf(hired),
    department_id: dept(p.dept),
    job_title: p.title,
    ...(p.boss ? { manager_id: id(p.boss) } : {}),
    ...(p.account ? { member_id: `$member:${p.name}` } : {}),
  }, '한인사')
  // Made-up contact details, kept where they can be erased.
  const contact = (d: number, p: Person, i: number) => cmd(d, 'employee', id(p.name), 'set_private', {
    phone: `010-0000-${String(1000 + i)}`,
    birth_date: isoOf(onDay - 365 * 25 - Math.floor(r() * 365 * 20)),
  }, '한인사')

  const setup: DemoStep[] = [
    cmd(onDay, 'module', null, 'enable', { id: 'hr' }),
    cmd(onDay, 'member', null, 'create', { name: '한인사', email: `people-${seed}@demo.example`, password: `demo-people-${seed}-pass`, roles: ['hr'] }),
    ...DEPARTMENTS.map((name) => cmd(onDay, 'department', dept(name), 'create', { name }, '한인사')),
  ]
  add(onDay, ...setup)

  const present = [...STAFF, LEAVER]
  present.forEach((p, i) => add(onDay, hire(onDay, p, onDay - p.ago - Math.floor(r() * 6)), contact(onDay, p, i)))
  add(onDay, hire(onDay, GONE, onDay - GONE.ago), cmd(onDay, 'employee', id(GONE.name), 'leave', { leave_date: isoOf(onDay - GONE.leftAgo) }, '한인사'))

  const joined = onDay + JOINER.joinsIn
  add(joined, hire(joined, JOINER, joined), contact(joined, JOINER, present.length))
  const moved = onDay + MOVER.movesIn
  add(moved, cmd(moved, 'employee', id(MOVER.name), 'update', { department_id: dept(MOVER.to) }, '한인사'))
  const left = onDay + LEAVER.leavesIn
  add(left, cmd(left, 'employee', id(LEAVER.name), 'leave', { leave_date: isoOf(left) }, '한인사'))
  return out
}

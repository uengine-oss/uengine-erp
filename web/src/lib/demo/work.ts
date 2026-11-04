// The made-up company's leave and clock. Like the people it follows, this story has its own random stream and is merged in by day, so
// turning it on or changing it cannot move a sale, a stock level or a line of the books. Reasons and names are made up.
import { dayOf, isoOf, rng, uuid } from './world.ts'
import type { DemoStep } from './generate.ts'
import { peopleStory } from './people.ts'

interface LeaveStep { who: string; type: 'annual' | 'sick' | 'family'; from: number; to?: number; half?: 'am' | 'pm'; reason?: string; asked: number; decide?: 'approve' | 'reject' | 'approve-then-cancel'; by?: string; decided?: number; rejectReason?: string; cancelled?: number }

// Days after the module comes on, chosen so each date falls inside days the person actually holds under the default policy.
const LEAVE: LeaveStep[] = [
  { who: '박영업', type: 'annual', from: 10, to: 12, reason: '가족 행사', asked: 1, decide: 'approve', by: '김대표', decided: 2 },
  { who: '정회계', type: 'annual', from: 17, half: 'am', asked: 6, decide: 'approve', by: '김대표', decided: 7 },
  { who: '오수도', type: 'sick', from: 24, asked: 24, decide: 'approve', by: '박영업', decided: 25 },
  { who: '최구매', type: 'annual', from: 30, to: 31, reason: '이사', asked: 18, decide: 'approve', by: '이재고', decided: 20 },
  { who: '서창고', type: 'annual', from: 36, reason: '개인 일정', asked: 26, decide: 'reject', by: '이재고', decided: 28, rejectReason: '그 주 재고 실사와 겹칩니다' },
  { who: '윤호남', type: 'family', from: 40, to: 41, asked: 32, decide: 'approve', by: '박영업', decided: 33 },
  { who: '박영업', type: 'annual', from: 54, asked: 44, decide: 'approve-then-cancel', by: '김대표', decided: 45, cancelled: 50 },
  { who: '강영남', type: 'annual', from: 60, to: 62, asked: 50, decide: 'approve', by: '박영업', decided: 52 },
  { who: '이재고', type: 'annual', from: 66, asked: 60 },
]

// People with their own login stamp for themselves. Those without one have their days entered from the site's daily log.
const PUNCHERS = new Set(['박영업', '이재고', '최구매', '정회계', '한인사'])
const HEAVY = '서창고'

const emp = (name: string) => uuid(`employee:${name}`)
const dowOf = (d: number) => new Date(`${isoOf(d)}T00:00:00Z`).getUTCDay()
const pad = (n: number) => String(n).padStart(2, '0')

export function workSteps(seed: number, onDay: number, timeoffDay: number | null, attendanceDay: number | null, end: number): Map<number, DemoStep[]> {
  const r = rng(seed * 32452843 + 211)
  const out = new Map<number, DemoStep[]>()
  const add = (d: number, ...steps: DemoStep[]) => { if (d < end) out.set(d, [...(out.get(d) ?? []), ...steps]) }
  const at = (d: number, t = '08:40') => `${isoOf(d)}T${t}:00+09:00`
  const cmd = (d: number, type: string, recordId: string | null, command: string, payload: unknown, as?: string, reason?: string, t?: string): DemoStep =>
    ({ kind: 'cmd', at: at(d, t), type, id: recordId ?? '', command, payload, ...(as ? { as } : {}), ...(reason ? { reason } : {}) })
  const settle = (d: number): DemoStep => ({ kind: 'settle', at: at(d, '08:45'), type: 'work' })
  // A company's own day, the kind this app expects it to type in. No public holiday is listed: there is no list built in.
  const first = Math.min(timeoffDay ?? Number.MAX_SAFE_INTEGER, attendanceDay ?? Number.MAX_SAFE_INTEGER)
  const founding = (() => { let d = first + 20; while ([0, 6].includes(dowOf(d))) d++; return d })()
  const free = (d0: number) => { let d = d0; while ([0, 6].includes(dowOf(d)) || d === founding) d++; return d }
  add(first, cmd(first, 'holiday', uuid('holiday:founding'), 'create', { date: isoOf(founding), name: '회사 창립기념일', source: '데모 회사 취업규칙(가상)' }, '한인사'))

  const away = new Map<string, Set<number>>()
  if (timeoffDay !== null) {
    const T = timeoffDay
    add(T, cmd(T, 'module', null, 'enable', { id: 'timeoff' }), settle(T))
    for (let d = T + 1; d < end; d++) if (dowOf(d) === 1) add(d, cmd(d, 'leave_policy', null, 'accrue', {}, '한인사'), settle(d))
    LEAVE.forEach((l, i) => {
      const id = uuid(`leave:${i}`)
      const from = free(T + l.from)
      const to = l.to !== undefined ? free(T + l.to) : from
      add(T + l.asked, cmd(T + l.asked, 'leave_request', id, 'create', {
        employee_id: emp(l.who), leave_type_id: `$seed:leave_type:${l.type}`, date_from: isoOf(from), date_to: isoOf(to),
        ...(l.half ? { half_day: l.half } : {}), ...(l.reason ? { reason: l.reason } : {}),
      }, l.who))
      if (l.decide === 'reject') {
        add(T + l.decided!, cmd(T + l.decided!, 'leave_request', id, 'reject', { reject_reason: l.rejectReason }, l.by))
      } else if (l.decide) {
        add(T + l.decided!, cmd(T + l.decided!, 'leave_request', id, 'approve', {}, l.by))
        if (l.decide === 'approve-then-cancel') {
          add(T + l.cancelled!, cmd(T + l.cancelled!, 'leave_request', id, 'cancel', {}, l.who))
        } else if (!l.half && T + l.decided! < end) {
          const days = away.get(l.who) ?? new Set<number>()
          for (let d = from; d <= to; d++) days.add(d)
          away.set(l.who, days)
        }
      }
    })
  }

  if (attendanceDay !== null) {
    const A = attendanceDay
    const story = peopleStory(onDay)
    add(A, cmd(A, 'module', null, 'enable', { id: 'attendance' }), settle(A))
    const firstWeekday = free(A)
    const heavyFrom = Math.max(firstWeekday, end - 9)
    let forgot = false
    for (let d = firstWeekday; d < end; d++) {
      // Each draw happens whether or not the day is worked, so a later change to the story cannot shift what came before it.
      const noise = story.names.map(() => [r(), r()])
      if ([0, 6].includes(dowOf(d)) || d === founding) continue
      // Someone joining this morning has to reach this module before their first day can be written down.
      if (story.names.some((name) => story.joined(name) === d)) add(d, settle(d))
      story.names.forEach((name, i) => {
        if (d < story.joined(name) || d > story.left(name) || away.get(name)?.has(d)) return
        const heavy = name === HEAVY && d >= heavyFrom
        const inMin = 8 * 60 + 40 + Math.floor(noise[i][0] * 40)
        const outMin = heavy ? 21 * 60 + 30 + Math.floor(noise[i][1] * 30) : 17 * 60 + 50 + Math.floor(noise[i][1] * 100)
        const stampIn = `${pad(Math.floor(inMin / 60))}:${pad(inMin % 60)}`
        const stampOut = `${pad(Math.floor(outMin / 60))}:${pad(outMin % 60)}`
        if (PUNCHERS.has(name)) {
          add(d, cmd(d, 'attendance_day', null, 'check_in', {}, name, undefined, stampIn))
          // One forgotten stamp, corrected the next morning with a reason, as the scenario has it.
          if (!forgot && name === '최구매' && d >= firstWeekday + 7) {
            forgot = true
            add(d + 1, cmd(d + 1, 'attendance_day', uuid2(emp(name), d), 'correct', { check_out: `${isoOf(d)}T${stampOut}:00+09:00` }, '한인사', '퇴근 누락. 본인 확인', '08:35'))
          } else {
            add(d, cmd(d, 'attendance_day', null, 'check_out', {}, name, undefined, stampOut))
          }
        } else {
          add(d, cmd(d, 'attendance_day', null, 'correct', { employee_id: emp(name), date: isoOf(d), check_in: `${isoOf(d)}T${stampIn}:00+09:00`, check_out: `${isoOf(d)}T${stampOut}:00+09:00` }, '한인사', '현장 직원 일지 입력', '22:30'))
        }
      })
    }
    // Each month closed once it is over, in the first days of the next.
    for (let d = A + 1; d < end; d++) {
      if (isoOf(d).endsWith('-03')) {
        const prev = new Date(`${isoOf(d)}T00:00:00Z`)
        prev.setUTCMonth(prev.getUTCMonth() - 1)
        if (dayOf(`${prev.toISOString().slice(0, 7)}-28`) >= A) {
          add(d, settle(d), cmd(d, 'attendance_month', null, 'close', { period: prev.toISOString().slice(0, 7) }, '한인사', undefined, '08:50'), settle(d))
        }
      }
    }
  }
  return out
}

// The same id the database gives a day: md5 of its name, which is how every seeded id here is made.
function uuid2(employee: string, d: number): string {
  return `$seed:attendance_day:${employee}:${isoOf(d)}`
}

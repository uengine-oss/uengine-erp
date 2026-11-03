// The made-up company's back office: claims, and later deals and projects. Each story has its own random stream and is merged in
// by day, like the people, so turning one on cannot move a sale or a stock level: the figures quoted in the tutorials stay what they were.
import { isoOf, rng, uuid } from './world.ts'
import type { DemoStep } from './generate.ts'

const employee = (name: string) => uuid(`employee:${name}`)

type Steps = Map<number, DemoStep[]>
const adder = (out: Steps, end: number) => (d: number, ...steps: DemoStep[]) => { if (d < end) out.set(d, [...(out.get(d) ?? []), ...steps]) }
const stepper = (d: number, time: string) => (type: string, id: string | null, command: string, payload: unknown, as?: string, reason?: string): DemoStep =>
  ({ kind: 'cmd', at: `${isoOf(d)}T${time}:00+09:00`, type, id: id ?? '', command, payload, ...(as ? { as } : {}), ...(reason ? { reason } : {}) })

// Who claims, what they mostly spend on, and how big it tends to be. Managers come from the people story.
const CLAIMANTS = [
  { name: '오수도', titles: [['교통비', '거래처 방문 택시'], ['식대', '거래처 점심']], base: 18000 },
  { name: '강영남', titles: [['출장비', '영남 출장 KTX'], ['식대', '출장 식대']], base: 52000 },
  { name: '윤호남', titles: [['출장비', '호남 출장 KTX'], ['접대비', '거래처 저녁']], base: 64000 },
  { name: '이재고', titles: [['소모품', '창고 라벨 용지'], ['교통비', '창고 방문 택시']], base: 26000 },
  { name: '최구매', titles: [['통신비', '공급사 해외 통화'], ['교통비', '공급사 방문 택시']], base: 22000 },
  { name: '정회계', titles: [['소모품', '사무용품'], ['기타 경비', '등기 우편']], base: 15000 },
] as const

/** Claims from the day the module comes on. Most get approved and paid a few days later; the last few are left for whoever opens the demo. */
export function expenseSteps(seed: number, onDay: number, end: number): Steps {
  const r = rng(seed * 15485863 + 211)
  const out: Steps = new Map()
  const add = adder(out, end)
  add(onDay, stepper(onDay, '08:45')('module', null, 'enable', { id: 'expense' }))
  let n = 0
  for (let d = onDay + 1; d < end; d++) {
    for (const who of CLAIMANTS) {
      if (r() > 0.09) continue
      const [category, title] = who.titles[r() < 0.6 ? 0 : 1]
      const id = uuid(`expense:${seed}:${n++}`)
      const amount = Math.round((who.base * (0.6 + r() * 0.9)) / 100) * 100
      const spent = d - 1 - Math.floor(r() * 3)
      const at = stepper(d, '09:10')
      add(d,
        at('expense', id, 'create', { employee_id: employee(who.name), title, amount, date: isoOf(Math.max(spent, onDay)), category_id: `$seed:expense_category:${category}`, no_receipt_reason: '가상 회사라 파일이 없습니다' }, who.name),
        at('expense', id, 'submit', {}, who.name))
      const decide = d + 1 + Math.floor(r() * 3)
      const refused = r() < 0.08
      if (decide >= end - 2) continue
      if (refused) {
        add(decide, stepper(decide, '11:20')('expense', id, 'refuse', {}, '김대표', '영수증을 다시 확인해 주세요'))
        continue
      }
      add(decide, stepper(decide, '11:20')('expense', id, 'approve', {}, '김대표'))
      const pay = decide + 2 + Math.floor(r() * 4)
      if (pay < end - 1) add(pay, stepper(pay, '16:00')('expense', id, 'pay', { paid_from: r() < 0.9 ? 'bank' : 'cash' }, '정회계'))
    }
  }
  return out
}

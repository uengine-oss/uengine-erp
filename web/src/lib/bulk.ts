// What a list does to the rows someone ticked. Each row still goes through its own command, so the database
// refuses what it would refuse one at a time, and the person hears which ones did not go through.
import { messageOf, rpc } from './api'
import { nudgeBus, sendCommand } from './commands'
import { db } from './conn'
import { fmtDay } from './format'
import { rows as readRows } from './load'
import type { ErpRecord, Field, State } from './types'
import { ask, csvBlob, saveBlob, toast } from './ui'

export async function tellResult(verb: string, done: number, failed: { name: string; message: string }[]): Promise<void> {
  if (!failed.length) { toast(`${done.toLocaleString('ko-KR')}건을 ${verb}.`); return }
  await ask({
    title: `${failed.length}건은 처리하지 못했습니다`,
    message: `${done}건을 ${verb}.\n\n${failed.map((f) => `${f.name}: ${f.message}`).join('\n')}`,
    confirmLabel: '확인',
    wide: true,
  })
}

export async function cancelOrders(list: ErpRecord[]): Promise<void> {
  const answer = await ask({
    title: `주문 ${list.length}건 취소`,
    message: '확정한 주문도 취소됩니다. 이미 처리된 전표나 청구서가 있는 주문은 데이터베이스가 거부합니다.',
    danger: true, reason: true, confirmLabel: '취소 진행', cancelLabel: '닫기',
  })
  if (!answer) return
  const failed: { name: string; message: string }[] = []
  let done = 0
  for (const r of list) {
    try {
      await sendCommand({ type: r.type, id: r.id, command: 'cancel', payload: answer.reason ? { reason: answer.reason } : {}, expectedVersion: r.version, reason: answer.reason || null })
      done++
    } catch (e) {
      failed.push({ name: r.name ?? r.id, message: messageOf(e) })
    }
  }
  await tellResult('취소했습니다', done, failed)
}

export async function checkPickings(list: ErpRecord[]): Promise<void> {
  const res = await rpc<{ changed: number }>('erp_stock_check_all', { p_ids: list.map((r) => r.id) })
  nudgeBus()
  toast(res.changed ? `${res.changed}건의 예약이 바뀌었습니다. 재고가 모자란 전표는 대기로 남습니다.` : '바뀐 전표가 없습니다. 재고가 모자란 전표는 대기로 남습니다.')
}

async function bankJournals(): Promise<{ value: string; label: string }[]> {
  const list = await readRows<{ id: string; name: string | null }>(db().from('erp_records').select('id,name').eq('type', 'journal').eq('active', true)
    .in('state->>journal_type', ['bank', 'cash', 'credit']).order('name'))
  return list.map((j) => ({ value: j.id, label: j.name ?? j.id }))
}

export async function payMoves(list: ErpRecord[]): Promise<void> {
  const options = await bankJournals()
  const fields: Field[] = [
    { name: 'date', label: '날짜', type: 'date', required: true, default: fmtDay(new Date().toISOString()) },
    { name: 'journal_id', label: '분개장', type: 'enum', required: true, options },
    { name: 'group', label: '같은 거래처는 한 건으로 묶기', type: 'boolean', default: false, help: '끄면 문서마다 따로 등록합니다.' },
  ]
  let values: State = { journal_id: options[0]?.value }
  let error = ''
  for (;;) {
    const answer = await ask({ title: `문서 ${list.length}건 결제 등록`, message: '남은 금액 전부를 등록합니다. 고객 문서와 공급사 문서는 함께 등록할 수 없습니다.', error, fields, values, confirmLabel: '등록' })
    if (!answer) return
    values = answer.values
    try {
      await sendCommand({ type: 'payment', command: 'create', payload: { from_moves: list.map((r) => r.id), date: values.date, journal_id: values.journal_id, group: !!values.group } })
      toast(`문서 ${list.length}건의 결제를 등록했습니다.`)
      return
    } catch (e) {
      error = messageOf(e)
    }
  }
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, '_')

/** Printable pages rather than PDFs: a browser makes a PDF only through its own print dialog. */
export async function exportMoves(list: ErpRecord[]): Promise<void> {
  const { documentHtml } = await import('../screens/print/render')
  const { makeZip } = await import('./zip')
  const files: { name: string; text: string }[] = []
  for (const r of list) files.push({ name: `${safeName(r.name ?? r.id)}.html`, text: await documentHtml(r) })
  const index = await csvBlob(['번호', '거래처 ID', '합계', '상태'], list.map((r) => [
    { value: r.state.number ?? '', numeric: false }, { value: r.state.partner_id ?? '', numeric: false }, { value: r.state.amount_total ?? '', numeric: true }, { value: r.status ?? '', numeric: false },
  ])).text()
  files.push({ name: '목록.csv', text: index })
  saveBlob(makeZip(files), `청구서_${fmtDay(new Date().toISOString())}.zip`)
  toast(`${list.length}건을 파일 하나로 받았습니다.`)
}

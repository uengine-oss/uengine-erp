// Words and the bank file. The layout comes from what the user saved for their bank; this only writes it out, and no rule of pay is worked out in the browser.
import type { State } from '../../lib/types'

export const CELL_LABEL: Record<string, string> = {
  income_tax: '소득세', local_tax: '지방소득세', pension: '국민연금', health: '건강보험', ltc: '장기요양', employment: '고용보험',
}

export const NOTE_LABEL: Record<string, string> = {
  missing: '자료 없음, 칸 비어 있음',
  partial_month: '월 중 입사·퇴사, 금액 확인',
  final_settlement: '퇴사 달, 정산 세액 직접 입력',
  no_profile: '급여 정보 없음',
  over_limit: '비과세 한도 넘음',
  below_table: '세액표 시작 금액 아래',
  out_of_table: '세액표 범위 밖',
  no_table: '세액표 없음',
  small_tax: '1천 원 미만 부징수',
  family_over_table: '가족 11명 초과 계산',
}

export interface BankColumn { header: string; field: string; memo?: string }
export interface BankFormat { id: string; name: string; delimiter?: string; with_header?: boolean; columns: BankColumn[] }

const KIND_LABEL: Record<string, string> = { regular: '정기', bonus: '상여', correction: '정정', reversal: '정정 전 취소' }
export const kindLabel = (k: string | null | undefined): string => (k ? KIND_LABEL[k] ?? k : '')

/** Spreadsheet apps run cells that start with these, so text is defused the way every other export here is. */
function cell(v: unknown, delimiter: string, numeric: boolean): string {
  let s = v === null || v === undefined ? '' : String(v)
  if (!numeric && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return s.includes(delimiter) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function transferFile(format: BankFormat, rows: State[]): Blob {
  const d = format.delimiter === 'tab' ? '\t' : ','
  const lines: string[] = []
  if (format.with_header !== false) lines.push(format.columns.map((c) => cell(c.header, d, false)).join(d))
  for (const r of rows) {
    lines.push(format.columns.map((c) => {
      if (c.field === 'blank') return ''
      if (c.field === 'memo') return cell(c.memo ?? '', d, false)
      return cell(r[c.field], d, c.field === 'net')
    }).join(d))
  }
  // The BOM makes spreadsheet apps read Korean text as UTF-8.
  return new Blob(['﻿', lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
}

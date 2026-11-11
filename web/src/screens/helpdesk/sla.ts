// The words the helpdesk screens put on what the database says about a ticket's SLA. Only words: the status itself comes from
// erp_helpdesk_sla, which works it out from the ticket's deadlines and the clock.
import type { Conn } from '../../lib/conn'

export interface SlaClock {
  status: 'on_track' | 'at_risk' | 'breached' | 'met' | 'none'
  due?: string | null
  target_minutes?: number | null
  left_minutes?: number | null
  paused?: boolean
  done_at?: string | null
}
export interface Sla {
  id: string
  number: string
  subject: string
  stage: string
  priority: string
  assignee_id: string | null
  status: SlaClock['status']
  policy: string | null
  basis: string | null
  response: SlaClock
  resolve: SlaClock
}

export const CLOCK: Record<string, { label: string; color: string }> = {
  on_track: { label: '정상', color: 'blue' },
  at_risk: { label: '위험', color: 'amber' },
  breached: { label: '위반', color: 'red' },
  met: { label: '지킴', color: 'green' },
  none: { label: '없음', color: 'gray' },
}

export const KIND: Record<string, string> = { reply: '답장', note: '내부 메모', customer: '고객' }

/** What a customer opens. They have no account and no connection saved, so the link carries the public address and key. */
export function supportLink(c: Conn, token: string): string {
  return `${location.origin}${location.pathname}#/support/${encodeURIComponent(token)}?u=${encodeURIComponent(c.url)}&k=${encodeURIComponent(c.key)}`
}

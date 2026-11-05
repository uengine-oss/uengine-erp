// Process-mining files built from the pages of erp_process_log: CSV, XES (IEEE 1849) and OCEL 2.0 JSON, plus the variants the screen
// shows. The screen and experiments/process-log-samples.mjs run this same code, so a sample file is what the button gives.
// No Vue and no network here; the caller passes its own rpc.

export interface PlRef { id: string; q: string }
export interface PlRow {
  case_id: string; case_label: string; activity: string; event_type: string; timestamp: string; resource: string; source: string
  document_type: string; document: string; seq: number; document_id: string; document_kind: string; refs: PlRef[]
}
export interface PlDoc { id: string; kind: string; type: string; number: string; created_at: string; links: PlRef[] }
export interface PlPage { rows: PlRow[]; documents: PlDoc[]; next: string | null; more: boolean }
export interface PlLog { rows: PlRow[]; documents: PlDoc[] }
export interface PlQuery { notion: string; from?: string | null; to?: string | null; major?: boolean; pageSize?: number }
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<unknown>

/** The file contract. Process GPT reads these columns by name, in this order. */
export const CSV_COLUMNS = ['case_id', 'case_label', 'activity', 'event_type', 'timestamp', 'resource', 'source', 'document_type', 'document', 'seq'] as const

export const NOTIONS: { value: string; label: string; hint: string }[] = [
  { value: 'sales_order', label: '주문-수금', hint: '견적·주문 한 건과 거기서 나온 출고, 청구서, 그 청구서의 입금을 한 사례로 묶습니다.' },
  { value: 'purchase_order', label: '구매-지급', hint: '구매 주문 한 건과 거기서 나온 입고, 공급사 청구서, 그 청구서의 지급을 한 사례로 묶습니다.' },
  { value: 'document', label: '문서별', hint: '문서 하나하나가 한 사례입니다. 문서 유형을 고를 수 있습니다.' },
]

/** Reads every page. Each page stays inside the API's time limit; the rows come back in file order. */
export async function loadProcessLog(rpc: Rpc, q: PlQuery, onPage?: (rows: number, cases: number) => void, isStale?: () => boolean): Promise<PlLog> {
  const rows: PlRow[] = []
  const docs = new Map<string, PlDoc>()
  const cases = new Set<string>()
  let after: string | null = null
  for (let i = 0; i < 100000; i++) {
    const page = (await rpc('erp_process_log', {
      p_case: q.notion, p_from: q.from || null, p_to: q.to || null, p_after: after, p_limit: q.pageSize ?? 1000, p_major: q.major ?? true,
    })) as PlPage
    if (isStale?.()) break
    rows.push(...page.rows)
    for (const r of page.rows) cases.add(r.case_id)
    for (const d of page.documents) {
      const had = docs.get(d.id)
      if (!had) docs.set(d.id, { ...d, links: [...d.links] })
      else for (const l of d.links) if (!had.links.some((x) => x.id === l.id && x.q === l.q)) had.links.push(l)
    }
    onPage?.(rows.length, cases.size)
    if (!page.more || !page.next) break
    after = page.next
  }
  return { rows, documents: [...docs.values()] }
}

// Like the app's other CSV files, text a spreadsheet would run as a formula (=, +, -, @ first) gets a leading apostrophe.
const csvCell = (v: unknown, numeric: boolean) => {
  let s = v === null || v === undefined ? '' : String(v)
  if (!numeric && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

/** UTF-8 with a byte-order mark so a spreadsheet opens the Korean right; one line per event, LF line ends. */
export function toCsv(rows: PlRow[]): string {
  const lines = [CSV_COLUMNS.join(','), ...rows.map((r) => CSV_COLUMNS.map((k) => csvCell(r[k], k === 'seq')).join(','))]
  return `\ufeff${lines.join('\n')}\n`
}

const XML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
// Control characters XML 1.0 cannot carry at all are dropped.
const xml = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => XML_ESC[c]).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')

/** IEEE 1849-2016 XES: a trace per case named by its number, an event per row. */
export function toXes(rows: PlRow[], logName: string): string {
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<log xes.version="1849-2016" xmlns="http://www.xes-standard.org/">',
    '  <extension name="Concept" prefix="concept" uri="http://www.xes-standard.org/concept.xesext"/>',
    '  <extension name="Time" prefix="time" uri="http://www.xes-standard.org/time.xesext"/>',
    '  <extension name="Organizational" prefix="org" uri="http://www.xes-standard.org/org.xesext"/>',
    '  <global scope="trace">',
    '    <string key="concept:name" value=""/>',
    '  </global>',
    '  <global scope="event">',
    '    <string key="concept:name" value=""/>',
    '    <date key="time:timestamp" value="1970-01-01T00:00:00.000+00:00"/>',
    '  </global>',
    '  <classifier name="Activity" keys="concept:name"/>',
    `  <string key="concept:name" value="${xml(logName)}"/>`,
  ]
  let open: string | null = null
  for (const r of rows) {
    if (r.case_id !== open) {
      if (open !== null) out.push('  </trace>')
      out.push('  <trace>', `    <string key="concept:name" value="${xml(r.case_label)}"/>`, `    <string key="erp:case_id" value="${xml(r.case_id)}"/>`)
      open = r.case_id
    }
    out.push('    <event>',
      `      <string key="concept:name" value="${xml(r.activity)}"/>`,
      `      <date key="time:timestamp" value="${xml(r.timestamp)}"/>`,
      `      <string key="org:resource" value="${xml(r.resource)}"/>`,
      `      <string key="erp:event_type" value="${xml(r.event_type)}"/>`,
      `      <string key="erp:document" value="${xml(r.document)}"/>`,
      `      <string key="erp:document_type" value="${xml(r.document_type)}"/>`,
      `      <string key="erp:source" value="${xml(r.source)}"/>`,
      `      <int key="erp:seq" value="${r.seq}"/>`,
      '    </event>')
  }
  if (open !== null) out.push('  </trace>')
  out.push('</log>', '')
  return out.join('\n')
}

export interface Ocel {
  objectTypes: { name: string; attributes: { name: string; type: string }[] }[]
  eventTypes: { name: string; attributes: { name: string; type: string }[] }[]
  objects: { id: string; type: string; attributes: { name: string; value: string; time: string }[]; relationships: { objectId: string; qualifier: string }[] }[]
  events: { id: string; type: string; time: string; attributes: { name: string; value: string }[]; relationships: { objectId: string; qualifier: string }[] }[]
}

/** OCEL 2.0 JSON. Objects are the documents, linked to what they were made from or paid; an event relates to its own document and
 *  to every other exported document it names. A payment shared by two orders is one object and its events appear once. */
export function toOcel(log: PlLog): Ocel {
  const objects = new Map(log.documents.map((d) => [d.id, d]))
  const objectTypes = [...new Set(log.documents.map((d) => d.type))].sort()
  const events = new Map<number, PlRow>()
  for (const r of log.rows) if (!events.has(r.seq)) events.set(r.seq, r)
  const eventTypes = [...new Set([...events.values()].map((r) => r.activity))].sort()
  const EVENT_ATTRS = [{ name: 'resource', type: 'string' }, { name: 'source', type: 'string' }, { name: 'event_type', type: 'string' }, { name: 'seq', type: 'integer' }]
  return {
    objectTypes: objectTypes.map((name) => ({ name, attributes: [{ name: '번호', type: 'string' }] })),
    eventTypes: eventTypes.map((name) => ({ name, attributes: EVENT_ATTRS })),
    objects: log.documents.map((d) => ({
      id: d.id, type: d.type,
      attributes: [{ name: '번호', value: d.number, time: d.created_at }],
      relationships: d.links.filter((l) => objects.has(l.id)).map((l) => ({ objectId: l.id, qualifier: l.q })),
    })),
    events: [...events.values()].map((r) => ({
      id: `e${r.seq}`, type: r.activity, time: r.timestamp,
      attributes: [{ name: 'resource', value: r.resource }, { name: 'source', value: r.source }, { name: 'event_type', value: r.event_type }, { name: 'seq', value: String(r.seq) }],
      relationships: [{ objectId: r.document_id, qualifier: r.document_type },
        ...r.refs.filter((x) => objects.has(x.id) && x.id !== r.document_id).map((x) => ({ objectId: x.id, qualifier: x.q }))],
    })),
  }
}

export interface Variant { activities: string[]; count: number; share: number; medianMs: number | null }
export interface LogStats { cases: number; events: number; activities: number; variants: Variant[] }

const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Cases, events and the distinct activity sequences, most frequent first. Duration is first to last event of a case. */
export function stats(rows: PlRow[]): LogStats {
  const byCase = new Map<string, { acts: string[]; first: number; last: number }>()
  for (const r of rows) {
    const t = Date.parse(r.timestamp)
    const c = byCase.get(r.case_id)
    if (!c) byCase.set(r.case_id, { acts: [r.activity], first: t, last: t })
    else { c.acts.push(r.activity); c.first = Math.min(c.first, t); c.last = Math.max(c.last, t) }
  }
  const groups = new Map<string, { activities: string[]; spans: number[] }>()
  for (const c of byCase.values()) {
    const key = c.acts.join('\u0001')
    const g = groups.get(key) ?? { activities: c.acts, spans: [] }
    g.spans.push(c.last - c.first)
    groups.set(key, g)
  }
  const total = byCase.size
  const variants = [...groups.values()]
    .map((g) => ({ activities: g.activities, count: g.spans.length, share: total ? g.spans.length / total : 0, medianMs: median(g.spans) }))
    .sort((a, b) => b.count - a.count || a.activities.length - b.activities.length || a.activities.join().localeCompare(b.activities.join()))
  return { cases: total, events: rows.length, activities: new Set(rows.map((r) => r.activity)).size, variants }
}

/** "3일 4시간" style, plain enough for a chat message. */
export function fmtSpan(ms: number | null): string {
  if (ms === null) return '-'
  const min = Math.round(ms / 60000)
  if (min < 1) return '1분 안'
  if (min < 60) return `${min}분`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}시간${min % 60 ? ` ${min % 60}분` : ''}`
  const d = Math.floor(h / 24)
  return `${d}일${h % 24 ? ` ${h % 24}시간` : ''}`
}

const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`

/** A short note in plain Korean a person pastes into Process GPT's process-generation chat. No codes, no ids. */
export function variantSummary(s: LogStats, opts: { notion: string; from?: string | null; to?: string | null; top?: number }): string {
  const kind = NOTIONS.find((n) => n.value === opts.notion.split(':')[0])?.label ?? '업무'
  const top = s.variants.slice(0, opts.top ?? 5)
  const period = opts.from || opts.to ? `${opts.from || '처음'}부터 ${opts.to || '지금'}까지 ` : ''
  const lines = [
    `우리 회사 ERP 기록에서 ${period}${kind} 흐름 ${s.cases.toLocaleString('ko-KR')}건을 뽑았습니다. 자주 나온 순서대로 적습니다.`,
    '',
    ...top.map((v, i) => `${i + 1}. ${v.activities.join(' → ')} (${v.count.toLocaleString('ko-KR')}건, ${pct(v.share)}, 보통 ${fmtSpan(v.medianMs)} 걸림)`),
  ]
  const rest = s.variants.length - top.length
  if (rest > 0) lines.push('', `이 밖에 드물게 나온 흐름이 ${rest.toLocaleString('ko-KR')}가지 더 있습니다.`)
  lines.push('', '1번을 기본 흐름으로 하고, 나머지는 갈림길이나 예외로 넣어 이 흐름으로 프로세스를 만들어 주세요.')
  return lines.join('\n')
}

/** A file name that says what is in it: erp-o2c-2025-01-01-2026-12-31.csv */
export function fileName(notion: string, from: string | null | undefined, to: string | null | undefined, ext: string): string {
  const tag = notion === 'sales_order' ? 'o2c' : notion === 'purchase_order' ? 'p2p' : notion.replace(':', '-')
  const span = from || to ? `-${from || 'start'}-${to || 'now'}` : ''
  return `erp-${tag}${span}.${ext}`
}

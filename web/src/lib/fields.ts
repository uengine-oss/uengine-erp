// Turns catalog metadata into what screens need. Display only: no business rule lives here.
import { hasRole } from './session'
import { writeBlock } from './mode'
import { fmtDate, fmtDateTime, fmtInteger, fmtMoney, fmtNumber } from './format'
import { refLabel } from './refs'
import type { CatalogDoc, CommandDef, Field, StateDef, State, Transition } from './types'

export const NUMERIC = new Set(['number', 'money', 'integer'])
export const isNumeric = (f: Field) => NUMERIC.has(f.type)
export const isDerived = (f: Field) => !!(f.readonly || f.computed)

export function listFields(doc: CatalogDoc): Field[] {
  const listed = doc.fields.filter((f) => f.list && f.type !== 'lines' && f.type !== 'password' && !f.hidden)
  if (listed.length) return listed
  const name = doc.fields.find((f) => f.name === 'name')
  return name ? [name] : doc.fields.filter((f) => f.type === 'text').slice(0, 1)
}

/**
 * Fields shown on the form. Password-style create_only fields vanish once the record exists, and a new
 * record hides server-assigned values (number, merged_into) but keeps amounts, which erp_preview fills live.
 */
export function formFields(doc: CatalogDoc, isNew: boolean): Field[] {
  return doc.fields.filter((f) => {
    if (f.hidden) return false
    if (!isNew && f.type === 'password') return false
    if (isNew && isDerived(f) && f.type !== 'money' && f.type !== 'lines') return false
    return true
  })
}

const LONG_TEXT = /(^|_)(note|notes|description|narration|memo|address|comment)(_|$)|description_/
export function isLongText(f: Field): boolean {
  return f.type === 'text' && (f.multiline === true || LONG_TEXT.test(f.name))
}

export function emptyValue(f: Field): unknown {
  if (f.default !== undefined) return JSON.parse(JSON.stringify(f.default))
  if (f.type === 'lines' || f.type === 'tags' || f.type === 'refs') return []
  if (f.type === 'boolean') return false
  return null
}

export function emptyDraft(doc: CatalogDoc): State {
  const out: State = {}
  for (const f of doc.fields) out[f.name] = emptyValue(f)
  return out
}

export function stateOf(doc: CatalogDoc, value: string | null | undefined): StateDef | undefined {
  return doc.states?.find((s) => s.value === value)
}

/** Plain text for a value, used by CSV export, history and read-only forms. */
export function displayValue(f: Field | undefined, v: unknown): string {
  if (v === null || v === undefined || v === '') return ''
  if (!f) return typeof v === 'object' ? JSON.stringify(v) : String(v)
  switch (f.type) {
    case 'money': return fmtMoney(v)
    case 'number': return fmtNumber(v)
    case 'integer': return fmtInteger(v)
    case 'boolean': return v ? '예' : '아니오'
    case 'date': return fmtDate(v)
    case 'datetime': return fmtDateTime(v)
    case 'enum': return f.options?.find((o) => o.value === v)?.label ?? String(v)
    case 'ref': return refLabel(v)
    case 'refs': return (Array.isArray(v) ? v : []).map(refLabel).join(', ')
    case 'tags': return (Array.isArray(v) ? v : [v]).map((t) => f.options?.find((o) => o.value === t)?.label ?? String(t)).join(', ')
    case 'lines': return `${Array.isArray(v) ? v.length : 0}줄`
    case 'password': return '••••••'
    case 'json': return typeof v === 'string' ? v : JSON.stringify(v)
    default: return String(v)
  }
}

/** Reference ids a value holds, so a screen can resolve every name at once. */
export function collectRefIds(fields: Field[], state: State | null | undefined, into: Set<string>): void {
  if (!state) return
  for (const f of fields) {
    const v = state[f.name]
    if (f.type === 'ref' && v) into.add(String(v))
    else if ((f.type === 'refs' || (f.type === 'tags' && f.ref)) && Array.isArray(v)) v.forEach((x) => into.add(String(x)))
    else if (f.type === 'lines' && Array.isArray(v) && f.columns) v.forEach((row) => collectRefIds(f.columns!, row, into))
  }
}

// Every write control on a metadata screen asks one of the three functions below, so a read-only mode
// (a past date, an app or database of the wrong version) needs no check on each screen.
export function canCommand(doc: CatalogDoc, command: string): boolean {
  if (writeBlock.value) return false
  const def = doc.commands?.[command]
  if (!def) return false
  return hasRole(def.roles ?? doc.write_roles)
}

// Commands that undo work or are hard to walk back. A catalog entry can also say danger: true.
const DANGER_RE = /^(cancel|delete|reverse|void|revert|reset_to_draft|archive|merge)/
export function isDangerous(command: string, def?: { danger?: boolean; confirm?: string }): boolean {
  return !!def?.danger || !!def?.confirm || DANGER_RE.test(command)
}

export function visibleTransitions(doc: CatalogDoc, status: string | null | undefined): Transition[] {
  if (writeBlock.value) return []
  return (doc.transitions ?? []).filter((t) => {
    const fromOk = !t.from || t.from.length === 0 || t.from.includes(status ?? '')
    return fromOk && hasRole(t.roles ?? doc.write_roles)
  })
}

export function visibleExtraCommands(doc: CatalogDoc): (CommandDef & { command: string; label: string })[] {
  if (writeBlock.value) return []
  return Object.entries(doc.extra_commands ?? {})
    .filter(([, def]) => !def.hidden && hasRole(def.roles ?? doc.write_roles))
    .map(([command, def]) => ({ ...def, command, label: def.label ?? command }))
}

export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/**
 * jsonb reorders object keys, so comparisons must not depend on key order. A row's preview_echo is the server's note
 * to itself about the last preview: it goes back with the row, and no one has changed anything by receiving one.
 */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'preview_echo').sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canonical(x)]))
  }
  return v ?? null
}
export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

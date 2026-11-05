// Korean names for ledger events, document types, sources and who did the work. The words live in eventLabels.json, which the screens
// read through this module and SQL reads as erp.event_labels() (scripts/build-sql.mjs copies the file into install.sql). The ledger
// screen, the process-mining file and MCP therefore cannot name an event two ways. No Vue or network here: Node imports it too.
import L from './eventLabels.json' with { type: 'json' }

export const LABELS = L
const TYPES: Record<string, string> = L.types
const EXACT: Record<string, string> = L.exact
const SOURCES: Record<string, string> = L.sources
const SUFFIX = L.suffix.map(([re, word]) => [new RegExp(re), word] as const)
const MINOR = (L.minor as { pattern?: string }[]).flatMap((m) => (m.pattern ? [new RegExp(m.pattern)] : []))

/** A type's name: the catalog's when the screen has it, else the one kept here, else "문서". */
export function typeName(type: string, catalogLabel?: string | null): string {
  return catalogLabel ?? TYPES[type] ?? L.document
}

/** The exact wording, else the type's name plus a verb from the event's ending, else the code itself. */
export function eventName(eventType: string, typeLabel?: string): string {
  if (EXACT[eventType]) return EXACT[eventType]
  for (const [re, word] of SUFFIX) {
    if (re.test(eventType)) return typeLabel ? `${typeLabel} ${word}` : word
  }
  return eventType
}

export function sourceName(source: string): string {
  if (source.startsWith('bus:')) return L.bus
  return SOURCES[source] ?? source
}

/** Who did it, as the screens say it: work a module did in answer to another is "연쇄 반응", an agent keeps its member's name. */
export function resourceName(actor: string | null | undefined, source: string): string {
  if (source === 'reaction' || source.startsWith('bus:')) return L.automatic
  const who = actor ?? L.system
  return source === 'agent' || source === 'mcp' ? `${who}${L.agent_suffix}` : who
}

/** Bookkeeping the process view leaves out with "주요 활동만". The list and its reasons are in eventLabels.json. */
export function isMinor(eventType: string, data?: { yields?: unknown } | null): boolean {
  return data?.yields === true || MINOR.some((re) => re.test(eventType))
}

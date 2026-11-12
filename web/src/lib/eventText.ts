// Korean labels for ledger events, from the contract in docs/domain.md. Display only.
// The words are in eventLabels.json, shared with SQL so the process-mining file names events as this screen does.
import { catalogOf } from './session'
import { eventName, sourceName, typeName } from './eventLabels'

// The ledger keeps what modules wrote while they were on, and a module that is off takes its types out of the catalog.

/** A type's name for people, also when its module is off. A type nobody here has heard of is still a document. */
export function typeLabel(type: string): string {
  return typeName(type, catalogOf(type)?.label)
}

/** The record's type label plus a verb when there is no exact wording, so new events still read naturally. */
export function eventLabel(eventType: string, typeLabel?: string): string {
  return eventName(eventType, typeLabel)
}

export function sourceLabel(source: string): string {
  return sourceName(source)
}

export function sourceColor(source: string): string {
  if (source.startsWith('bus:')) return 'blue'
  switch (source) {
    case 'mcp':
    case 'agent': return 'violet'
    case 'reaction': return 'blue'
    case 'rollback':
    case 'compensation': return 'amber'
    default: return 'gray'
  }
}

/** Who wrote an event, as the history draws it: a person, an agent acting for one, or the system reacting by itself. */
export function actorKind(ev: { source: string; actor_name: string | null }): 'person' | 'agent' | 'system' {
  if (ev.source === 'agent' || ev.source === 'mcp') return 'agent'
  if ((ev.source === 'ui' || ev.source === 'rollback') && ev.actor_name) return 'person'
  return 'system'
}

export const SOURCES = ['ui', 'agent', 'mcp', 'reaction', 'rollback', 'compensation', 'setup', 'demo']

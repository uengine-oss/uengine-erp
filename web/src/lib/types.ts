export type FieldType =
  | 'text' | 'number' | 'money' | 'integer' | 'boolean' | 'date' | 'datetime'
  | 'enum' | 'ref' | 'refs' | 'tags' | 'json' | 'lines' | 'password'

export interface FieldOption { value: string; label: string; color?: string }

export interface Field {
  name: string
  label: string
  type: FieldType
  required?: boolean
  list?: boolean
  search?: boolean
  default?: unknown
  readonly?: boolean
  computed?: boolean
  create_only?: boolean
  unique?: boolean
  options?: FieldOption[]
  ref?: string
  columns?: Field[]
  help?: string
  /** Line tables only: lets users add section and note rows (display_type). */
  sections?: boolean
  multiline?: boolean
  hidden?: boolean
  /** Options come from a nested list on the record another column points at. */
  options_from?: { path: string; field: string }
}

export interface StateDef { value: string; label: string; color?: string }

export interface Transition {
  command: string
  to?: string
  from?: string[]
  label: string
  roles?: string[]
  primary?: boolean
  danger?: boolean
  confirm?: string
  params?: Field[]
}

export interface CommandDef { roles?: string[]; label?: string; params?: Field[]; danger?: boolean; confirm?: string }

export interface CatalogDoc {
  type: string
  module: string
  sort?: number
  label: string
  label_en?: string
  singleton?: boolean
  hidden?: boolean
  fields: Field[]
  states?: StateDef[]
  transitions?: Transition[]
  commands?: Record<string, CommandDef>
  extra_commands?: Record<string, CommandDef>
  write_roles?: string[]
  read_roles?: string[]
}

export type State = Record<string, any>

export interface ErpRecord {
  id: string
  type: string
  version: number
  name: string | null
  status: string | null
  active: boolean
  state: State
  created_at: string
  updated_at: string
  created_by?: string | null
  updated_by?: string | null
}

export interface ErpEvent {
  seq: number
  stream_type: string
  stream_id: string
  version: number
  event_type: string
  data: Record<string, any>
  actor_id: string | null
  actor_name: string | null
  source: string
  reason: string | null
  correlation_id: string
  causation_seq: number | null
  occurred_at: string
}

export interface Me {
  user_id: string
  email: string
  name: string
  roles: string[]
  record_id: string
}

export interface ErpStatus {
  installed: boolean
  version: string | null
  initialized: boolean
  company_name: string | null
  demo: boolean
}

export interface CommandResult {
  id: string
  type: string
  version: number
  name: string | null
  status: string | null
  state: State
  correlation_id: string
  events: { seq: number; type: string; stream: string; stream_id: string }[]
}

export interface Usage {
  db_bytes: number
  limit_bytes: number
  events: number
  records: number
  events_bytes: number
  records_bytes: number
}

export const COMPANY_ID = '00000000-0000-0000-0000-000000000001'

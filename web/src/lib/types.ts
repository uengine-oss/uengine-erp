export type FieldType =
  | 'text' | 'number' | 'money' | 'integer' | 'boolean' | 'date' | 'datetime'
  | 'enum' | 'ref' | 'refs' | 'tags' | 'json' | 'lines' | 'password'

export interface FieldOption { value: string; label: string; color?: string }

export interface Field {
  name: string
  /** Accepted by the command for API callers, but not something a person fills in on a form. */
  api_only?: boolean
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

export interface CommandDef {
  roles?: string[]
  label?: string
  params?: Field[]
  danger?: boolean
  confirm?: string
  /** A screen of its own or another program sends this; it is not one of the form's menu items. */
  api_only?: boolean
}

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
  /** false: the kernel refuses to roll this type back, so screens do not offer it. */
  revertible?: boolean
  /** Only records in these states can be picked for new work. Records in other states keep their names on old documents. */
  pick_states?: string[]
  /** Fields held outside the ledger, in a table only some roles can read. The record itself never carries their values. */
  private_fields?: Field[]
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
  /** The oldest app this database still accepts writes from. */
  min_app_version?: string | null
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
  /** The database's own reading of how full it is. */
  level?: 'ok' | 'near' | 'full'
  events: number
  records: number
  events_bytes: number
  records_bytes: number
}

/** One row of erp_modules(): the module's own document plus its current state. */
export interface ModuleDoc {
  id: string
  label: string
  label_en?: string
  description?: string
  sort?: number
  /** Asked when the module is turned on for the first time, drawn like catalog fields. */
  options?: Field[]
  /** Modules that must be on first. Turning one off under it is refused too. */
  requires?: string[]
  /** Said out loud before turning on: what the past cannot give back (scenario M6). */
  not_rebuilt?: string
  enabled: boolean
  enabled_at: string | null
  options_set: State
  stalled: number
}

export interface SkippedEvent { seq: number; event: string; error: string | null; reason: string; at: string }

/** One row of erp_bus_status(). */
export interface BusSubscription {
  name: string
  module: string
  active: boolean
  processed: number
  failures: number
  last_error: string | null
  last_error_seq: number | null
  last_error_at: string | null
  last_error_event: string | null
  last_run_at: string | null
  last_seq: number
  pending: boolean
  skipped: SkippedEvent[]
}

export interface BusTick { processed: number; failing: number; pending: number; paused?: boolean }

/** A forecast or what-if from erp_models(), reduced to what a module card needs. */
export interface ModelInfo { id: string; label: string; modules: string[] }

export type RollbackKind = 'correlation' | 'record' | 'time'

export interface RollbackStream {
  id: string
  type: string
  label: string | null
  name: string | null
  from_version: number
  to_version: number
  events: number
  from_status: string | null
  to_status: string | null
  removes: boolean
  effects: Record<string, unknown[]>
}

/** What erp_rollback_preview returns. The hash goes back with the apply, so nothing runs on a stale plan. */
export interface RollbackPlan {
  kind: RollbackKind
  streams: RollbackStream[]
  cascade: { correlation_id: string; at: string; actor: string | null; events: number; first_event: string }[]
  blocked: { id?: string; type?: string; name?: string | null; reason: string }[]
  warnings: { id: string; name: string | null; event: string; message: string }[]
  nothing_to_do: boolean
  hash: string
}

export interface RollbackResult { correlation_id: string; streams: number; cascade: number }

export const COMPANY_ID = '00000000-0000-0000-0000-000000000001'

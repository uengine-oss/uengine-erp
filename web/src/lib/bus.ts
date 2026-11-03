// What the admin screens know about modules and their subscriptions. One store, because the banner over
// every screen and the two settings screens must never disagree about whether something is stuck.
import { computed, reactive } from 'vue'
import { messageOf, rpc } from './api'
import { isAdmin } from './session'
import type { BusSubscription, ModelInfo, ModuleDoc } from './types'

export const bus = reactive({
  subs: [] as BusSubscription[],
  modules: [] as ModuleDoc[],
  loaded: false,
  loading: false,
  error: '',
})

let seq = 0

/** Only admins may read the bus; everyone else has nothing to load and sees no banner. */
export async function refreshBus(): Promise<void> {
  if (!isAdmin()) {
    bus.subs = []
    bus.modules = []
    bus.loaded = false
    return
  }
  const my = ++seq
  bus.loading = true
  try {
    const [subs, modules] = await Promise.all([rpc<BusSubscription[]>('erp_bus_status'), rpc<ModuleDoc[]>('erp_modules')])
    if (my !== seq) return
    bus.subs = subs
    bus.modules = modules
    bus.loaded = true
    bus.error = ''
  } catch (e) {
    if (my === seq) bus.error = messageOf(e)
  } finally {
    if (my === seq) bus.loading = false
  }
}

export const moduleLabel = (id: string): string => bus.modules.find((m) => m.id === id)?.label ?? id

export const isStalled = (s: BusSubscription): boolean => s.active && s.failures > 0 && s.last_error_seq !== null

export const stalls = computed(() => bus.subs.filter(isStalled))

const asText = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** Reads a model row without assuming more than an id and a list of modules. */
function toModel(row: Record<string, unknown>): ModelInfo | null {
  const id = asText(row.id) ?? asText(row.model) ?? asText(row.key)
  const modules = row.modules ?? row.requires ?? row.required_modules
  if (!id || !Array.isArray(modules)) return null
  return { id, label: asText(row.label) ?? asText(row.name) ?? id, modules: modules.map(String) }
}

/** Forecasts are a later module. Until erp_models() exists, the cards simply say nothing about them. */
export async function loadModels(): Promise<ModelInfo[]> {
  try {
    const rows = await rpc<unknown>('erp_models')
    if (!Array.isArray(rows)) return []
    return rows.map((r) => toModel(r as Record<string, unknown>)).filter((m): m is ModelInfo => !!m)
  } catch {
    return []
  }
}

// Reference ids render as names. All ids on a screen are resolved in one query rather than row by row.
import { reactive } from 'vue'
import { db } from './conn'
import { toApiError } from './api'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const refNames = reactive(new Map<string, string | null>())

// Ids whose name may have changed. They keep showing the old name until the new one arrives, so
// a live update never makes a screen flicker.
const stale = new Set<string>()

export async function ensureNames(ids: Iterable<unknown>): Promise<void> {
  const missing = new Set<string>()
  for (const id of ids) {
    if (typeof id === 'string' && UUID_RE.test(id) && (!refNames.has(id) || stale.has(id))) missing.add(id)
  }
  if (!missing.size) return
  const all = [...missing]
  for (let i = 0; i < all.length; i += 100) {
    const chunk = all.slice(i, i + 100)
    const { data, error, status } = await db().from('erp_records').select('id,name').in('id', chunk)
    if (error) throw toApiError(error, status)
    const found = new Map<string, string | null>((data ?? []).map((row) => [row.id, row.name]))
    const unresolved = chunk.filter((id) => !found.get(id))
    if (unresolved.length) {
      // Product variants live in their own view rather than as records.
      const variants = await db().from('erp_variants').select('id,name').in('id', unresolved)
      for (const row of variants.data ?? []) found.set(row.id, row.name)
    }
    for (const id of chunk) {
      refNames.set(id, found.get(id) ?? null)
      stale.delete(id)
    }
  }
}

/** Whole records, for columns whose choices come from the record another column points at. */
export const refStates = reactive(new Map<string, Record<string, any> | null>())

export async function ensureStates(ids: Iterable<unknown>): Promise<void> {
  const missing = [...new Set(ids)].filter((id): id is string => typeof id === 'string' && UUID_RE.test(id) && !refStates.has(id))
  if (!missing.length) return
  for (const id of missing) refStates.set(id, null)
  const { data } = await db().from('erp_records').select('id,state').in('id', missing)
  for (const row of data ?? []) refStates.set(row.id, row.state)
}

/** A missing id means deleted or hidden by read_roles; the browser cannot tell which and should not guess. */
export function refLabel(id: unknown): string {
  if (id === null || id === undefined || id === '') return ''
  const name = refNames.get(String(id))
  if (name) return name
  return refNames.has(String(id)) ? '(표시할 수 없음)' : '…'
}

export function forgetName(id: string): void {
  if (refNames.has(id)) stale.add(id)
  refStates.delete(id)
}

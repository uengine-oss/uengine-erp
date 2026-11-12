// The newest end of the ledger, for the strip along the bottom of the 관제 theme and the sequence number beside it.
// Read through the same view as every other screen, so it holds only what this person may read.
import { reactive } from 'vue'
import { db } from './conn'
import { toApiError } from './api'
import { timeView } from './mode'
import { ensureStreamNames } from './refs'
import type { ErpEvent } from './types'

const SIZE = 14

export const tail = reactive({ events: [] as ErpEvent[], lastSeq: 0, failed: false })

let asked = 0
export async function loadTail(): Promise<void> {
  const my = ++asked
  try {
    let q = db().from('erp_events').select('*')
    if (timeView.at) q = q.lte('occurred_at', timeView.at)
    const { data, error, status } = await q.order('seq', { ascending: false }).limit(SIZE)
    if (error) throw toApiError(error, status)
    const list = (data ?? []) as ErpEvent[]
    await ensureStreamNames(list)
    if (my !== asked) return
    tail.events = list
    tail.lastSeq = list[0]?.seq ?? 0
    tail.failed = false
  } catch {
    // The strip is a convenience: the page above it keeps working, and the strip says it has nothing to show.
    if (my === asked) tail.failed = true
  }
}

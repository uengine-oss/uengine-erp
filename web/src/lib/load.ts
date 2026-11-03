// One read for a screen: only the newest answer lands, and a failure leaves text that is safe to show.
import { ref, shallowRef } from 'vue'
import { messageOf, toApiError } from './api'

export function useLoad<T>(fetcher: () => Promise<T>) {
  const data = shallowRef<T | null>(null)
  const loading = ref(true)
  const error = ref('')
  let seq = 0
  async function load(): Promise<void> {
    const my = ++seq
    error.value = ''
    loading.value = true
    try {
      const value = await fetcher()
      if (my === seq) data.value = value
    } catch (e) {
      if (my !== seq) return
      data.value = null
      error.value = messageOf(e)
    } finally {
      if (my === seq) loading.value = false
    }
  }
  return { data, loading, error, load }
}

/** Unwraps a view query so its failure reads like any other failure. */
export async function rows<T>(query: PromiseLike<{ data: unknown; error: any; status?: number }>): Promise<T[]> {
  const { data, error, status } = await query
  if (error) throw toApiError(error, status)
  return (data ?? []) as T[]
}

/** The first and last day of this month in the company's calendar, for a report's first look. */
export function thisMonth(today: string): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${today.slice(0, 7)}-01`, to: `${today.slice(0, 7)}-${String(last).padStart(2, '0')}` }
}

// Live updates are a convenience: if the channel fails, every screen still works and reloads on demand.
import { onBeforeUnmount, reactive } from 'vue'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { db } from './conn'
import type { ErpEvent } from './types'

export const live = reactive({ status: 'off' as 'off' | 'connecting' | 'live' | 'down' })

type Listener = (ev: ErpEvent) => void
const listeners = new Set<Listener>()
let channel: RealtimeChannel | null = null
let channelClient: unknown = null

export async function startRealtime(): Promise<void> {
  const client = db()
  // Changing projects replaces the client, and the old channel went with it.
  if (channel && channelClient === client) return
  channelClient = client
  live.status = 'connecting'
  try {
    const { data } = await client.auth.getSession()
    if (data.session) client.realtime.setAuth(data.session.access_token)
    channel = client
      .channel('erp-events')
      .on('postgres_changes', { event: 'INSERT', schema: 'erp', table: 'events' }, (payload) => {
        const ev = payload.new as ErpEvent
        listeners.forEach((fn) => { try { fn(ev) } catch { /* one screen must not break the others */ } })
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') live.status = 'live'
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') live.status = 'down'
      })
  } catch {
    live.status = 'down'
  }
}

export function stopRealtime(): void {
  if (channel) {
    try { void db().removeChannel(channel) } catch { /* connection already gone */ }
  }
  channel = null
  channelClient = null
  live.status = 'off'
}

/** Listens for new ledger events for as long as the calling component is mounted. */
export function onLedgerEvent(fn: Listener): void {
  listeners.add(fn)
  onBeforeUnmount(() => { listeners.delete(fn) })
}

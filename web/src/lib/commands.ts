// The one place the app writes. Every command, rollback and bus action passes through here, so the version
// sent to the database, the read-only modes and the push that follows a write cannot be forgotten by a screen.
import { onBeforeUnmount } from 'vue'
import { ApiError, isDebuggerGlitch, rpc } from './api'
import { refreshBus } from './bus'
import { APP_VERSION } from './install'
import { writeBlock, writeBlockMessage } from './mode'
import { loadCatalog, refreshStatus } from './session'
import type { BusTick, CommandResult, RollbackKind, RollbackResult, State } from './types'

/** A failed call changed nothing, so this one known glitch gets a second try before anyone hears of it. */
async function once<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (e) {
    if (!isDebuggerGlitch(e)) throw e
    await wait(300)
    return call()
  }
}

function assertWritable(): void {
  if (writeBlock.value) throw new ApiError(writeBlockMessage.value, { code: 'READ_ONLY' })
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/* Screens that show data listen here: a subscriber's work or a rollback can change what they hold. */
type Listener = () => void
const listeners = new Set<Listener>()

function notifyChanged(): void {
  listeners.forEach((fn) => { try { fn() } catch { /* one screen must not break the others */ } })
}

/** Runs for as long as the calling component is mounted. Works without realtime. */
export function onDataChanged(fn: Listener): void {
  listeners.add(fn)
  onBeforeUnmount(() => { listeners.delete(fn) })
}

/*
 * Other modules work through subscriptions, which cron delivers within seconds. Pushing right after a command
 * lets the user see the result at once. Each call commits before the next can read what it wrote, so a chain
 * of modules takes several calls. A failure here is not the user's failure: their command already succeeded.
 */
const MAX_TICKS = 5
const TICK_DELAY_MS = 200
const CRON_DELAY_MS = 6_000
let ticksLeft = 0
let ticking = false
let moreWork = false

async function drainBus(): Promise<void> {
  ticking = true
  let delivered = false
  let left = false
  try {
    while (ticksLeft > 0) {
      ticksLeft--
      moreWork = false
      const tick = await rpc<BusTick>('erp_bus_tick')
      left = !!tick.pending
      // A command that finished while this call was out may not have been seen by it.
      if (!tick.pending && !moreWork) break
      if (ticksLeft > 0) await wait(TICK_DELAY_MS)
    }
    delivered = true
  } catch {
    /* cron delivers the rest */
  } finally {
    ticking = false
    ticksLeft = 0
  }
  // Also when this push delivered nothing: cron may have got there first, and realtime may be off.
  if (delivered) notifyChanged()
  void refreshBus()
  // Delivery can wait on a long transaction elsewhere. Cron gets it through, so look once more after that.
  if (delivered && left) {
    setTimeout(() => {
      notifyChanged()
      void refreshBus()
    }, CRON_DELAY_MS)
  }
}

export function nudgeBus(): void {
  // A command during a running push extends it rather than starting a second one.
  ticksLeft = MAX_TICKS
  moreWork = true
  if (!ticking) void drainBus()
}

export interface CommandArgs {
  type: string
  id?: string | null
  command: string
  payload?: State
  expectedVersion?: number | null
  reason?: string | null
}

export async function sendCommand<T = CommandResult>(args: CommandArgs): Promise<T> {
  assertWritable()
  try {
    const result = await once(() => rpc<T>('erp_command', {
      p_type: args.type,
      p_id: args.id ?? null,
      p_command: args.command,
      p_payload: args.payload ?? {},
      p_expected_version: args.expectedVersion ?? null,
      p_reason: args.reason ?? null,
      p_source: 'ui',
      p_app_version: APP_VERSION,
    }))
    nudgeBus()
    return result
  } catch (e) {
    const code = (e as ApiError).code
    if (code === 'ERP_APP_OUTDATED') void refreshStatus()
    if (code === 'ERP_MODULE_OFF') void loadCatalog().catch(() => {})
    throw e
  }
}

/** The one write open while looking at a past date: going back to that date is why someone is looking at it. */
export async function applyRollback(kind: RollbackKind, target: State, hash: string, allowCascade: boolean, reason: string): Promise<RollbackResult> {
  if (writeBlock.value !== 'time') assertWritable()
  const result = await once(() => rpc<RollbackResult>('erp_rollback_apply', {
    p_kind: kind, p_target: target, p_hash: hash, p_allow_cascade: allowCascade, p_reason: reason,
  }))
  notifyChanged()
  nudgeBus()
  return result
}

export async function retrySubscription(name: string): Promise<{ processed: number; failures: number; last_error: string | null }> {
  assertWritable()
  const result = await once(() => rpc<{ processed: number; failures: number; last_error: string | null }>('erp_bus_retry', { p_name: name }))
  if (result.processed > 0) notifyChanged()
  nudgeBus()
  return result
}

export async function skipSubscriptionEvent(name: string, reason: string): Promise<void> {
  assertWritable()
  await once(() => rpc('erp_bus_skip', { p_name: name, p_reason: reason }))
  nudgeBus()
}

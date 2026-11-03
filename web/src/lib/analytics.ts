// Everything the analytics screens share: the models' states, the ledger as read so far, and the worker thread that
// computes on it. The ledger is the one heavy read in the app, so it is kept until the date changes or someone asks again.
import { onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { messageOf, rpc } from './api'
import { loadLedger, type RpcFn } from './forecast/load.ts'
import type { LedgerMeta } from './forecast/run.ts'
import type { LedgerData, ModelId, ModelKind, ModelResult, ModelState } from './forecast/types.ts'
import { timeView } from './mode'
import { session } from './session'

export interface ModelRow {
  id: ModelId
  kind: ModelKind
  label: string
  state: ModelState
  missing_modules: string[]
  modules?: string[]
  stale_modules?: string[]
  forbidden?: boolean
  evidence: { have: number; need: number; unit: string; message: string; [more: string]: unknown }
  since: string | null
}

const asOf = (): string | null => timeView.at || null

export const fetchModels = (): Promise<ModelRow[]> => rpc<ModelRow[]>('erp_models', { p_as_of: asOf() })

export const ledger = reactive({
  phase: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
  /** Read batches so far, of how many. Zero total means the size is not known yet. */
  done: 0,
  total: 0,
  error: '',
  at: '',
  /** Bumped by every finished read, so screens know their last result is about an older ledger. */
  version: 0,
  /** Something happened after the read. The numbers are still right about the moment they were read at. */
  stale: false,
  meta: null as LedgerMeta | null,
})

/* The worker. One at a time is enough: a person starts one calculation and waits for it. */
let worker: Worker | null = null
let seq = 0
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function failAll(message: string) {
  for (const w of waiting.values()) w.reject(new Error(message))
  waiting.clear()
}

function theWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./forecast/worker.ts', import.meta.url), { type: 'module', name: 'forecast' })
  worker.onmessage = (e: MessageEvent<{ seq: number; ok: boolean; value?: unknown; message?: string }>) => {
    const w = waiting.get(e.data.seq)
    if (!w) return
    waiting.delete(e.data.seq)
    if (e.data.ok) w.resolve(e.data.value)
    else w.reject(new Error(e.data.message ?? '계산하지 못했습니다'))
  }
  worker.onerror = (e) => {
    e.preventDefault()
    worker?.terminate()
    worker = null
    ledger.phase = 'idle'
    failAll('계산 중에 문제가 생겼습니다. 다시 시도하세요')
  }
  return worker
}

function ask<T>(message: Record<string, unknown>): Promise<T> {
  const my = ++seq
  return new Promise<T>((resolve, reject) => {
    waiting.set(my, { resolve: resolve as (v: unknown) => void, reject })
    theWorker().postMessage({ seq: my, ...message })
  })
}

// Company figures must not outlive the session that was allowed to read them.
watch(() => session.me, (me) => {
  if (me) return
  worker?.terminate()
  worker = null
  failAll('로그아웃했습니다')
  Object.assign(ledger, { phase: 'idle', done: 0, total: 0, error: '', at: '', stale: false, meta: null })
})

let reading: Promise<void> | null = null
let readingAt: string | null = null
let readNo = 0

/** Makes sure the ledger as of the date on screen has been read. Safe to call from every panel. */
export function ensureLedger(force = false): Promise<void> {
  const at = timeView.at
  if (!force && ledger.phase === 'ready' && ledger.at === at) return Promise.resolve()
  if (reading && readingAt === at && !force) return reading
  const my = ++readNo
  readingAt = at
  ledger.phase = 'loading'
  ledger.done = 0
  ledger.total = 0
  ledger.error = ''
  reading = (async () => {
    try {
      const data: LedgerData = await loadLedger(rpc as RpcFn, {
        asOf: at || null,
        onProgress: (done, total) => { if (my === readNo) { ledger.done = done; ledger.total = total } },
      })
      const meta = await ask<LedgerMeta>({ kind: 'load', data })
      if (my !== readNo) return
      ledger.meta = meta
      ledger.at = at
      ledger.stale = false
      ledger.phase = 'ready'
      ledger.version++
    } catch (e) {
      if (my !== readNo) return
      ledger.phase = 'error'
      ledger.error = e instanceof Error && !('code' in e) ? e.message : messageOf(e)
    } finally {
      if (my === readNo) reading = null
    }
  })()
  return reading
}

export const runInWorker = <R>(id: ModelId, input: object): Promise<ModelResult<R>> => ask<ModelResult<R>>({ kind: 'run', id, input })
export const stockAtDate = (): Promise<{ variant_id: string; warehouse_id: string | null; qty: number }[]> => ask({ kind: 'stock' })

/** A model result and the state of getting it. A later run replaces an earlier one, whichever finishes first. */
export function useModelRun<R>(id: () => ModelId) {
  const result = shallowRef<ModelResult<R> | null>(null)
  const running = ref(false)
  const seconds = ref(0)
  const error = ref('')
  let my = 0
  let clock: ReturnType<typeof setInterval> | undefined

  async function run(input: object): Promise<void> {
    const mine = ++my
    running.value = true
    error.value = ''
    seconds.value = 0
    clearInterval(clock)
    clock = setInterval(() => { seconds.value++ }, 1000)
    try {
      await ensureLedger()
      if (mine !== my) return
      if (ledger.phase !== 'ready') { result.value = null; return }
      const out = await runInWorker<R>(id(), input)
      if (mine === my) result.value = out
    } catch (e) {
      if (mine === my) { result.value = null; error.value = e instanceof Error && !('code' in e) ? e.message : messageOf(e) }
    } finally {
      if (mine === my) { running.value = false; clearInterval(clock) }
    }
  }
  function clear() { my++; result.value = null; error.value = ''; running.value = false; clearInterval(clock) }
  onBeforeUnmount(() => { my++; clearInterval(clock) })
  return { result, running, seconds, error, run, clear }
}

/** Runs on arrival if the ledger is already read, and otherwise as soon as it is, and again whenever it is read anew. */
export function runOnLedger(run: () => void): void {
  onMounted(() => {
    if (ledger.phase === 'ready' && ledger.at === timeView.at) run()
    else void ensureLedger()
  })
  watch(() => ledger.version, () => run())
  watch(() => timeView.at, () => { void ensureLedger() })
}

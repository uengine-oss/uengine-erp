// Sends the made-up company's three years to the database, in batches small enough for the API's time limit. Each batch
// is one transaction, so anything that goes wrong can be sent again whole.
import { isDebuggerGlitch, rpc, toApiError, type ApiError } from '../api'
import { conn, db } from '../conn'
import { refreshStatus } from '../session'
import { DEFAULT_STAGES, generate, type DemoStages, type DemoStep } from './generate.ts'
import { dayOf } from './world.ts'

const BATCH = 300
const MIN_BATCH = 20
const RETRIES = 6
// The API stops a statement after 8 seconds.
const STILL_RUNNING_MS = 9000
const PROGRESS_KEY = 'erp.demo.progress'
// A shorter story, so the browser tests need not wait for three years.
const STAGES_KEY = 'erp.demo.stages'

export interface DemoProgress {
  /** The business day reached so far. */
  day: string
  percent: number
  steps: number
  /** Modules the story has turned on so far, with the day. */
  modules: { id: string; day: string }[]
}

interface Saved { url: string; applied: number; sending: number; seq: number }

function readSaved(): Saved | null {
  try {
    const s = JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? 'null') as Saved | null
    return s && s.url === conn.value?.url ? s : null
  } catch { return null }
}
function writeSaved(applied: number, sending: number, seq: number) {
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify({ url: conn.value?.url, applied, sending, seq })) } catch { /* it just cannot resume */ }
}
function clearSaved() {
  try { localStorage.removeItem(PROGRESS_KEY) } catch { /* nothing kept */ }
}

/** The newest event. A batch is one transaction, so if this moved, the whole batch landed even though its answer was lost. */
async function latestSeq(): Promise<number> {
  const { data, error, status } = await db().from('erp_events').select('seq').order('seq', { ascending: false }).limit(1)
  if (error) throw toApiError(error, status)
  return Number(data?.[0]?.seq ?? 0)
}

/**
 * Whether a batch sent after `before` landed. A request the browser gave up on keeps running in the database until it
 * commits or meets the API's time limit, so this says no only once it can no longer be running.
 */
async function landed(before: number): Promise<boolean> {
  const deadline = Date.now() + STILL_RUNNING_MS
  for (;;) {
    if ((await latestSeq()) > before) return true
    if (Date.now() >= deadline) return false
    await wait(1000)
  }
}

function stages(): DemoStages {
  try {
    const s = JSON.parse(localStorage.getItem(STAGES_KEY) ?? 'null') as DemoStages | null
    return s?.end ? s : DEFAULT_STAGES
  } catch { return DEFAULT_STAGES }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const isTimeout = (e: unknown) => (e as ApiError)?.code === 'TIMEOUT'

export class DemoBuild {
  stopped = false
  private target = BATCH
  private applied = 0

  constructor(private onProgress: (p: DemoProgress) => void) {}

  /** Asks the running build to stop after the batch on its way. What was sent stays, and it can pick up from there. */
  stop() { this.stopped = true }

  /** One batch. Too slow for the time limit: split in two. A known glitch or a lost connection: send it again. */
  private async send(steps: DemoStep[]): Promise<void> {
    let before: number | null = null
    let unsure = false
    for (let attempt = 0; ; attempt++) {
      try {
        if (before === null) {
          before = await latestSeq()
          writeSaved(this.applied, steps.length, before)
        }
        // A lost connection can also mean a lost answer, and a batch that landed must not be sent twice.
        if (unsure && (await landed(before))) break
        unsure = false
        await rpc('erp_demo_apply', { p_steps: steps })
        break
      } catch (e) {
        if (isTimeout(e) && steps.length > MIN_BATCH) {
          const half = Math.ceil(steps.length / 2)
          this.target = Math.max(MIN_BATCH, Math.min(this.target, half))
          await this.send(steps.slice(0, half))
          await this.send(steps.slice(half))
          return
        }
        const lost = !!(e as ApiError)?.network
        if ((!lost && !isDebuggerGlitch(e)) || attempt >= RETRIES) {
          if (!lost) writeSaved(this.applied, 0, 0) // The database said no, so none of it landed.
          throw e
        }
        unsure = unsure || lost
        await wait(500 * (attempt + 1))
      }
    }
    this.applied += steps.length
    writeSaved(this.applied, 0, 0)
  }

  /** Runs to the end, or until stop(). Returns true when the company is finished. */
  async run(fresh: boolean): Promise<boolean> {
    const plan = stages()
    const first = dayOf('2023-11-01')
    const last = dayOf(plan.end)
    if (fresh) {
      clearSaved()
      await rpc('erp_demo_begin')
      // From here on this company is a demo, and every screen should say so.
      await refreshStatus()
    }
    const saved = readSaved()
    if (!fresh && !saved) await rpc('erp_demo_begin') // Another browser began it. The database says what it thinks of that.
    // The story is the same every time, so what was already sent can be counted off from the front.
    let skip = saved?.applied ?? 0
    if (saved?.sending && (await landed(saved.seq))) skip += saved.sending
    this.applied = skip
    let pending: DemoStep[] = []
    const modules: DemoProgress['modules'] = []
    let day = '2023-11-01'

    const flush = async () => {
      if (!pending.length) return
      const batch = pending
      pending = []
      await this.send(batch)
      this.onProgress({ day, percent: Math.min(99, Math.round(((dayOf(day) - first) / Math.max(1, last - first)) * 100)), steps: this.applied, modules: [...modules] })
    }

    for (const steps of generate(1, plan)) {
      for (const step of steps) {
        day = step.at.slice(0, 10)
        if (step.kind === 'cmd' && step.type === 'module' && step.command === 'enable') {
          const id = (step.payload as { id?: string })?.id
          if (id) modules.push({ id, day })
        }
        if (skip > 0) { skip--; continue }
        pending.push(step)
        if (pending.length >= this.target) {
          await flush()
          if (this.stopped) return false
        }
      }
    }
    await flush()
    if (this.stopped) return false
    await rpc('erp_demo_end')
    clearSaved()
    return true
  }
}

/** Stops where it is. What was made stays, and the bus runs again. */
export async function finishHere(): Promise<void> {
  await rpc('erp_demo_end')
  clearSaved()
}

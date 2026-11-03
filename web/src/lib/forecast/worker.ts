// Runs on its own thread: a model can take a second or more, and the screen must keep answering meanwhile.
import { buildPanel, type Panel } from './panel.ts'
import { metaOf, runModel, stockAt } from './run.ts'
import type { LedgerData, ModelId } from './types.ts'

type Request =
  | { seq: number; kind: 'load'; data: LedgerData }
  | { seq: number; kind: 'run'; id: ModelId; input: Record<string, unknown> }
  | { seq: number; kind: 'stock' }

let panel: Panel | null = null
let ledger: LedgerData | null = null

self.onmessage = (e: MessageEvent<Request>) => {
  const req = e.data
  try {
    let value: unknown
    if (req.kind === 'load') {
      ledger = req.data
      panel = buildPanel(req.data)
      value = metaOf(req.data)
    } else if (!panel || !ledger) {
      throw new Error('원장을 아직 읽지 않았습니다')
    } else if (req.kind === 'stock') {
      value = stockAt(ledger)
    } else {
      value = runModel(panel, req.id, req.input)
    }
    self.postMessage({ seq: req.seq, ok: true, value })
  } catch (err) {
    self.postMessage({ seq: req.seq, ok: false, message: err instanceof Error ? err.message : String(err) })
  }
}

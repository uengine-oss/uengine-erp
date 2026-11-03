import { rpc } from './api'
import { APP_VERSION } from './install'
import { session } from './session'

interface ExportBatch { rows: unknown[]; sequences: Record<string, number>; next: number | null }

/**
 * Streams the whole ledger into a gzip file in batches, because the API cuts statements at 8 seconds.
 * First line: file metadata. Middle lines: one event each. Last line: number sequences.
 */
export async function exportLedger(onProgress: (count: number) => void): Promise<{ blob: Blob; count: number; gz: boolean }> {
  const gz = typeof CompressionStream !== 'undefined'
  const encoder = new TextEncoder()
  const chunks: BlobPart[] = []
  const stream = gz ? new CompressionStream('gzip') : null
  const writer = stream?.writable.getWriter()
  const finished = stream ? new Response(stream.readable).blob() : null
  const write = async (obj: unknown) => {
    const bytes = encoder.encode(`${JSON.stringify(obj)}\n`)
    if (writer) { await writer.ready; await writer.write(bytes) } else chunks.push(bytes)
  }

  await write({ _meta: 'uengine-erp-ledger', app_version: APP_VERSION, schema_version: session.status?.version ?? null, company: session.company?.state?.name ?? null, exported_at: new Date().toISOString() })
  let after = 0
  let count = 0
  let sequences: Record<string, number> = {}
  for (;;) {
    const batch = await rpc<ExportBatch>('erp_export_events', { p_after: after, p_limit: 2000 })
    for (const row of batch.rows) await write(row)
    count += batch.rows.length
    sequences = batch.sequences
    onProgress(count)
    if (!batch.next) break
    after = batch.next
  }
  await write({ _meta: 'sequences', sequences, events: count })
  if (writer && finished) {
    await writer.close()
    return { blob: await finished, count, gz }
  }
  return { blob: new Blob(chunks, { type: 'application/x-ndjson' }), count, gz }
}

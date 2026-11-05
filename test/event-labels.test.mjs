// Every event a person can meet in the ledger has a Korean name. A raw event name on the screen reads as a fault, and only a person looking would catch it.
// The names live in web/src/lib/eventLabels.json, which the screens and SQL both read (test/process-log.test.mjs checks the two agree).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const labels = JSON.parse(readFileSync(new URL('../web/src/lib/eventLabels.json', import.meta.url), 'utf8'))
const named = new Set(Object.keys(labels.exact))
const sqlDir = new URL('../sql/', import.meta.url)

test('every event in the SQL has a label', () => {
  const events = new Set()
  for (const f of readdirSync(sqlDir).filter((x) => x.endsWith('.sql'))) {
    const s = readFileSync(new URL(f, sqlDir), 'utf8')
    for (const m of s.matchAll(/erp\.emit\(\s*[^,]+,\s*[^,]+,\s*'([A-Z][A-Za-z0-9]+)'/g)) events.add(m[1])
    for (const m of s.matchAll(/"event":\s*"([A-Z][A-Za-z0-9]+)"/g)) events.add(m[1])
  }
  assert.ok(events.size > 100, 'the search found the events')
  assert.deepEqual([...events].filter((e) => !named.has(e)).sort(), [])
})

test('the screen reads its words from the shared file, not from a copy of its own', () => {
  const text = readFileSync(new URL('../web/src/lib/eventText.ts', import.meta.url), 'utf8')
  assert.match(text, /from '\.\/eventLabels'/)
  assert.ok(![...text.matchAll(/\b([A-Z][A-Za-z0-9]+):\s*'/g)].length, 'no event names written into eventText.ts')
})

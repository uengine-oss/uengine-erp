// The install in parts: the cloud SQL Editor refuses the whole script, so the same files also go out in six parts cut at
// module boundaries. Run in order on an empty database they build exactly what the whole script builds, and the app is told
// "not installed yet" until the last one has run.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { freshDb } from './lib/harness.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist-sql')
const ADMIN_URL = process.env.ERP_TEST_PG || 'postgres://postgres:postgres@127.0.0.1:56322/postgres'
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'web', 'src', 'generated', 'install-parts.json'), 'utf8'))
const name = `erp_parts_${process.pid}_${crypto.randomBytes(2).toString('hex')}`
const urlFor = (db) => { const u = new URL(ADMIN_URL); u.pathname = '/' + db; return u.toString() }
const admin = new pg.Client({ connectionString: ADMIN_URL })
await admin.connect()
await admin.query(`create database ${name}`)
const db = new pg.Client({ connectionString: urlFor(name) })
await db.connect()
await db.query(fs.readFileSync(path.join(root, 'test', 'lib', 'shim.sql'), 'utf8'))
const status = async () => (await db.query('select public.erp_status() as s')).rows[0].s
// Tables, columns, functions with their arguments, views and policies: what the app and the tests can tell apart.
const SHAPE = `
  select 'col ' || table_schema || '.' || table_name || '.' || column_name || ' ' || data_type from information_schema.columns where table_schema in ('erp', 'public')
  union all select 'fn ' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('erp', 'public')
  union all select 'policy ' || schemaname || '.' || tablename || '.' || policyname from pg_policies where schemaname in ('erp', 'public')
  union all select 'trigger ' || event_object_schema || '.' || event_object_table || '.' || trigger_name from information_schema.triggers where event_object_schema in ('erp', 'public')
  order by 1`
const shape = async (c) => (await c.query(SHAPE)).rows.map((r) => Object.values(r)[0])

after(async () => {
  await db.end()
  await admin.query(`drop database if exists ${name} with (force)`)
  await admin.end()
})

test('the parts cover every file once, in order, and each fits the SQL Editor', () => {
  const files = fs.readdirSync(path.join(root, 'sql')).filter((f) => /^\d+.*\.sql$/.test(f)).sort()
  assert.deepEqual(manifest.flatMap((p) => p.files), files)
  assert.equal(manifest[0].label, '기본(판매)')
  assert.ok(manifest[0].files.includes('30_sales.sql'), 'sales is in the first part')
  for (const p of manifest) assert.ok(p.bytes <= 450 * 1024, `part ${p.n} is ${p.bytes} bytes`)
})

test('run in order, they say "not yet" until the last part, then build what the whole script builds', async () => {
  for (const p of manifest) {
    await db.query(fs.readFileSync(path.join(dist, p.file), 'utf8'))
    const s = await status()
    assert.deepEqual(s.install.done, manifest.slice(0, p.n).map((x) => x.n), `after part ${p.n}`)
    assert.equal(s.install.total, manifest.length)
    assert.equal(s.installed, p.n === manifest.length, `installed after part ${p.n}`)
  }
  const whole = await freshDb()
  try {
    assert.deepEqual(await shape(db), await shape(whole.client), 'same tables, columns, functions, policies and triggers as the whole script')
    const count = 'select (select count(*) from erp.catalog)::int as catalog, (select count(*) from erp.modules)::int as modules, (select count(*) from erp.subscriptions)::int as subs'
    assert.deepEqual((await db.query(count)).rows[0], (await whole.query(count)).rows[0], 'same catalog, modules and subscriptions')
    assert.equal((await whole.query('select public.erp_status() as s')).rows[0].s.installed, true, 'the whole script counts as installed too')
  } finally { await whole.close() }
})

test('a part run again changes nothing; a part of a newer version starts the count again', async () => {
  await db.query(fs.readFileSync(path.join(dist, manifest[2].file), 'utf8'))
  assert.equal((await status()).installed, true)
  await db.query(`select erp.install_part_done(1, ${manifest.length}, '999.0.0')`)
  const s = await status()
  assert.equal(s.installed, false, 'an upgrade half done is not installed')
  assert.deepEqual(s.install, { version: '999.0.0', total: manifest.length, done: [1] })
})

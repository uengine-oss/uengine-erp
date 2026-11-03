// Gives each test file its own throwaway database cloned from a template built from install.sql,
// and lets a test act as a specific Supabase user the same way PostgREST would (role + JWT claims).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const ADMIN_URL = process.env.ERP_TEST_PG || 'postgres://postgres:postgres@127.0.0.1:56322/postgres'

function urlFor(db) {
  const u = new URL(ADMIN_URL)
  u.pathname = '/' + db
  return u.toString()
}

async function withAdmin(fn) {
  const c = new pg.Client({ connectionString: ADMIN_URL })
  await c.connect()
  try { return await fn(c) } finally { await c.end() }
}

async function ensureTemplate() {
  const sql = fs.readFileSync(process.env.ERP_SQL_OUT || path.join(root, 'dist-sql', 'install.sql'), 'utf8')
  const shim = fs.readFileSync(path.join(here, 'shim.sql'), 'utf8')
  const hash = crypto.createHash('sha1').update(shim + sql).digest('hex').slice(0, 10)
  const tpl = `erp_tpl_${hash}`
  await withAdmin(async (a) => {
    // One builder at a time across parallel test files.
    await a.query('select pg_advisory_lock(7310042)')
    try {
      const { rowCount } = await a.query('select 1 from pg_database where datname = $1', [tpl])
      if (rowCount) return
      const building = `${tpl}_b`
      await a.query(`drop database if exists ${building} with (force)`)
      await a.query(`create database ${building}`)
      const c = new pg.Client({ connectionString: urlFor(building) })
      await c.connect()
      try {
        await c.query(shim)
        await c.query(sql)
      } finally { await c.end() }
      await a.query(`alter database ${building} rename to ${tpl}`)
    } finally { await a.query('select pg_advisory_unlock(7310042)') }
  })
  return tpl
}

export class Tx extends Error {}

export async function freshDb() {
  const tpl = await ensureTemplate()
  const name = `erp_t_${process.pid}_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`
  await withAdmin(async (a) => {
    await a.query('select pg_advisory_lock(7310043)')
    try { await a.query(`create database ${name} template ${tpl}`) } finally { await a.query('select pg_advisory_unlock(7310043)') }
  })
  const client = new pg.Client({ connectionString: urlFor(name) })
  await client.connect()

  // Runs one statement the way PostgREST does: new transaction, role switch, JWT claims.
  async function asUser(userId, sqlText, params = [], role = 'authenticated') {
    await client.query('begin')
    try {
      await client.query(`set local role ${role}`)
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [userId ? JSON.stringify({ sub: userId, role }) : ''])
      const res = await client.query(sqlText, params)
      await client.query('commit')
      return res
    } catch (e) {
      await client.query('rollback')
      throw e
    }
  }

  const db = {
    name,
    client,
    query: (s, p) => client.query(s, p),
    asUser,
    close: async () => {
      await client.end()
      await withAdmin((a) => a.query(`drop database if exists ${name} with (force)`))
    },
  }
  return db
}

// Installs a company with one admin and returns helpers bound to users.
export async function company(opts = {}) {
  const db = await freshDb()
  await db.query(`select erp.set_setup_code('test-code')`)
  const boot = await db.asUser(null, `select public.erp_bootstrap($1, $2, $3, $4, $5) as r`,
    ['test-code', JSON.stringify({ name: '시험 회사', currency: opts.currency || 'KRW', decimal_places: opts.decimal_places ?? 0, modules: opts.modules === undefined ? 'all' : opts.modules }), 'admin@test.co', 'password123', '관리자'], 'anon')
  const adminId = boot.rows[0].r.user_id

  async function cmd(userId, type, id, command, payload = {}, opt = {}) {
    const { rows } = await db.asUser(userId, `select public.erp_command($1, $2, $3, $4, $5, $6, $7, $8) as r`,
      [type, id, command, JSON.stringify(payload), opt.expected ?? null, opt.reason ?? null, opt.source ?? 'test', opt.correlation ?? null])
    return rows[0].r
  }
  const admin = (type, id, command, payload, opt) => cmd(adminId, type, id, command, payload, opt)

  async function addMember(name, roles) {
    const email = `${name}@test.co`
    const r = await admin('member', null, 'create', { name, email, password: 'password123', roles })
    return { id: r.state.user_id, record: r.id, cmd: (type, id, command, payload, opt) => cmd(r.state.user_id, type, id, command, payload, opt) }
  }
  async function rec(id) {
    const { rows } = await db.query('select * from erp.records where id = $1', [id])
    return rows[0]
  }
  async function list(type) {
    const { rows } = await db.query('select * from erp.records where type = $1 and not deleted order by created_at, id', [type])
    return rows
  }
  async function events(id) {
    const { rows } = await db.query('select * from erp.events where stream_id = $1 order by version', [id])
    return rows
  }
  // Every test can assert the core promise: the projection equals a replay of the ledger.
  async function verifyProjection() {
    const { rows } = await db.query(`select id, type, state, erp.fold(id) as folded from erp.records`)
    return rows.filter((r) => JSON.stringify(sortKeys(r.state)) !== JSON.stringify(sortKeys(r.folded))).map((r) => ({ id: r.id, type: r.type }))
  }
  // Runs the bus the way cron does until nothing is left; each pass is its own transaction, so chains advance.
  // An open transaction anywhere in the cluster, such as a parallel test file's, can delay delivery for a moment.
  async function settle(timeoutMs = 10000) {
    const end = Date.now() + timeoutMs
    let last
    do {
      last = (await db.query('select erp.bus_run(5000) r')).rows[0].r
      if (!last.processed && !last.pending) return last
      if (!last.processed) await new Promise((r) => setTimeout(r, 20))
    } while (Date.now() < end)
    throw new Error(`bus did not settle: ${JSON.stringify(last)}`)
  }
  return { db, adminId, cmd, admin, addMember, rec, list, events, verifyProjection, settle, close: db.close }
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  return v
}

export async function rejects(promise, code) {
  try { await promise } catch (e) {
    if (!String(e.message).includes(code)) throw new Error(`expected ${code}, got: ${e.message}`)
    return e
  }
  throw new Error(`expected rejection ${code}, but it succeeded`)
}

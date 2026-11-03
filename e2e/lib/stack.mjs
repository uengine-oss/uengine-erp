// Helpers that touch the real local stack directly: only what a person would do outside the app.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { LOCAL_PG, resetLocal } from '../../scripts/reset-local.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export const API_URL = process.env.API_URL
export const PUBLISHABLE_KEY = process.env.PUBLISHABLE_KEY
export const ANON_KEY = process.env.ANON_KEY
if (!API_URL || !PUBLISHABLE_KEY || !ANON_KEY) throw new Error('source scripts/local-env.sh first')

export const ADMIN = { name: '김대표', email: 'owner@example.com', password: 'owner-pass-1234' }
export const COMPANY = '한빛정밀 주식회사'

export const inviteHash = (key = PUBLISHABLE_KEY) => `#/connect?u=${encodeURIComponent(API_URL)}&k=${encodeURIComponent(key)}`

export async function sql(text, params = []) {
  const c = new pg.Client({ connectionString: LOCAL_PG })
  await c.connect()
  try { return await c.query(text, params) } finally { await c.end() }
}

/** The same SQL the web build embeds, so tests install exactly what the app hands to a user. */
export const installScript = () => fs.readFileSync(path.join(root, 'web', 'src', 'generated', 'install.sql'), 'utf8')

const headers = (token) => ({ apikey: ANON_KEY, Authorization: `Bearer ${token ?? ANON_KEY}`, 'Content-Type': 'application/json' })
export const rest = (fn, body, token) => fetch(`${API_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: headers(token), body: JSON.stringify(body ?? {}) })

export async function waitFor(check, what, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/**
 * Dropping and reinstalling within a moment makes PostgREST's schema cache swing back once: measured
 * 404, 200, 404, 200. Real installs never drop anything, so only tests wait for it to settle.
 */
export async function waitForInstalled() {
  let streak = 0
  await waitFor(async () => {
    streak = (await rest('erp_status')).status === 200 ? streak + 1 : 0
    return streak >= 8
  }, 'the API to settle on the installed schema', 120)
}

/** Nothing installed, and the API has noticed. */
export async function wipe() {
  await resetLocal()
  await waitFor(async () => (await rest('erp_status')).status === 404, 'PostgREST to drop erp_status')
}

/**
 * Installs and creates the company without the browser, for specs that test what comes after setup.
 * `since` backdates the company, for specs that look at or go back to a date while it already existed.
 */
export async function freshCompany({ since } = {}) {
  await wipe()
  await sql(installScript())
  await sql(`select erp.set_setup_code('test-setup-code')`)
  await waitForInstalled()
  const company = { name: COMPANY, currency: 'KRW', decimal_places: 0, timezone: 'Asia/Seoul' }
  if (since) {
    await sql(`with c as materialized (select set_config('erp.clock', $1, true)) select public.erp_bootstrap('test-setup-code', $2::jsonb, $3, $4, $5) from c`,
      [since, JSON.stringify(company), ADMIN.email, ADMIN.password, ADMIN.name])
    return
  }
  const r = await rest('erp_bootstrap', { p_setup_code: 'test-setup-code', p_company: company, p_email: ADMIN.email, p_password: ADMIN.password, p_name: ADMIN.name })
  if (r.status !== 200) throw new Error(`bootstrap failed: ${await r.text()}`)
}

export async function tokenFor(email, password) {
  const r = await fetch(`${API_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })
  if (r.status !== 200) throw new Error(`login failed for ${email}`)
  return (await r.json()).access_token
}

/** Runs a command as the given user through the public API, as another person's browser would. */
export async function command(token, type, id, cmd, payload = {}, extra = {}) {
  const r = await rest('erp_command', { p_type: type, p_id: id, p_command: cmd, p_payload: payload, ...extra }, token)
  const body = await r.json()
  if (r.status !== 200) throw new Error(`${type}.${cmd}: ${body.message}`)
  return body
}

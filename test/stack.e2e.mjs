// Runs against the real local Supabase stack (PostgREST + GoTrue with email confirmation ON, as on the
// free cloud plan) using only the public key, exactly as the browser app does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
const URL_ = process.env.API_URL, KEY = process.env.ANON_KEY
const code = process.env.SETUP_CODE
const rest = (path, body, token, method = 'POST') => fetch(`${URL_}/rest/v1/${path}`, {
  method, headers: { apikey: KEY, Authorization: `Bearer ${token || KEY}`, 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined })
const login = async (email, password) => {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })
  return { status: r.status, body: await r.json() }
}
const stamp = Date.now()
const adminEmail = `owner-${stamp}@example.com`
let adminToken

test('anon can ask whether the ERP is installed', async () => {
  const r = await rest('rpc/erp_status', {})
  assert.equal(r.status, 200)
  const s = await r.json()
  assert.equal(s.installed, true)
})

test('a wrong setup code cannot claim the company', async () => {
  const r = await rest('rpc/erp_bootstrap', { p_setup_code: 'nope', p_company: {}, p_email: 'x@example.com', p_password: 'password123', p_name: 'x' })
  assert.equal(r.status, 400)
  assert.match((await r.json()).message, /ERP_SETUP_CODE/)
})

test('bootstrap creates an admin who can sign in without any email being sent', async () => {
  const r = await rest('rpc/erp_bootstrap', { p_setup_code: code, p_company: { name: '실스택 회사' }, p_email: adminEmail, p_password: 'password123', p_name: '대표' })
  assert.equal(r.status, 200, await r.clone().text())
  const l = await login(adminEmail, 'password123')
  assert.equal(l.status, 200, JSON.stringify(l.body))
  adminToken = l.body.access_token
  const me = await (await rest('rpc/erp_me', {}, adminToken)).json()
  assert.deepEqual(me.roles, ['admin'])
})

test('admin adds an employee who can sign in immediately, with no email', async () => {
  const r = await rest('rpc/erp_command', { p_type: 'member', p_id: null, p_command: 'create', p_payload: { name: '직원', email: `staff-${stamp}@example.com`, password: 'password123', roles: ['sales'] } }, adminToken)
  assert.equal(r.status, 200, await r.clone().text())
  const l = await login(`staff-${stamp}@example.com`, 'password123')
  assert.equal(l.status, 200, JSON.stringify(l.body))
})

test('public key alone reads nothing through the REST API', async () => {
  for (const view of ['erp_records', 'erp_events', 'erp_members']) {
    const r = await fetch(`${URL_}/rest/v1/${view}?select=*`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })
    assert.ok([401, 403].includes(r.status), `${view} -> ${r.status}`)
  }
})

test('the private schema and base tables are unreachable through REST', async () => {
  const r = await fetch(`${URL_}/rest/v1/events?select=*`, { headers: { apikey: KEY, Authorization: `Bearer ${adminToken}`, 'Accept-Profile': 'erp' } })
  assert.equal(r.status, 406)
})

test('a member reads through views but cannot write to them', async () => {
  const r = await fetch(`${URL_}/rest/v1/erp_records?select=id,type&limit=2`, { headers: { apikey: KEY, Authorization: `Bearer ${adminToken}` } })
  assert.equal(r.status, 200)
  assert.ok((await r.json()).length > 0)
  const w = await rest('erp_events', { stream_type: 'x', stream_id: '11111111-1111-4111-8111-111111111111', version: 1, event_type: 'Fake' }, adminToken)
  assert.ok([401, 403].includes(w.status), `insert -> ${w.status}`)
  const d = await fetch(`${URL_}/rest/v1/erp_records?type=eq.company`, { method: 'DELETE', headers: { apikey: KEY, Authorization: `Bearer ${adminToken}` } })
  assert.ok([401, 403].includes(d.status), `delete -> ${d.status}`)
})

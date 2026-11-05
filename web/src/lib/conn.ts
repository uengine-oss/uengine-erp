// Connection details live only in this browser. The app has no server, so nothing here leaves the device
// except requests to the project the user chose.
import { reactive, ref } from 'vue'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export interface Conn { url: string; key: string }

const CONN_KEY = 'erp.connection'
const SESSION_KEY = 'erp.session'
const SETUP_KEY = 'erp.setup'

export const SECRET_KEY_MESSAGE = '이 키는 공개하면 안 되는 키입니다. Publishable(공개) 키를 넣으세요'

export type KeyKind = 'publishable' | 'anon' | 'secret' | 'invalid'

function decodeJwtPayload(part: string): Record<string, unknown> | null {
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')), (c) => c.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

/** Runs before any network call, so a secret key pasted by mistake is never sent or stored. */
export function classifyKey(raw: string): KeyKind {
  const key = raw.trim()
  if (/^sb_secret_/i.test(key)) return 'secret'
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return 'publishable'
  const parts = key.split('.')
  if (parts.length === 3) {
    const payload = decodeJwtPayload(parts[1])
    if (payload?.role === 'service_role') return 'secret'
    if (payload?.role === 'anon') return 'anon'
  }
  return 'invalid'
}

export type UrlCheck = { ok: true; url: string } | { ok: false; message: string }

/** Only hosts the Content-Security-Policy in index.html allows, so a bad address fails here with a clear message. */
export function normalizeUrl(raw: string): UrlCheck {
  let text = raw.trim()
  const fromDashboard = text.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i)
  if (fromDashboard) text = `https://${fromDashboard[1]}.supabase.co`
  const bad: UrlCheck = { ok: false, message: 'https://프로젝트ID.supabase.co 형식의 Project URL 을 넣으세요' }
  let u: URL
  try { u = new URL(text) } catch { return bad }
  if (u.protocol === 'https:' && /^[a-z0-9-]+\.supabase\.co$/i.test(u.hostname)) return { ok: true, url: u.origin }
  if (u.protocol === 'http:' && u.hostname === '127.0.0.1') return { ok: true, url: u.origin }
  return bad
}

export function projectRef(url: string | undefined): string | null {
  const m = url?.match(/^https:\/\/([a-z0-9-]+)\.supabase\.co/i)
  return m ? m[1] : null
}
export function dashboardUrl(url: string | undefined): string {
  const ref = projectRef(url)
  return ref ? `https://supabase.com/dashboard/project/${ref}` : 'https://supabase.com/dashboard/projects'
}
export function sqlEditorUrl(url: string | undefined): string {
  const ref = projectRef(url)
  return ref ? `https://supabase.com/dashboard/project/${ref}/sql/new` : 'https://supabase.com/dashboard/projects'
}

function storageGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function storageSet(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* private mode: connection lasts for this tab only */ }
}
function storageDel(key: string) {
  try { localStorage.removeItem(key) } catch { /* nothing to remove */ }
}

function loadConn(): Conn | null {
  const raw = storageGet(CONN_KEY)
  if (!raw) return null
  try {
    const c = JSON.parse(raw) as Conn
    return c.url && c.key && classifyKey(c.key) !== 'secret' ? c : null
  } catch {
    return null
  }
}

export const conn = ref<Conn | null>(loadConn())

/** True while the project answers. Paused or unreachable projects flip it, and the shell shows a retry. */
export const net = reactive({ reachable: true })

/** 540 is a paused project; 502/503/504/52x are a project still waking up. */
export function isUnreachableStatus(status: number): boolean {
  return status === 540 || status === 502 || status === 503 || status === 504 || (status >= 520 && status < 530)
}

const trackedFetch: typeof fetch = async (input, init) => {
  try {
    const res = await fetch(input, init)
    net.reachable = !isUnreachableStatus(res.status)
    return res
  } catch (e) {
    if ((e as Error)?.name !== 'AbortError') net.reachable = false
    throw e
  }
}

let client: SupabaseClient | null = null
let clientFor = ''

export function db(): SupabaseClient {
  if (!conn.value) throw new Error('no connection')
  const id = `${conn.value.url}|${conn.value.key}`
  if (!client || clientFor !== id) {
    client = createClient(conn.value.url, conn.value.key, {
      auth: { storageKey: SESSION_KEY, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      global: { fetch: trackedFetch },
    })
    clientFor = id
  }
  return client
}

/** The session key is not per project, so a token must never survive a switch to another project. */
export function clearSessionStorage() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k === SESSION_KEY || k.startsWith(`${SESSION_KEY}-`)) localStorage.removeItem(k)
    }
  } catch { /* nothing stored */ }
}

export function setConn(next: Conn) {
  if (classifyKey(next.key) === 'secret') throw new Error(SECRET_KEY_MESSAGE)
  if (conn.value?.url !== next.url) clearSessionStorage()
  client?.removeAllChannels()
  client = null
  storageSet(CONN_KEY, JSON.stringify(next))
  conn.value = next
  net.reachable = true
}

export function forgetConn() {
  client?.removeAllChannels()
  client = null
  clientFor = ''
  storageDel(CONN_KEY)
  storageDel(SETUP_KEY)
  clearSessionStorage()
  conn.value = null
  net.reachable = true
}

// The setup code stays only between showing the SQL and creating the company.
export function loadSetupCode(url: string): string | null {
  const raw = storageGet(SETUP_KEY)
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as { url: string; code: string }
    return s.url === url ? s.code : null
  } catch {
    return null
  }
}
export function issueSetupCode(url: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  const code = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  storageSet(SETUP_KEY, JSON.stringify({ url, code }))
  return code
}
export function clearSetupCode() {
  storageDel(SETUP_KEY)
}

export function inviteLink(c: Conn): string {
  const base = `${location.origin}${location.pathname}`
  return `${base}#/connect?u=${encodeURIComponent(c.url)}&k=${encodeURIComponent(c.key)}`
}

/** What a customer opens. They have no account and no connection saved, so the link carries the public address and key. */
export function portalLink(c: Conn, token: string): string {
  return `${location.origin}${location.pathname}#/portal/${encodeURIComponent(token)}?u=${encodeURIComponent(c.url)}&k=${encodeURIComponent(c.key)}`
}

/*
 * Docker bundle (docker/ in the repository). Its web server answers ./erp-config.json with the address and public key
 * of the Supabase stack beside it, and the setup code its installer stored, so the app skips the connect screen and the
 * company step needs no SQL. Only a page opened from 127.0.0.1 or localhost asks, and a local build without the file
 * gets a 404, so GitHub Pages and local development behave as before.
 * Handing out the setup code lets whoever can open the page create the company while none exists. That is acceptable
 * only because the bundle listens on 127.0.0.1. A server other people can reach must not serve this file with a code.
 */
export interface BundledConfig { url: string; key: string; setupCode: string | null }

export async function fetchBundledConfig(): Promise<BundledConfig | null> {
  try {
    const res = await fetch('./erp-config.json', { cache: 'no-store', credentials: 'omit' })
    if (!res.ok || !/json/i.test(res.headers.get('content-type') ?? '')) return null
    const raw = (await res.json()) as Record<string, unknown>
    const url = normalizeUrl(typeof raw.url === 'string' ? raw.url : '')
    const key = typeof raw.key === 'string' ? raw.key.trim() : ''
    const kind = classifyKey(key)
    // The same checks as the connect form: a secret key is never stored or sent.
    if (!url.ok || (kind !== 'anon' && kind !== 'publishable')) return null
    const code = typeof raw.setupCode === 'string' && /^[A-Za-z0-9_-]{8,200}$/.test(raw.setupCode) ? raw.setupCode : null
    return { url: url.url, key, setupCode: code }
  } catch {
    return null
  }
}

/** The bundle is opened from this computer only, so a page served from anywhere else (GitHub Pages) never asks. */
export function bundledConfigPossible(): boolean {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)
    && (!conn.value || conn.value.url.startsWith('http://127.0.0.1'))
}

/** Connects from erp-config.json when nothing is saved, and leaves its setup code where the company step reads it. */
export async function adoptBundledConfig(): Promise<boolean> {
  if (!bundledConfigPossible()) return false
  const cfg = await fetchBundledConfig()
  if (!cfg) return false
  if (!conn.value) setConn({ url: cfg.url, key: cfg.key })
  if (conn.value?.url === cfg.url && cfg.setupCode) storageSet(SETUP_KEY, JSON.stringify({ url: cfg.url, code: cfg.setupCode }))
  return true
}

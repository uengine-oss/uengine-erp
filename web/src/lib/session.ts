import { reactive } from 'vue'
import { conn, db, forgetConn, isUnreachableStatus } from './conn'
import { ApiError, probeStatus, rpc, toApiError } from './api'
import { startRealtime, stopRealtime } from './realtime'
import { COMPANY_ID, type CatalogDoc, type ErpRecord, type ErpStatus, type Me } from './types'

export type Phase = 'idle' | 'offline' | 'not-installed' | 'not-initialized' | 'anon' | 'not-member' | 'bad-key' | 'error' | 'ready'

export const session = reactive({
  phase: 'idle' as Phase,
  status: null as ErpStatus | null,
  me: null as Me | null,
  catalog: [] as CatalogDoc[],
  company: null as ErpRecord | null,
  message: '',
})

function clearUser() {
  session.me = null
  session.catalog = []
  session.company = null
}

export async function refreshStatus(): Promise<void> {
  const probe = await probeStatus()
  if (probe.kind === 'ok') session.status = probe.status
}

export async function loadCompany(): Promise<void> {
  const { data, error, status } = await db().from('erp_records').select('*').eq('id', COMPANY_ID).maybeSingle()
  if (error) throw toApiError(error, status)
  session.company = data as ErpRecord | null
}

export async function loadCatalog(): Promise<void> {
  session.catalog = await rpc<CatalogDoc[]>('erp_catalog')
}

let watchedClient: unknown = null
/** An expired refresh token signs the user out; App.vue sends them to the login screen. */
function watchSignOut() {
  const client = db()
  if (watchedClient === client) return
  watchedClient = client
  client.auth.onAuthStateChange((event) => {
    if (event !== 'SIGNED_OUT' || session.phase !== 'ready') return
    // Deferred: calling the client inside this callback can deadlock its auth lock.
    setTimeout(() => {
      stopRealtime()
      clearUser()
      session.phase = 'anon'
    }, 0)
  })
}

/** Works out where this browser stands, from "nothing configured" to "signed in member". */
export async function boot(): Promise<Phase> {
  session.message = ''
  if (!conn.value) return (session.phase = 'idle')
  const probe = await probeStatus()
  if (probe.kind === 'offline') return (session.phase = 'offline')
  if (probe.kind === 'missing') return (session.phase = 'not-installed')
  if (probe.kind === 'bad-key') { session.message = probe.message; return (session.phase = 'bad-key') }
  if (probe.kind === 'error') { session.message = probe.message; return (session.phase = 'error') }
  session.status = probe.status
  // Some parts of a first install have run, not all: the rest still has to be pasted. A company that already exists is
  // mid-upgrade instead and keeps working read-only behind the upgrade banner.
  if (probe.status.installed === false && !probe.status.initialized) return (session.phase = 'not-installed')
  if (!probe.status.initialized) return (session.phase = 'not-initialized')

  const { data } = await db().auth.getSession()
  if (!data.session) { clearUser(); return (session.phase = 'anon') }
  try {
    const me = await rpc<Me | null>('erp_me')
    if (!me) {
      clearUser()
      await db().auth.signOut({ scope: 'local' })
      session.message = '이 회사의 구성원이 아니거나 비활성화된 계정입니다. 관리자에게 문의하세요.'
      return (session.phase = 'not-member')
    }
    session.me = me
    await Promise.all([loadCatalog(), loadCompany()])
    session.phase = 'ready'
    watchSignOut()
    void startRealtime()
    return session.phase
  } catch (e) {
    const err = e as ApiError
    if (err.network) return (session.phase = 'offline')
    if (err.code === 'AUTH') {
      clearUser()
      await db().auth.signOut({ scope: 'local' })
      session.message = err.message
      return (session.phase = 'anon')
    }
    session.message = err.message
    return (session.phase = 'error')
  }
}

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await db().auth.signInWithPassword({ email: email.trim().toLowerCase(), password })
  if (error) {
    const status = error.status ?? 0
    if (error.name === 'AuthRetryableFetchError' || status === 0 || isUnreachableStatus(status)) throw new ApiError('프로젝트에 연결할 수 없습니다. 잠시 뒤 다시 시도하세요.', { network: true })
    if (status === 400) throw new ApiError('이메일 또는 비밀번호가 맞지 않습니다.', { code: 'BAD_LOGIN', status })
    if (status === 429) throw new ApiError('시도가 너무 많습니다. 잠시 뒤 다시 시도하세요.', { code: 'RATE', status })
    throw new ApiError('로그인하지 못했습니다.', { status, raw: error.message })
  }
}

export async function signOut(): Promise<void> {
  stopRealtime()
  try { await db().auth.signOut({ scope: 'local' }) } catch { /* the local token is removed regardless */ }
  clearUser()
  session.phase = 'anon'
}

/** Removes the connection and session token from this browser. The company's data is untouched. */
export async function disconnect(): Promise<void> {
  stopRealtime()
  try { await db().auth.signOut({ scope: 'local' }) } catch { /* cleared below */ }
  forgetConn()
  clearUser()
  session.status = null
  session.phase = 'idle'
}

export function catalogOf(type: string): CatalogDoc | undefined {
  return session.catalog.find((c) => c.type === type)
}

export function hasRole(roles: string[] | undefined): boolean {
  const mine = session.me?.roles ?? []
  if (mine.includes('admin')) return true
  // 'member' means anyone in the company. The handler decides whose document it is, and refuses the rest.
  return (roles ?? []).some((r) => r === 'member' ? !!session.me : mine.includes(r))
}
export const isAdmin = () => (session.me?.roles ?? []).includes('admin')

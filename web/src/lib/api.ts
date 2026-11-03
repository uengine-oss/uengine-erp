import { db, isUnreachableStatus } from './conn'

/** Everything that fails in the app arrives as one of these, with text that is safe to show. */
export class ApiError extends Error {
  code: string | null
  status: number
  network: boolean
  raw: string
  hint: string | null
  constructor(message: string, opts: { code?: string | null; status?: number; network?: boolean; raw?: string; hint?: string | null } = {}) {
    super(message)
    this.code = opts.code ?? null
    this.status = opts.status ?? 0
    this.network = opts.network ?? false
    this.raw = opts.raw ?? message
    this.hint = opts.hint ?? null
  }
}

const NETWORK_RE = /Failed to fetch|NetworkError|Load failed|fetch failed|ERR_/i

interface RawError { message?: string; code?: string; hint?: string | null; details?: string | null }

export function toApiError(err: RawError | Error | null | undefined, status = 0): ApiError {
  const raw = err?.message ?? ''
  const pgCode = (err as RawError)?.code ?? null
  const hint = (err as RawError)?.hint ?? null
  // Kernel errors read "ERP_CODE: 문구"; users see only the sentence.
  const m = raw.match(/^(ERP_[A-Z0-9_]+):\s*([\s\S]*)$/)
  if (m) return new ApiError(m[2], { code: m[1], status, raw })
  if (NETWORK_RE.test(raw) || isUnreachableStatus(status) || (status === 0 && !pgCode)) {
    return new ApiError('프로젝트에 연결할 수 없습니다. 잠시 뒤 다시 시도하세요.', { network: true, raw })
  }
  if (status === 401 && /api key/i.test(raw)) return new ApiError('키가 이 프로젝트의 공개 키가 아닙니다. 키를 다시 확인하세요.', { code: 'BAD_KEY', status, raw })
  if (status === 401 || /JWT/i.test(raw)) return new ApiError('로그인이 만료되었습니다. 다시 로그인하세요.', { code: 'AUTH', status, raw })
  if (pgCode === '42501' || status === 403) return new ApiError('이 작업을 할 권한이 없습니다.', { code: 'FORBIDDEN', status, raw })
  if (pgCode === '57014') return new ApiError('처리 시간이 너무 오래 걸려 중단되었습니다. 범위를 줄여 다시 시도하세요.', { code: 'TIMEOUT', status, raw })
  if (pgCode === '22P02') return new ApiError('입력값의 형식이 올바르지 않습니다.', { code: 'INVALID', status, raw })
  if (pgCode?.startsWith('PGRST')) return new ApiError('서버가 요청을 이해하지 못했습니다. 데이터베이스 업그레이드가 필요할 수 있습니다.', { code: pgCode, status, raw, hint })
  return new ApiError('요청을 처리하지 못했습니다.', { code: pgCode, status, raw, hint })
}

export async function rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error, status } = await db().rpc(fn, args)
  if (error) throw toApiError(error, status)
  return data as T
}

/**
 * A debugging extension some Supabase projects load can fail a statement at random with this. The transaction is
 * rolled back whole, so sending the same request again is safe.
 */
export function isDebuggerGlitch(e: unknown): boolean {
  const err = e as ApiError
  return err?.code === 'XX000' && /pldbgapi2/.test(err.raw ?? '')
}

export function messageOf(e: unknown): string {
  if (e instanceof ApiError) return e.message
  return '요청을 처리하지 못했습니다.'
}

/** erp_status without assuming the project has anything installed yet. */
export type StatusProbe =
  | { kind: 'ok'; status: import('./types').ErpStatus }
  | { kind: 'missing' }
  | { kind: 'offline' }
  | { kind: 'bad-key'; message: string }
  | { kind: 'error'; message: string }

export async function probeStatus(): Promise<StatusProbe> {
  try {
    const status = await rpc<import('./types').ErpStatus>('erp_status')
    return { kind: 'ok', status }
  } catch (e) {
    const err = e as ApiError
    if (err.network) return { kind: 'offline' }
    if (err.status === 404 || err.code === 'PGRST202') return { kind: 'missing' }
    if (err.code === 'BAD_KEY' || err.code === 'AUTH') return { kind: 'bad-key', message: '키가 이 프로젝트의 공개 키가 아닙니다. 키를 다시 확인하세요.' }
    return { kind: 'error', message: err.message }
  }
}

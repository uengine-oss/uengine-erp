import type { Band, Evidence, ModelId, ModelKind, ModelResult, Verdict } from './types.ts'

export function verdictOf(delta: Band, unit: string, what = '효과', lowerIsBetter = false): Verdict {
  if (delta.p10 <= 0 && delta.p90 >= 0) return { code: 'indistinguishable', text: `${what}를 구분할 수 없음` }
  return delta.p50 > 0
    ? { code: 'up', text: `${what}: 증가 (${unit})`, good: !lowerIsBetter }
    : { code: 'down', text: `${what}: 감소 (${unit})`, good: lowerIsBetter }
}

export function done<R>(id: ModelId, kind: ModelKind, input: object, result: R, evidence: Evidence, warnings: string[] = [], verdict: Verdict | null = null): ModelResult<R> {
  return { id, kind, state: 'ready', input, result, range: null, verdict, evidence, warnings }
}

export function short<R>(id: ModelId, kind: ModelKind, input: object, evidence: Evidence, range: ModelResult<R>['range'] = null, warnings: string[] = []): ModelResult<R> {
  return { id, kind, state: 'insufficient', input, result: null, range, verdict: null, evidence, warnings }
}

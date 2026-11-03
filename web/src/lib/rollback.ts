// Any screen can ask for a rollback; one dialog in the shell shows the preview and does the work.
import { shallowRef } from 'vue'
import { rpc } from './api'
import type { RollbackKind, RollbackPlan, RollbackResult, State } from './types'

export interface RollbackRequest {
  kind: RollbackKind
  target: State
  title: string
  /** Names what is being undone, under the title. */
  subject?: string
  resolve: (result: RollbackResult | null) => void
}

export const rollbackRequest = shallowRef<RollbackRequest | null>(null)

export function openRollback(kind: RollbackKind, target: State, title: string, subject?: string): Promise<RollbackResult | null> {
  return new Promise((resolve) => {
    rollbackRequest.value = { kind, target, title, subject, resolve }
  })
}

export function previewRollback(kind: RollbackKind, target: State): Promise<RollbackPlan> {
  return rpc<RollbackPlan>('erp_rollback_preview', { p_kind: kind, p_target: target })
}

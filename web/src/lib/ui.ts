// Small app-wide services: toasts, modal questions, clipboard and file downloads.
import { reactive, shallowRef } from 'vue'
import type { Field, State } from './types'

export const toasts = reactive<{ id: number; text: string; kind: 'ok' | 'error' }[]>([])
let toastId = 0
export function toast(text: string, kind: 'ok' | 'error' = 'ok'): void {
  const id = ++toastId
  toasts.push({ id, text, kind })
  if (toasts.length > 3) toasts.shift()
  setTimeout(() => {
    const i = toasts.findIndex((t) => t.id === id)
    if (i >= 0) toasts.splice(i, 1)
  }, kind === 'error' ? 6000 : 3200)
}

export interface AskOptions {
  title: string
  message?: string
  /** Shown in red, for re-asking after the server refused the previous answer. */
  error?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  fields?: Field[]
  values?: State
  /** Asks for a free-text reason, which is written to the ledger with the event. */
  reason?: boolean
  wide?: boolean
}
export interface AskResult { values: State; reason: string }
export const dialog = shallowRef<(AskOptions & { resolve: (r: AskResult | null) => void }) | null>(null)

export function ask(options: AskOptions): Promise<AskResult | null> {
  return new Promise((resolve) => {
    dialog.value = { ...options, resolve }
  })
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Clipboard API needs permission or focus; the old path still works for a user-initiated click.
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch { ok = false }
    ta.remove()
    return ok
  }
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

/** Spreadsheet apps run cells that start with these characters as formulas, so exported text is defused. */
function csvCell(v: unknown, numeric: boolean): string {
  let s = v === null || v === undefined ? '' : String(v)
  if (!numeric && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function csvBlob(headers: string[], rows: { value: unknown; numeric: boolean }[][]): Blob {
  const lines = [headers.map((h) => csvCell(h, false)).join(',')]
  for (const row of rows) lines.push(row.map((c) => csvCell(c.value, c.numeric)).join(','))
  // The BOM makes spreadsheet apps read Korean text as UTF-8.
  return new Blob(['﻿', lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
}

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { dialog } from '../lib/ui'
import type { State } from '../lib/types'
import { emptyValue } from '../lib/fields'
import FieldInput from './FieldInput.vue'

const values = ref<State>({})
const reason = ref('')
const root = ref<HTMLElement | null>(null)
let returnFocus: HTMLElement | null = null

watch(dialog, async (d) => {
  if (!d) return
  returnFocus = document.activeElement as HTMLElement | null
  const initial: State = {}
  for (const f of d.fields ?? []) initial[f.name] = d.values?.[f.name] ?? emptyValue(f)
  values.value = initial
  reason.value = ''
  await nextTick()
  const first = root.value?.querySelector<HTMLElement>('.dlg-body input, .dlg-body select, .dlg-body textarea')
  ;(first ?? root.value?.querySelector<HTMLElement>('.dlg-foot .btn:last-child'))?.focus()
})

function close(confirmed: boolean) {
  const d = dialog.value
  if (!d) return
  dialog.value = null
  d.resolve(confirmed ? { values: values.value, reason: reason.value.trim() } : null)
  returnFocus?.focus?.()
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); close(false); return }
  if (e.key !== 'Tab') return
  // Keeps keyboard focus inside the dialog.
  const items = root.value?.querySelectorAll<HTMLElement>('input, select, textarea, button, a[href]')
  if (!items?.length) return
  const first = items[0]
  const last = items[items.length - 1]
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
}
</script>

<template>
  <div v-if="dialog" class="dlg-overlay" @mousedown.self="close(false)">
    <div ref="root" class="dlg" :class="{ 'dlg-wide': dialog.wide }" role="dialog" aria-modal="true" aria-labelledby="dlg-title" @keydown="onKey">
      <form class="stack" style="gap: 0; min-height: 0" @submit.prevent="close(true)">
        <div class="dlg-head"><h2 id="dlg-title">{{ dialog.title }}</h2></div>
        <div class="dlg-body">
          <p v-if="dialog.message">{{ dialog.message }}</p>
          <p v-if="dialog.error" class="err-text" role="alert" style="margin-top: 6px">{{ dialog.error }}</p>
          <div v-for="f in dialog.fields ?? []" :key="f.name" class="field-stack">
            <label :for="`dlg-${f.name}`">{{ f.label }}<span v-if="f.required" class="req">*</span></label>
            <FieldInput :id="`dlg-${f.name}`" v-model="values[f.name]" :field="f" />
            <span v-if="f.help" class="hint">{{ f.help }}</span>
          </div>
          <div v-if="dialog.reason" class="field-stack">
            <label for="dlg-reason">사유 <span class="muted">(선택, 이력에 남습니다)</span></label>
            <input id="dlg-reason" v-model="reason" class="input" autocomplete="off" />
          </div>
        </div>
        <div class="dlg-foot">
          <button type="button" class="btn" @click="close(false)">{{ dialog.cancelLabel ?? '취소' }}</button>
          <button type="submit" class="btn" :class="dialog.danger ? 'btn-danger-solid' : 'btn-primary'" data-testid="dlg-confirm">{{ dialog.confirmLabel ?? '확인' }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

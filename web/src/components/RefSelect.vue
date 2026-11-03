<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { messageOf } from '../lib/api'
import { sendCommand } from '../lib/commands'
import { db } from '../lib/conn'
import { catalogOf } from '../lib/session'
import { ensureNames, refLabel, refNames } from '../lib/refs'
import { searchFilter, variantFilter } from '../lib/query'
import { canCommand, displayValue, listFields } from '../lib/fields'
import { toast } from '../lib/ui'
import type { CommandResult } from '../lib/types'
import Icon from './Icon.vue'

const props = defineProps<{ modelValue: string | null | undefined; refType: string; disabled?: boolean; id?: string; invalid?: boolean; placeholder?: string; exclude?: string[]; ariaLabel?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string | null]; picked: [] }>()

interface Item { id: string; name: string; detail: string }

// Types whose records a name alone can make, from the place they are being picked. A variant comes with its product.
const MAKES: Record<string, { type: string; pick?: (r: CommandResult) => string }> = {
  tag: { type: 'tag' },
  product: { type: 'product' },
  variant: { type: 'product', pick: (r) => r.state.variants?.[0]?.id ?? r.id },
}

const input = ref<HTMLInputElement | null>(null)
const text = ref('')
const open = ref(false)
const focused = ref(false)
const items = ref<Item[]>([])
const active = ref(0)
const loading = ref(false)
const failed = ref(false)
const pending = ref(false)
const menuStyle = ref<Record<string, string>>({})
const listId = `combo-${Math.random().toString(36).slice(2, 9)}`
let timer: ReturnType<typeof setTimeout> | undefined
let seq = 0

const doc = computed(() => catalogOf(props.refType))
const selectedName = computed(() => (props.modelValue ? refLabel(props.modelValue) : ''))
const shown = computed(() => (focused.value ? text.value : selectedName.value))
const making = ref(false)
const canMake = computed(() => {
  const made = MAKES[props.refType]
  const typed = text.value.trim()
  if (!made || !typed || loading.value || pending.value) return false
  const doc = catalogOf(made.type)
  return !!doc && canCommand(doc, 'create') && !items.value.some((it) => it.name === typed)
})

async function make() {
  const made = MAKES[props.refType]
  const name = text.value.trim()
  if (!made || !name || making.value) return
  making.value = true
  try {
    const res = await sendCommand({ type: made.type, command: 'create', payload: { name } })
    choose({ id: made.pick ? made.pick(res) : res.id, name, detail: '' })
    toast(`"${name}" 을(를) 새로 만들었습니다.`)
  } catch (e) {
    toast(messageOf(e), 'error')
  } finally {
    making.value = false
  }
}

watch(() => props.modelValue, (v) => { if (v && !refNames.has(v)) void ensureNames([v]) }, { immediate: true })

function place() {
  const r = input.value?.getBoundingClientRect()
  if (!r) return
  const below = window.innerHeight - r.bottom
  const style: Record<string, string> = { left: `${r.left}px`, width: `${Math.max(r.width, 240)}px` }
  if (below < 180 && r.top > below) style.bottom = `${window.innerHeight - r.top + 2}px`
  else style.top = `${r.bottom + 2}px`
  menuStyle.value = style
}

async function search() {
  const my = ++seq
  loading.value = true
  failed.value = false
  try {
    const typed = text.value.trim() && text.value !== selectedName.value ? text.value : ''
    let rows: { id: string; name: string | null; state?: Record<string, unknown>; sku?: string | null }[]
    if (props.refType === 'variant') {
      // Product variants live in their own view rather than as records.
      let q = db().from('erp_variants').select('id,name,sku').eq('active', true).order('name').limit(8)
      if (typed) q = q.or(variantFilter(typed))
      const { data, error } = await q
      if (error) throw error
      rows = data ?? []
    } else {
      let q = db().from('erp_records').select('id,name,state').eq('type', props.refType).eq('active', true).order('name').limit(8)
      if (typed) q = q.or(searchFilter(doc.value, typed))
      const { data, error } = await q
      if (error) throw error
      rows = data ?? []
    }
    if (my !== seq) return
    const secondary = doc.value ? listFields(doc.value).find((f) => f.name !== 'name' && f.type === 'text') : undefined
    items.value = rows
      .filter((r) => !props.exclude?.includes(r.id))
      .map((r) => ({
        id: r.id,
        name: r.name ?? '(이름 없음)',
        detail: r.sku ?? (secondary ? displayValue(secondary, r.state?.[secondary.name]) : ''),
      }))
    for (const it of items.value) refNames.set(it.id, it.name)
    active.value = 0
  } catch {
    if (my === seq) { items.value = []; failed.value = true }
  } finally {
    if (my === seq) { loading.value = false; pending.value = false }
  }
}

function openMenu() {
  if (props.disabled) return
  place()
  open.value = true
  void search()
}
function closeMenu() {
  open.value = false
  seq++
}
function choose(item: Item) {
  refNames.set(item.id, item.name)
  emit('update:modelValue', item.id)
  text.value = item.name
  closeMenu()
  emit('picked')
}
function onFocus() {
  focused.value = true
  text.value = selectedName.value
  void Promise.resolve().then(() => input.value?.select())
}
function onBlur() {
  focused.value = false
  if (text.value.trim() === '' && props.modelValue) emit('update:modelValue', null)
  closeMenu()
}
function onInput(e: Event) {
  text.value = (e.target as HTMLInputElement).value
  place()
  open.value = true
  pending.value = true
  seq++ // A search already on its way was for the previous text.
  // Narrow what is on screen right away, so Enter never picks an entry the typed text has ruled out.
  const typed = text.value.trim().toLowerCase()
  items.value = items.value.filter((it) => `${it.name} ${it.detail}`.toLowerCase().includes(typed))
  active.value = 0
  clearTimeout(timer)
  timer = setTimeout(search, 160)
}
/** Fast typists press Enter or Tab before the search returns: wait for it, then take the best match. */
async function settle(): Promise<Item | undefined> {
  if (pending.value) {
    clearTimeout(timer)
    await search()
  }
  return items.value[active.value]
}
function focusNext() {
  const all = [...document.querySelectorAll<HTMLElement>('input, select, textarea, button, a[href]')]
    .filter((el) => el.tabIndex >= 0 && !(el as HTMLInputElement).disabled && el.offsetParent !== null)
  const here = input.value ? all.indexOf(input.value) : -1
  all[here + 1]?.focus()
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    e.stopPropagation()
    if (!open.value) openMenu()
    else if (items.value.length) active.value = (active.value + 1) % items.value.length
  } else if (e.key === 'ArrowUp') {
    if (!open.value) return
    e.preventDefault()
    e.stopPropagation()
    if (items.value.length) active.value = (active.value - 1 + items.value.length) % items.value.length
  } else if (e.key === 'Enter') {
    if (!open.value) return
    e.preventDefault()
    e.stopPropagation()
    void settle().then((it) => {
      if (it) choose(it)
      else if (canMake.value) void make()
    })
  } else if (e.key === 'Tab') {
    // Tab accepts the highlighted match, the same as Enter, so entry flows from field to field.
    if (open.value && text.value.trim() && text.value !== selectedName.value) {
      if (pending.value && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        void settle().then((it) => { if (it) choose(it); focusNext() })
        return
      }
      const it = items.value[active.value]
      if (it) choose(it)
    }
    closeMenu()
  } else if (e.key === 'Escape') {
    if (open.value) {
      e.preventDefault()
      e.stopPropagation()
      closeMenu()
      text.value = selectedName.value
    }
  }
}
function clear() {
  emit('update:modelValue', null)
  text.value = ''
  input.value?.focus()
}

const onViewportChange = () => { if (open.value) place() }
window.addEventListener('scroll', onViewportChange, true)
window.addEventListener('resize', onViewportChange)
onBeforeUnmount(() => {
  clearTimeout(timer)
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('resize', onViewportChange)
})
</script>

<template>
  <span class="combo">
    <input ref="input" :id="id" class="input" type="text" role="combobox" autocomplete="off" spellcheck="false" :aria-label="ariaLabel"
           :class="{ 'is-invalid': invalid }" :aria-expanded="open" :aria-controls="listId"
           :disabled="disabled" :placeholder="placeholder ?? '검색하여 선택'" :value="shown"
           @focus="onFocus" @blur="onBlur" @input="onInput" @keydown="onKey" @click="open || openMenu()" />
    <button v-if="modelValue && !disabled" type="button" class="combo-clear" tabindex="-1" aria-label="선택 지우기" @mousedown.prevent="clear"><Icon name="x" :size="12" /></button>
    <Teleport to="body">
      <div v-if="open" :id="listId" class="combo-menu" role="listbox" :style="menuStyle" @mousedown.prevent>
        <div v-for="(it, i) in items" :key="it.id" class="combo-item" :class="{ on: i === active }" role="option"
             :aria-selected="i === active" @mouseenter="active = i" @click="choose(it)">
          <span class="ellipsis">{{ it.name }}</span><small v-if="it.detail">{{ it.detail }}</small>
        </div>
        <div v-if="!items.length" class="combo-empty">{{ loading ? '찾는 중…' : failed ? '목록을 불러오지 못했습니다' : '일치하는 항목이 없습니다' }}</div>
        <div v-if="canMake" class="combo-item combo-make" role="option" aria-selected="false" data-testid="combo-make" @click="make"><span class="ellipsis">"{{ text.trim() }}" 새로 만들기</span></div>
      </div>
    </Teleport>
  </span>
</template>

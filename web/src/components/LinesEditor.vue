<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { Field, State } from '../lib/types'
import { emptyValue, isDerived, isNumeric, newId } from '../lib/fields'
import { ensureStates, refStates } from '../lib/refs'
import FieldInput from './FieldInput.vue'
import FieldValue from './FieldValue.vue'
import Icon from './Icon.vue'

const props = defineProps<{
  field: Field
  modelValue: State[] | null | undefined
  readonly?: boolean
  sections?: boolean
  /** Rows are created by the server (product variants): they can be edited but not added or removed. */
  fixedRows?: boolean
  hideColumns?: string[]
  /** The document the lines belong to, for columns that suggest a value from it (a distribution from the partner). */
  context?: State | null
}>()
const emit = defineEmits<{ 'update:modelValue': [value: State[]] }>()

const HIDDEN = new Set(['id', 'sequence', 'display_type'])
const columns = computed(() => (props.field.columns ?? []).filter((c) => !HIDDEN.has(c.name) && !c.hidden && !props.hideColumns?.includes(c.name)))
const rows = computed(() => props.modelValue ?? [])
const allowSections = computed(() =>
  !!props.sections || !!props.field.sections || (props.field.columns ?? []).some((c) => c.name === 'display_type'))
const textColumn = computed(() => columns.value.find((c) => c.name === 'name') ?? columns.value.find((c) => c.type === 'text'))
const editable = computed(() => columns.value.filter((c) => !isDerived(c)))
const table = ref<HTMLElement | null>(null)
const canAddRemove = computed(() => !props.readonly && !props.fixedRows)

// Some columns choose among values held by the record another column points at.
const dependentColumns = computed(() => columns.value.filter((c) => c.options_from))
watch([rows, dependentColumns], () => {
  const ids = dependentColumns.value.flatMap((c) => rows.value.map((r) => r[c.options_from!.field]))
  void ensureStates(ids)
}, { immediate: true })
function columnFor(row: State, c: Field): Field {
  if (!c.options_from) return c
  const list = refStates.get(row[c.options_from.field])?.[c.options_from.path] ?? []
  return { ...c, options: list.map((o: State) => ({ value: o.id, label: o.name })) }
}

function emitRows(next: State[]) { emit('update:modelValue', next) }
function patch(id: string, name: string, value: unknown) {
  emitRows(rows.value.map((r) => (r.id === id ? { ...r, [name]: value } : r)))
}
function remove(id: string) {
  emitRows(rows.value.filter((r) => r.id !== id))
}

function focusCell(rowId: string, column?: string) {
  void nextTick(() => {
    const row = table.value?.querySelector(`[data-row="${rowId}"]`)
    const scope = column ? row?.querySelector(`[data-col="${column}"]`) : row
    scope?.querySelector<HTMLElement>('input, select, textarea')?.focus()
  })
}

function add(displayType: 'section' | 'note' | null = null) {
  const row: State = { id: newId() }
  if (displayType) {
    row.display_type = displayType
    row[textColumn.value?.name ?? 'name'] = ''
  } else {
    for (const c of props.field.columns ?? []) if (c.name !== 'id' && c.default !== undefined) row[c.name] = emptyValue(c)
  }
  emitRows([...rows.value, row])
  focusCell(row.id)
}

/* Moving rows. The array's order is what the server stores, so only the order changes here. */
const canMove = computed(() => canAddRemove.value && allowSections.value)
const dragging = ref<string | null>(null)
const dropOn = ref<string | null>(null)
function move(id: string, to: number) {
  const list = [...rows.value]
  const from = list.findIndex((r) => r.id === id)
  if (from < 0 || to < 0 || to >= list.length || from === to) return
  const [row] = list.splice(from, 1)
  list.splice(to, 0, row)
  emitRows(list)
}
function onDragStart(e: DragEvent, id: string) {
  dragging.value = id
  e.dataTransfer?.setData('text/plain', id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}
function onDrop(id: string) {
  if (dragging.value) move(dragging.value, rows.value.findIndex((r) => r.id === id))
  dragging.value = null
  dropOn.value = null
}
function onHandleKey(e: KeyboardEvent, row: State) {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
  e.preventDefault()
  e.stopPropagation()
  move(row.id, rows.value.indexOf(row) + (e.key === 'ArrowUp' ? -1 : 1))
  void nextTick(() => table.value?.querySelector<HTMLElement>(`[data-row="${row.id}"] .line-handle`)?.focus())
}

function isBlank(row: State): boolean {
  return editable.value.every((c) => row[c.name] === undefined || row[c.name] === null || row[c.name] === '' || row[c.name] === false)
}

function onCellKey(e: KeyboardEvent, row: State, col: Field) {
  const i = rows.value.indexOf(row)
  if (e.key === 'Tab' && !e.shiftKey) {
    // Tabbing off the last cell of the last row starts a new row, unless that row is still empty.
    const lastCol = editable.value[editable.value.length - 1]
    if (canAddRemove.value && i === rows.value.length - 1 && col.name === lastCol?.name && !isBlank(row)) {
      e.preventDefault()
      add()
    }
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
    const target = (e.target as HTMLElement).tagName
    if (target === 'SELECT') return
    if (e.key !== 'Enter' && (e.target as HTMLInputElement).type === 'date') return
    e.preventDefault()
    const step = e.key === 'ArrowUp' ? -1 : 1
    let j = i + step
    while (rows.value[j]?.display_type) j += step
    if (rows.value[j]) focusCell(rows.value[j].id, col.name)
    else if (e.key === 'Enter' && step > 0 && canAddRemove.value && !isBlank(row)) add()
  }
}
</script>

<template>
  <div ref="table" class="lines">
    <div class="lines-scroll">
      <table class="tbl lines-tbl">
        <thead>
          <tr>
            <th v-if="canMove" class="no-print" style="width: 24px" aria-label="줄 옮기기"></th>
            <th v-for="c in columns" :key="c.name" :class="{ num: isNumeric(c) }">{{ c.label }}<span v-if="c.required && !readonly" class="req">*</span></th>
            <th v-if="canAddRemove" class="no-print" style="width: 30px" aria-label="줄 삭제"></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="row in rows" :key="row.id">
            <tr v-if="row.display_type" :data-row="row.id" class="line-special" :class="[`line-${row.display_type}`, { 'line-drop': dropOn === row.id }]"
                @dragover.prevent="dropOn = row.id" @dragleave="dropOn = null" @drop.prevent="onDrop(row.id)">
              <td v-if="canMove" class="no-print line-move"><button type="button" class="line-handle" draggable="true" aria-label="줄 옮기기, 위아래 화살표" data-testid="line-handle" @dragstart="onDragStart($event, row.id)" @dragend="dragging = null" @keydown="onHandleKey($event, row)"><Icon name="more" :size="12" /></button></td>
              <td :colspan="columns.length" :class="{ 'is-static': readonly }">
                <span v-if="readonly">{{ row[textColumn?.name ?? 'name'] }}</span>
                <input v-else class="input" autocomplete="off" :value="row[textColumn?.name ?? 'name'] ?? ''"
                       :placeholder="row.display_type === 'section' ? '구역 제목' : '메모'" :aria-label="row.display_type === 'section' ? '구역 제목' : '메모'"
                       @input="patch(row.id, textColumn?.name ?? 'name', ($event.target as HTMLInputElement).value)" />
              </td>
              <td v-if="canAddRemove" class="no-print">
                <button type="button" class="btn btn-ghost btn-sm btn-icon" tabindex="-1" aria-label="줄 삭제" @click="remove(row.id)"><Icon name="x" :size="12" /></button>
              </td>
            </tr>
            <tr v-else :data-row="row.id" :class="{ 'line-portal': row.from_portal, 'line-drop': dropOn === row.id }"
                @dragover.prevent="dropOn = row.id" @dragleave="dropOn = null" @drop.prevent="onDrop(row.id)">
              <td v-if="canMove" class="no-print line-move"><button type="button" class="line-handle" draggable="true" aria-label="줄 옮기기, 위아래 화살표" data-testid="line-handle" @dragstart="onDragStart($event, row.id)" @dragend="dragging = null" @keydown="onHandleKey($event, row)"><Icon name="more" :size="12" /></button></td>
              <td v-for="c in columns" :key="c.name" :data-col="c.name" :class="[{ num: isNumeric(c), 'is-static': readonly || isDerived(c) }, `col-${c.type}`]" @keydown="onCellKey($event, row, c)">
                <FieldValue v-if="readonly || isDerived(c)" :field="columnFor(row, c)" :value="row[c.name]" />
                <span v-else-if="c.options_from && !columnFor(row, c).options?.length" class="muted small">{{ row[c.options_from.field] ? '고를 값 없음' : '앞 칸을 먼저 고르세요' }}</span>
                <FieldInput v-else :field="columnFor(row, c)" compact :model-value="row[c.name]" :aria-label="c.label"
                            :context="c.type === 'distribution' ? { product_id: row.product_id, account_id: row.account_id, partner_id: context?.partner_id } : null" @update:model-value="patch(row.id, c.name, $event)" />
              </td>
              <td v-if="canAddRemove" class="no-print">
                <button type="button" class="btn btn-ghost btn-sm btn-icon" tabindex="-1" aria-label="줄 삭제" @click="remove(row.id)"><Icon name="x" :size="12" /></button>
              </td>
            </tr>
          </template>
          <tr v-if="!rows.length">
            <td :colspan="columns.length + (canAddRemove ? 1 : 0) + (canMove ? 1 : 0)" class="muted lines-empty">{{ canAddRemove ? '아직 줄이 없습니다. 아래에서 줄을 추가하세요.' : fixedRows && !readonly ? '저장하면 자동으로 만들어집니다.' : '줄이 없습니다.' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="canAddRemove" class="row lines-actions no-print">
      <button type="button" class="btn btn-sm" data-testid="line-add" @click="add()"><Icon name="plus" :size="12" />줄 추가</button>
      <template v-if="allowSections">
        <button type="button" class="btn btn-sm btn-ghost" data-testid="line-add-section" @click="add('section')">구역 추가</button>
        <button type="button" class="btn btn-sm btn-ghost" data-testid="line-add-note" @click="add('note')">메모 추가</button>
      </template>
      <span class="muted small" style="margin-left: auto">Tab 다음 칸 · Enter 아래 줄 · 마지막 칸에서 Tab 새 줄</span>
    </div>
  </div>
</template>

<style scoped>
.lines-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius); }
.lines-tbl th { position: static; padding: 0 10px 0 12px; }
.lines-tbl td { padding: 2px 3px; max-width: none; border-bottom-color: var(--ink-100); overflow: visible; }
.lines-tbl td.is-static { padding: 2px 10px 2px 12px; }
.lines-tbl td.num .input { padding-right: 6px; }
.lines-tbl tr:last-child td { border-bottom: 0; }
.lines-tbl .input, .lines-tbl .select { border-color: transparent; background: transparent; }
.lines-tbl tr:hover .input, .lines-tbl tr:hover .select { border-color: var(--line); background: var(--surface); }
.lines-tbl .input:focus, .lines-tbl .select:focus { border-color: var(--navy-600); background: var(--surface); }
.lines-tbl td.col-money, .lines-tbl td.col-number, .lines-tbl td.col-integer { min-width: 84px; width: 96px; }
.lines-tbl td.col-ref { min-width: 170px; }
.lines-tbl td.col-text { min-width: 150px; }
.lines-tbl td.col-date { min-width: 132px; }
.lines-tbl td.col-enum { min-width: 112px; }
.lines-tbl td.col-tags { min-width: 150px; }
.lines-tbl td.col-json { min-width: 160px; }
.lines-tbl td.col-distribution { min-width: 170px; max-width: 240px; }
.lines-tbl td.col-boolean { width: 44px; text-align: center; }
.lines-empty { padding: 12px !important; text-align: center; }
.line-section td { background: var(--ink-50); }
.line-section .input { font-weight: 650; }
.line-section td.is-static { font-weight: 650; }
.line-note .input, .line-note span { font-style: italic; color: var(--text-2); }
.lines-actions { padding-top: 6px; }
.line-move { padding: 0 !important; text-align: center; }
.line-handle { width: 20px; height: 22px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: var(--radius-sm); background: none; color: var(--ink-400); cursor: grab; }
.line-handle:hover { color: var(--text); background: var(--ink-100); }
.line-drop td { box-shadow: inset 0 2px 0 var(--navy-600); }
.line-portal td { background: var(--green-bg); }
</style>

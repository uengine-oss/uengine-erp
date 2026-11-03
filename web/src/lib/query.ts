import { isNumeric } from './fields'
import type { CatalogDoc, Field } from './types'

/** Quotes a value for PostgREST's or=() syntax, where commas and parentheses are separators. */
function quoted(pattern: string): string {
  return `"${pattern.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** The or=() filter for a search box: the catalog's search fields, or the record name if it declares none. */
export function searchFilter(doc: CatalogDoc | undefined, text: string): string {
  const pattern = quoted(`*${text.trim()}*`)
  const fields = doc?.fields.filter((f) => f.search) ?? []
  const parts = fields.map((f) => `state->>${f.name}.ilike.${pattern}`)
  parts.push(`name.ilike.${pattern}`)
  return parts.join(',')
}

export function variantFilter(text: string): string {
  const pattern = quoted(`*${text.trim()}*`)
  return ['name', 'sku', 'barcode'].map((c) => `${c}.ilike.${pattern}`).join(',')
}

/** Numbers sort as jsonb so 9 comes before 10; everything else sorts as text. */
export function sortColumn(f: Field): string | null {
  if (['ref', 'refs', 'tags', 'lines', 'json', 'password'].includes(f.type)) return null
  return isNumeric(f) ? `state->${f.name}` : `state->>${f.name}`
}

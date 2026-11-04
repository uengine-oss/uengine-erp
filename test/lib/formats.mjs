// Small readers for the process-mining files, so the tests check them without new dependencies.
//   validateSchema: the JSON Schema (draft-07) keywords the OCEL 2.0 schema uses: type, properties, required, items, format date-time.
//     test/fixtures/ocel20-schema-json.json is the schema the OCEL 2.0 standard publishes (www.ocel-standard.org), copied as is.
//   checkXml: well-formed XML 1.0 for what toXes writes: one root, balanced tags, quoted attributes, known entities only.
//   parseCsv: RFC 4180 with quoted fields.

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

export function validateSchema(schema, value, path = '$', errors = []) {
  const t = schema.type
  const kind = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value
  if (t && !(t === kind || (t === 'number' && kind === 'integer'))) { errors.push(`${path}: ${kind} 가 아니라 ${t} 여야 합니다`); return errors }
  if (schema.format === 'date-time' && !RFC3339.test(value)) errors.push(`${path}: date-time 이 아닙니다 (${value})`)
  if (t === 'object') {
    for (const k of schema.required ?? []) if (!(k in value)) errors.push(`${path}.${k}: 없습니다`)
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in value) validateSchema(s, value[k], `${path}.${k}`, errors)
  }
  if (t === 'array' && schema.items) value.forEach((v, i) => validateSchema(schema.items, v, `${path}[${i}]`, errors))
  return errors
}

export function checkXml(text) {
  let s = text
  if (s.startsWith('<?xml')) s = s.slice(s.indexOf('?>') + 2)
  const stack = []
  let roots = 0
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|<!--[\s\S]*?-->|([^<]+)|(<)/g
  let m
  while ((m = re.exec(s))) {
    if (m[6]) throw new Error(`잘못된 태그: ${s.slice(m.index, m.index + 40)}`)
    if (m[5] !== undefined) {
      if (stack.length === 0 && m[5].trim()) throw new Error('루트 밖의 글자')
      for (const e of m[5].matchAll(/&([^;\s]*);?/g)) if (!/^(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+)$/.test(e[1]) || !e[0].endsWith(';')) throw new Error(`엔티티: ${e[0]}`)
      continue
    }
    if (m[0].startsWith('<!--')) continue
    for (const a of (m[3] ?? '').matchAll(/="([^"]*)"/g)) {
      for (const e of a[1].matchAll(/&([^;\s]*);?/g)) if (!/^(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+)$/.test(e[1]) || !e[0].endsWith(';')) throw new Error(`속성의 엔티티: ${e[0]}`)
    }
    if (m[1]) {
      if (stack.pop() !== m[2]) throw new Error(`닫는 태그가 맞지 않습니다: ${m[2]}`)
    } else if (!m[4]) {
      if (stack.length === 0) roots++
      stack.push(m[2])
    } else if (stack.length === 0) roots++
  }
  if (stack.length) throw new Error(`닫히지 않은 태그: ${stack.join(' > ')}`)
  if (roots !== 1) throw new Error(`루트가 ${roots}개입니다`)
  return true
}

export function parseCsv(text) {
  const rows = []
  let row = [], cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ } else if (ch === '"') q = false
      else cell += ch
    } else if (ch === '"') q = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else if (ch !== '\r') cell += ch
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}

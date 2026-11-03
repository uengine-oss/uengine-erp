// Reads the field lists in docs/domain.md so the catalog is checked against the contract itself.
import fs from 'node:fs'
import assert from 'node:assert/strict'

function splitTop(s) {
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if ('([{'.includes(ch)) depth++
    if (')]}'.includes(ch)) depth--
    if (ch === ',' && depth === 0) { parts.push(cur); cur = '' } else cur += ch
  }
  if (cur.trim()) parts.push(cur)
  return parts.map((p) => p.trim())
}

// "a, b(x/y), c[{id, d}], e:{k:v}" -> [{name, options, columns}]
export function parseFields(spec) {
  return splitTop(spec).map((raw) => {
    const m = raw.match(/^(\w+)(\(.*\))?(\[\{.*\}\])?(:.*)?$/)
    assert.ok(m, `cannot read field: ${raw}`)
    const options = m[2] ? m[2].slice(1, -1).split(/[,/]\s*/).map((o) => o.trim()).filter((o) => o !== 'unique') : null
    return {
      name: m[1],
      options: options?.length ? options : null,
      columns: m[3] ? parseFields(m[3].slice(2, -2)) : null,
    }
  })
}

// The master table rows of one numbered section, as [{type, fields}].
export function domainTypes(file, heading) {
  const text = fs.readFileSync(file, 'utf8')
  const section = text.slice(text.indexOf(heading)).split(/\n## /)[0]
  return [...section.matchAll(/^\| `(\w+)` \| `([^`]+)`/gm)].map((m) => ({ type: m[1], fields: parseFields(m[2]) }))
}

export function assertCatalogMatches(doc, type, fields) {
  const names = (list) => list.map((f) => f.name).sort()
  assert.deepEqual(names(doc.fields), names(fields), `${type} fields`)
  assert.match(doc.label, /[가-힣]/, `${type} label`)
  assert.ok(doc.label_en, `${type} English label`)
  assert.ok(doc.fields.some((f) => f.list), `${type} has list columns`)
  assert.ok(doc.fields.some((f) => f.search), `${type} is searchable`)
  for (const spec of fields) {
    const f = doc.fields.find((x) => x.name === spec.name)
    assert.ok(f.label, `${type}.${f.name} label`)
    if (spec.options) {
      assert.equal(f.type, 'enum', `${type}.${f.name} is an enum`)
      assert.deepEqual(f.options.map((o) => o.value).sort(), [...spec.options].sort(), `${type}.${f.name} options`)
      assert.ok(f.options.every((o) => /[가-힣]/.test(o.label)), `${type}.${f.name} option labels`)
    }
    if (spec.columns) {
      assert.equal(f.type, 'lines', `${type}.${f.name} is lines`)
      const cols = spec.columns.filter((c) => c.name !== 'id')
      assert.deepEqual(names(f.columns), names(cols), `${type}.${f.name} columns`)
      for (const c of cols) {
        const col = f.columns.find((x) => x.name === c.name)
        assert.ok(col.label && col.type, `${type}.${f.name}.${c.name} label and type`)
        if (c.options) assert.deepEqual(col.options.map((o) => o.value).sort(), [...c.options].sort(), `${type}.${f.name}.${c.name} options`)
      }
    }
  }
  for (const cmd of ['create', 'update', 'archive', 'unarchive', 'delete']) assert.ok(doc.commands[cmd]?.roles?.length, `${type} ${cmd} roles`)
}

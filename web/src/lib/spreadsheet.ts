// Reads a spreadsheet file in the browser. The file never leaves this device except as the rows the person sends.
export interface Sheet { headers: string[]; rows: Record<string, string>[] }

/** RFC 4180 with the habits of real exports: a byte order mark, CRLF, semicolons or tabs instead of commas. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '')
  const firstLine = src.slice(0, src.search(/\r?\n|$/))
  const count = (c: string) => firstLine.split(c).length - 1
  const delimiter = [',', ';', '\t'].reduce((best, c) => (count(c) > count(best) ? c : best), ',')
  const out: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"' && cell === '') quoted = true
    else if (c === delimiter) { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.some((v) => v !== '')) out.push(row)
      row = []
    } else cell += c
  }
  row.push(cell)
  if (row.some((v) => v !== '')) out.push(row)
  return out
}

/** The first row names the columns. A blank or repeated name gets its position, so no cell is lost. */
export function toSheet(table: string[][]): Sheet {
  const seen = new Set<string>()
  const headers = (table[0] ?? []).map((h, i) => {
    const name = h.trim() || `열 ${i + 1}`
    const unique = seen.has(name) ? `${name} (${i + 1})` : name
    seen.add(unique)
    return unique
  })
  const rows = table.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])))
  return { headers, rows }
}

/* XLSX is a ZIP of XML. The browser can inflate and parse both, so no library is needed for the first sheet. */
async function unzip(buf: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const v = new DataView(buf)
  let end = buf.byteLength - 22
  while (end >= 0 && v.getUint32(end, true) !== 0x06054b50) end--
  if (end < 0) throw new Error('not a zip')
  const out = new Map<string, Uint8Array>()
  let at = v.getUint32(end + 16, true)
  for (let n = v.getUint16(end + 10, true); n > 0; n--) {
    const method = v.getUint16(at + 10, true)
    const size = v.getUint32(at + 20, true)
    const nameLen = v.getUint16(at + 28, true)
    const name = new TextDecoder().decode(new Uint8Array(buf, at + 46, nameLen))
    const local = v.getUint32(at + 42, true)
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true)
    const raw = new Uint8Array(buf, start, size)
    if (method === 0) out.set(name, raw)
    else if (method === 8) {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
      out.set(name, new Uint8Array(await new Response(stream).arrayBuffer()))
    }
    at += 46 + nameLen + v.getUint16(at + 30, true) + v.getUint16(at + 32, true)
  }
  return out
}

const xml = (bytes: Uint8Array | undefined) => new DOMParser().parseFromString(new TextDecoder().decode(bytes ?? new Uint8Array()), 'application/xml')
const columnOf = (ref: string) => [...ref.replace(/\d+/g, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1
const DAY_MS = 86400000

function dateStyles(styles: Document): Set<number> {
  const custom = new Set<string>()
  for (const f of styles.getElementsByTagName('numFmt')) {
    if (/[ymd]/i.test((f.getAttribute('formatCode') ?? '').replace(/"[^"]*"|\[[^\]]*\]/g, ''))) custom.add(f.getAttribute('numFmtId') ?? '')
  }
  const out = new Set<number>()
  const xfs = styles.getElementsByTagName('cellXfs')[0]
  Array.from(xfs?.getElementsByTagName('xf') ?? []).forEach((xf, i) => {
    const id = xf.getAttribute('numFmtId') ?? ''
    if ((Number(id) >= 14 && Number(id) <= 22) || custom.has(id)) out.add(i)
  })
  return out
}

export async function parseXlsx(buf: ArrayBuffer): Promise<string[][]> {
  const files = await unzip(buf)
  const shared = Array.from(xml(files.get('xl/sharedStrings.xml')).getElementsByTagName('si'), (si) => Array.from(si.getElementsByTagName('t'), (t) => t.textContent ?? '').join(''))
  const dates = dateStyles(xml(files.get('xl/styles.xml')))
  const sheetName = [...files.keys()].filter((f) => /^xl\/worksheets\/[^/]+\.xml$/.test(f)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))[0]
  if (!sheetName) throw new Error('no sheet')
  const out: string[][] = []
  for (const row of xml(files.get(sheetName)).getElementsByTagName('row')) {
    const cells: string[] = []
    for (const c of row.getElementsByTagName('c')) {
      const i = columnOf(c.getAttribute('r') ?? 'A')
      const type = c.getAttribute('t')
      const value = c.getElementsByTagName('v')[0]?.textContent ?? ''
      let text = value
      if (type === 's') text = shared[Number(value)] ?? ''
      else if (type === 'inlineStr') text = Array.from(c.getElementsByTagName('t'), (t) => t.textContent ?? '').join('')
      else if (type === 'b') text = value === '1' ? 'true' : 'false'
      else if (value && dates.has(Number(c.getAttribute('s')))) text = new Date(Date.UTC(1899, 11, 30) + Number(value) * DAY_MS).toISOString().slice(0, 10)
      while (cells.length < i) cells.push('')
      cells[i] = text
    }
    if (cells.some((v) => v !== '')) out.push(cells)
  }
  return out
}

export async function readSheet(file: File): Promise<Sheet> {
  if (/\.xlsx$/i.test(file.name)) return toSheet(await parseXlsx(await file.arrayBuffer()))
  const bytes = await file.arrayBuffer()
  // Korean bank exports are often still EUC-KR. A UTF-8 file decodes cleanly, so that is tried first.
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { text = new TextDecoder('euc-kr').decode(bytes) }
  return toSheet(parseCsv(text))
}

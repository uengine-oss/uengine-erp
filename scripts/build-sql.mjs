// Concatenates sql/*.sql (numeric order) into one script the user pastes into the Supabase SQL Editor.
// The result is idempotent: running it again upgrades an existing install without touching data.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, 'sql')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
// ERP_SQL_ONLY=00,10,20 builds a subset, so a module can be tested while its neighbours are unfinished.
const only = process.env.ERP_SQL_ONLY?.split(',')
const files = fs.readdirSync(dir).filter((f) => /^\d+.*\.sql$/.test(f)).filter((f) => !only || only.includes(f.slice(0, 2)) || f.startsWith('99')).sort()
// The Korean names of ledger events live in one file the screens read too, so SQL takes them from there and the two cannot differ.
const labels = JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, 'web', 'src', 'lib', 'eventLabels.json'), 'utf8')))
if (labels.includes('$labels$')) throw new Error('eventLabels.json may not contain $labels$')
const chunk = (f) => `-- ===== ${f} =====\n${fs.readFileSync(path.join(dir, f), 'utf8').trim()}\n`.replaceAll('@EVENT_LABELS@', labels)
const body = files.map(chunk).join('\n')

// Every build stamps the schema: the hash of what this script installs, and when its commit was made. The app carries the
// same stamp, so a database installed from an older build is asked to upgrade on its own, without anyone bumping a version.
const schemaHash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12)
let schemaTime = Math.floor(Date.now() / 1000)
try { schemaTime = Number(execSync('git log -1 --format=%ct', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()) || schemaTime } catch { /* no git: build time */ }
const build = `${pkg.version}+${schemaTime}.${schemaHash}`

// The cloud SQL Editor refuses a query this large ("Query is too large to be run via the SQL Editor"), so the same files
// also go out in parts, cut at module boundaries and run in order. Each part is its own transaction and records itself;
// the database counts as installed only when every part of this version has run (erp_status).
const PARTS = [
  { label: '기본(판매)', from: '00' },
  { label: '재고·구매', from: '40' },
  { label: '청구·회계', from: '60' },
  { label: '자산·세금·인사·급여', from: '66' },
  { label: '경비·CRM·프로젝트·제조·보전·품질·헬프데스크', from: '67d' },
  { label: '장부·분석·연동', from: '68' },
]
const PART_MAX_BYTES = 450 * 1024
// Plain code-unit order, the same order the files are sorted and run in ('67_hr' < '67a' < '67c').
const partOf = (f) => PARTS.findLastIndex((p) => f >= p.from)
const markAll = PARTS.map((_, i) => `select erp.install_part_done(${i + 1}, ${PARTS.length}, '${build}');`).join('\n')
const version = `insert into erp.meta(key, value) values ('schema_version', to_jsonb('${pkg.version}'::text)),
  ('schema_build', jsonb_build_object('time', ${schemaTime}, 'hash', '${schemaHash}'))
  on conflict (key) do update set value = excluded.value;`

const out = `-- uEngine ERP install / upgrade script v${pkg.version}
-- Run this once in your Supabase project: SQL Editor -> New query -> paste -> Run.
-- Safe to run again; it never deletes your data. Too large for the cloud SQL Editor: there, run install-1.sql … install-${PARTS.length}.sql in order.
begin;
${body}
${markAll}
${version}
commit;
notify pgrst, 'reload schema';
`
const parts = only ? [] : PARTS.map((p, i) => {
  const mine = files.filter((f) => partOf(f) === i)
  const sql = `-- uEngine ERP 설치 ${i + 1}/${PARTS.length}: ${p.label} (v${pkg.version})
-- SQL Editor 에 붙여 넣고 Run 을 누릅니다. 1번부터 순서대로 실행하세요. 다시 실행해도 데이터는 지워지지 않습니다.
begin;
${mine.map(chunk).join('\n')}
select erp.install_part_done(${i + 1}, ${PARTS.length}, '${build}');
${i === PARTS.length - 1 ? version + '\n' : ''}commit;
notify pgrst, 'reload schema';
`
  const bytes = Buffer.byteLength(sql)
  if (!mine.length) throw new Error(`install part ${i + 1} (${p.label}) has no files`)
  if (bytes > PART_MAX_BYTES) throw new Error(`install part ${i + 1} (${p.label}) is ${Math.round(bytes / 1024)} KB, over ${PART_MAX_BYTES / 1024} KB: move a file to the next part`)
  return { n: i + 1, label: p.label, files: mine, bytes, sql }
})
const target = process.env.ERP_SQL_OUT || path.join(root, 'dist-sql', 'install.sql')
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.writeFileSync(target, out)
const manifest = parts.map(({ n, label, files: fs_, bytes }) => ({ n, label, file: `install-${n}.sql`, files: fs_, bytes }))
for (const p of parts) fs.writeFileSync(path.join(path.dirname(target), `install-${p.n}.sql`), p.sql)
const gen = path.join(root, 'web', 'src', 'generated')
// A subset build leaves the web app's copy alone unless asked: ERP_SQL_WEB=1 lets browser tests run on the subset.
if ((!only || process.env.ERP_SQL_WEB === '1') && fs.existsSync(path.join(root, 'web', 'src'))) {
  fs.mkdirSync(gen, { recursive: true })
  fs.writeFileSync(path.join(gen, 'install.sql'), out)
  for (const f of fs.readdirSync(gen).filter((x) => /^install-\d+\.sql$/.test(x))) fs.rmSync(path.join(gen, f))
  for (const p of parts) fs.writeFileSync(path.join(gen, `install-${p.n}.sql`), p.sql)
  fs.writeFileSync(path.join(gen, 'install-parts.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(gen, 'version.json'), JSON.stringify({ version: pkg.version, build, schema: { time: schemaTime, hash: schemaHash } }))
}
console.log(`install.sql: ${files.length} files, ${(out.length / 1024).toFixed(0)} KB, build ${build}` +
  (parts.length ? `; ${parts.length} parts: ${parts.map((p) => `${p.n} ${p.label} ${Math.round(p.bytes / 1024)} KB`).join(', ')}` : ''))

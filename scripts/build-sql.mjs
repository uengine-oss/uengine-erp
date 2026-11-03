// Concatenates sql/*.sql (numeric order) into one script the user pastes into the Supabase SQL Editor.
// The result is idempotent: running it again upgrades an existing install without touching data.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, 'sql')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
// ERP_SQL_ONLY=00,10,20 builds a subset, so a module can be tested while its neighbours are unfinished.
const only = process.env.ERP_SQL_ONLY?.split(',')
const files = fs.readdirSync(dir).filter((f) => /^\d+.*\.sql$/.test(f)).filter((f) => !only || only.includes(f.slice(0, 2)) || f.startsWith('99')).sort()
const body = files.map((f) => `-- ===== ${f} =====\n${fs.readFileSync(path.join(dir, f), 'utf8').trim()}\n`).join('\n')
const out = `-- uEngine ERP install / upgrade script v${pkg.version}
-- Run this once in your Supabase project: SQL Editor -> New query -> paste -> Run.
-- Safe to run again; it never deletes your data.
begin;
${body}
insert into erp.meta(key, value) values ('schema_version', to_jsonb('${pkg.version}'::text))
  on conflict (key) do update set value = excluded.value;
commit;
notify pgrst, 'reload schema';
`
const target = process.env.ERP_SQL_OUT || path.join(root, 'dist-sql', 'install.sql')
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.writeFileSync(target, out)
const gen = path.join(root, 'web', 'src', 'generated')
if (!only && fs.existsSync(path.join(root, 'web', 'src'))) {
  fs.mkdirSync(gen, { recursive: true })
  fs.writeFileSync(path.join(gen, 'install.sql'), out)
  fs.writeFileSync(path.join(gen, 'version.json'), JSON.stringify({ version: pkg.version }))
}
console.log(`install.sql: ${files.length} files, ${(out.length / 1024).toFixed(0)} KB`)

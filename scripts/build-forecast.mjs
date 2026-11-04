// The models the analytics screens run, as one file an agent's host can load: it reads the facts over MCP (erp_read analytics)
// and runs the same code, so a screen and an agent cannot give two different answers for one ledger.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'dist-forecast', 'forecast.mjs')
execFileSync(path.join(root, 'web/node_modules/.bin/rolldown'), ['web/src/lib/forecast/index.ts', '--format', 'esm', '--file', out], { cwd: root, stdio: 'pipe' })
const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim()
fs.writeFileSync(out, `// Built from uengine-erp ${sha} by scripts/build-forecast.mjs. Do not edit.\n${fs.readFileSync(out, 'utf8')}`)
console.log(`${out} ${fs.statSync(out).size} bytes`)

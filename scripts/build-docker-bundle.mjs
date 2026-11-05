// Builds the downloadable Docker bundle: dist-docker/uengine-erp-docker-<version>.zip and its .sha256.
// The zip holds docker/ (compose file, configs, install.sh, README), the built web app and install.sql.
// Entries are sorted and dated to the last commit, so the same commit gives the same zip.
//   node scripts/build-docker-bundle.mjs            builds the web app first (npm --prefix web run build)
//   node scripts/build-docker-bundle.mjs --no-web   reuses web/dist and dist-sql/install.sql as they are
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const name = `uengine-erp-docker-${pkg.version}`
const outDir = path.join(root, 'dist-docker')
const stage = path.join(outDir, name)

if (!process.argv.includes('--no-web')) {
  execFileSync('npm', ['--prefix', 'web', 'run', 'build'], { cwd: root, stdio: 'inherit' })
}
const webDist = path.join(root, 'web', 'dist')
const sqlFile = path.join(root, 'dist-sql', 'install.sql')
for (const f of [path.join(webDist, 'index.html'), sqlFile]) {
  if (!fs.existsSync(f)) throw new Error(`${path.relative(root, f)} is missing: build without --no-web`)
}
// The app must not carry a config of its own: erp-config.json comes from the bundle's web server only.
if (fs.existsSync(path.join(webDist, 'erp-config.json'))) throw new Error('web/dist/erp-config.json must not exist')

let commit = 'unknown'
let epoch = Math.floor(Date.now() / 1000)
try {
  commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  epoch = Number(execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: root, encoding: 'utf8' }).trim())
} catch { /* not a git checkout: date it now */ }
if (process.env.SOURCE_DATE_EPOCH) epoch = Number(process.env.SOURCE_DATE_EPOCH)

fs.rmSync(stage, { recursive: true, force: true })
fs.mkdirSync(stage, { recursive: true })
const copy = (from, to) => fs.cpSync(from, path.join(stage, to), { recursive: true })
copy(path.join(root, 'docker', 'docker-compose.yml'), 'docker-compose.yml')
copy(path.join(root, 'docker', 'install.sh'), 'install.sh')
copy(path.join(root, 'docker', 'README.md'), 'README.md')
copy(path.join(root, 'docker', 'config'), 'config')
copy(webDist, 'web')
copy(sqlFile, path.join('sql', 'install.sql'))
copy(path.join(root, 'LICENSE'), 'LICENSE')
fs.writeFileSync(path.join(stage, 'VERSION'), `uEngine ERP ${pkg.version} (${commit})\n`)

const files = []
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.isFile() && e.name !== '.DS_Store') files.push(p)
  }
}
walk(stage)
files.sort()
const executable = (rel) => rel === 'install.sh' || rel.endsWith('.sh')

// ---- zip writer: deflate, Unix permissions, fixed DOS date ----
const d = new Date(epoch * 1000)
const dosTime = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1)
const dosDate = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate()
const locals = []
const centrals = []
let offset = 0
for (const file of files) {
  const rel = path.relative(stage, file).split(path.sep).join('/')
  const entry = Buffer.from(`${name}/${rel}`, 'utf8')
  const data = fs.readFileSync(file)
  const packed = zlib.deflateRawSync(data, { level: 9 })
  const crc = zlib.crc32(data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8)
  local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(entry.length, 26)
  locals.push(local, entry, packed)
  const mode = executable(rel) ? 0o100755 : 0o100644
  const head = Buffer.alloc(46)
  head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE((3 << 8) | 20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(0x0800, 8)
  head.writeUInt16LE(8, 10); head.writeUInt16LE(dosTime, 12); head.writeUInt16LE(dosDate, 14); head.writeUInt32LE(crc, 16)
  head.writeUInt32LE(packed.length, 20); head.writeUInt32LE(data.length, 24); head.writeUInt16LE(entry.length, 28)
  head.writeUInt32LE((mode << 16) >>> 0, 38); head.writeUInt32LE(offset, 42)
  centrals.push(head, entry)
  offset += 30 + entry.length + packed.length
}
const centralSize = centrals.reduce((n, b) => n + b.length, 0)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16)
const zip = Buffer.concat([...locals, ...centrals, end])

const zipPath = path.join(outDir, `${name}.zip`)
fs.writeFileSync(zipPath, zip)
const sha = crypto.createHash('sha256').update(zip).digest('hex')
fs.writeFileSync(`${zipPath}.sha256`, `${sha}  ${name}.zip\n`)
console.log(`${path.relative(root, zipPath)}: ${files.length} files, ${(zip.length / 1048576).toFixed(2)} MB`)
console.log(`sha256 ${sha}`)

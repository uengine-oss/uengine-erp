// Serves web/dist the way GitHub Pages does: plain static files, at the root and under a project path.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist')
export const PAGES_PREFIX = '/uengine-erp/app'
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' }

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (p === PAGES_PREFIX) { res.writeHead(301, { Location: `${PAGES_PREFIX}/` }); res.end(); return }
  if (p.startsWith(`${PAGES_PREFIX}/`)) p = p.slice(PAGES_PREFIX.length)
  if (p.endsWith('/')) p += 'index.html'
  const file = path.join(dist, path.normalize(p))
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
}).listen(5301, '127.0.0.1')

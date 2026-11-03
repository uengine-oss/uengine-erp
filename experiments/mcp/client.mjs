import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
const API = process.env.API_URL, KEY = process.env.ANON_KEY
const tok = (await (await fetch(`${API}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', password: 'owner-pass-1234' }) })).json()).access_token
await new Promise(r => setTimeout(r, 1500))
const open = async (token) => {
  const c = new Client({ name: 'probe', version: '1.0' })
  c.onerror = (e) => console.log('   [client onerror]', String(e.message ?? e).slice(0, 140))
  await c.connect(new StreamableHTTPClientTransport(new URL(`${API}/rest/v1/rpc/erp_mcp`), { requestInit: { headers: { apikey: KEY, Authorization: `Bearer ${token}` } } }))
  return c
}
const text = (r) => r.content?.[0]?.text
const c = await open(tok)
console.log('server', JSON.stringify(c.getServerVersion()), 'caps', JSON.stringify(c.getServerCapabilities()))
const { tools } = await c.listTools()
console.log('tools', tools.map(t => t.name).join(','), ' tools/list bytes', Buffer.byteLength(JSON.stringify(tools)))
const types = JSON.parse(text(await c.callTool({ name: 'erp_read', arguments: {} })))
console.log('types', types.length, types.slice(0, 4).map(t => t.type).join(','))
const schema = JSON.parse(text(await c.callTool({ name: 'erp_read', arguments: { type: 'partner', schema: true } })))
console.log('partner fields', schema.fields.length)
const t0 = performance.now()
const made = JSON.parse(text(await c.callTool({ name: 'erp_create', arguments: { type: 'partner', values: { name: 'MCP 거래처' }, reason: '시험' } })))
console.log('create', made.id?.slice(0, 8), 'v' + made.version, made.events?.map(e => e.type).join(','), Math.round(performance.now() - t0) + 'ms')
const stale = await c.callTool({ name: 'erp_update', arguments: { type: 'partner', id: made.id, values: { name: 'x' }, expected_version: 99 } })
console.log('stale update isError', stale.isError, text(stale).slice(0, 60))
const bad = await c.callTool({ name: 'erp_create', arguments: { type: 'partner', values: {} } })
console.log('missing required isError', bad.isError, text(bad))
const up = JSON.parse(text(await c.callTool({ name: 'erp_update', arguments: { type: 'partner', id: made.id, values: { name: 'MCP 거래처 2' }, expected_version: made.version } })))
console.log('update', 'v' + up.version, up.name)
const del = await c.callTool({ name: 'erp_delete', arguments: { type: 'partner', id: made.id, expected_version: up.version, reason: '시험 끝' } })
console.log('delete isError', del.isError ?? false)
console.log('history', text(await c.callTool({ name: 'erp_read', arguments: { id: made.id, history: true } })).slice(0, 330))
const res = await c.listResources()
console.log('resources', res.resources.length, res.resources.slice(0, 2).map(r => r.uri).join(','))
const rr = await c.readResource({ uri: 'erp://partner/schema' })
console.log('read resource bytes', rr.contents[0].text.length)
await c.close()
console.log('--- public key only')
try { const a = await open(KEY); console.log('connected?!', JSON.stringify(a.getServerVersion())); await a.close() } catch (e) { console.log('refused:', String(e.message).slice(0, 170)) }

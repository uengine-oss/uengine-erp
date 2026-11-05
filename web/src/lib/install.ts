// The install script is large and only needed during setup or an upgrade, so it loads on demand.
import versionInfo from '../generated/version.json'
import partsInfo from '../generated/install-parts.json'

export const APP_VERSION: string = versionInfo.version

export async function installSql(setupCode?: string): Promise<string> {
  const { default: sql } = await import('../generated/install.sql?raw')
  return setupCode ? `${sql}\nselect erp.set_setup_code('${setupCode}');\n` : sql
}

export interface InstallPart { n: number; total: number; label: string; bytes: number; sql: string }

// The cloud SQL Editor refuses the whole script, so it also comes in parts cut at module boundaries, run in order.
// The setup code goes with the last part: company creation opens only once everything is in.
const partFiles = import.meta.glob('../generated/install-*.sql', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>

export async function installParts(setupCode?: string): Promise<InstallPart[]> {
  const total = partsInfo.length
  return Promise.all(partsInfo.map(async (p) => {
    let sql = await partFiles[`../generated/${p.file}`]()
    if (setupCode && p.n === total) sql += `\nselect erp.set_setup_code('${setupCode}');\n`
    return { n: p.n, total, label: p.label, bytes: new TextEncoder().encode(sql).length, sql }
  }))
}

export function setupCodeSql(code: string): string {
  return `select erp.set_setup_code('${code}');`
}

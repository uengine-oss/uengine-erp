// The install script is large and only needed during setup or an upgrade, so it loads on demand.
import versionInfo from '../generated/version.json'

export const APP_VERSION: string = versionInfo.version

export async function installSql(setupCode?: string): Promise<string> {
  const { default: sql } = await import('../generated/install.sql?raw')
  return setupCode ? `${sql}\nselect erp.set_setup_code('${setupCode}');\n` : sql
}

export function setupCodeSql(code: string): string {
  return `select erp.set_setup_code('${code}');`
}

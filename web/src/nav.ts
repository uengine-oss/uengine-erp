// The app's menu: module -> screens. A screen naming a type appears only once that type is installed.
//
// To replace the generic screens for one type, add `list` and/or `form` to its entry:
//   { type: 'sales_order', form: () => import('./screens/SalesOrderForm.vue') }
// A custom form receives the same props as MetaForm: { type, id }.
import type { Component } from 'vue'
import type { CatalogDoc } from './lib/types'

type Loader = () => Promise<{ default: Component }>

export interface NavScreen {
  /** Catalog type. The screen is hidden until the type is installed. */
  type?: string
  label?: string
  /** A fixed route instead of a type's list. */
  route?: string
  /** Shown only to admins. The database refuses everyone else regardless. */
  adminOnly?: boolean
  /** Another route prefix that counts as this screen in the menu. */
  also?: string
  list?: Loader
  form?: Loader
  /** Line tables on this type can hold section and note rows. */
  sections?: boolean
  /** Fields the server ignores after creation, shown read-only on existing records. */
  lockedAfterCreate?: string[]
  /** Line tables whose rows only the server creates: they can be edited but not added or removed. */
  fixedLines?: string[]
  /** Line columns that hold internal ids and mean nothing on screen, by line field. */
  hideColumns?: Record<string, string[]>
}

export interface NavModule {
  key: string
  label: string
  icon: string
  /** Modules without screens link straight here. */
  route?: string
  screens?: NavScreen[]
}

export const NAV: NavModule[] = [
  { key: 'home', label: '홈', icon: 'home', route: '/' },
  {
    key: 'sales', label: '판매', icon: 'sales',
    screens: [
      { type: 'sales_order', sections: true },
      { type: 'quote_template', sections: true },
      { type: 'partner' },
      { type: 'product', fixedLines: ['variants'], hideColumns: { variants: ['values'] } },
      { type: 'pricelist' },
    ],
  },
  {
    key: 'inventory', label: '재고', icon: 'inventory',
    screens: [{ type: 'picking' }, { type: 'stock_adjustment' }, { type: 'scrap' }, { type: 'lot' }, { type: 'reorder_rule' }, { type: 'warehouse' }, { type: 'location' }],
  },
  {
    key: 'purchase', label: '구매', icon: 'purchase',
    screens: [{ type: 'purchase_order', sections: true }],
  },
  {
    key: 'invoicing', label: '청구', icon: 'invoicing',
    screens: [{ type: 'account_move', sections: true }, { type: 'payment' }],
  },
  {
    key: 'accounting', label: '회계', icon: 'accounting',
    screens: [{ type: 'journal_entry', sections: true }, { type: 'account' }],
  },
  {
    key: 'master', label: '기초데이터', icon: 'master',
    screens: [
      { type: 'uom' }, { type: 'product_category' }, { type: 'tag' }, { type: 'tax' },
      { type: 'fiscal_position' }, { type: 'payment_term' }, { type: 'attribute' },
    ],
  },
  { key: 'analytics', label: '분석', icon: 'analytics', route: '/analytics' },
  { key: 'events', label: '이벤트 원장', icon: 'events', route: '/events' },
  {
    key: 'settings', label: '설정', icon: 'settings',
    screens: [
      { label: '회사 정보', route: '/settings/company', also: '/r/company' },
      { label: '구성원', route: '/settings/members', also: '/r/member' },
      { label: '사용량', route: '/settings/usage' },
      { label: '백업', route: '/settings/backup' },
      { label: '접속·보안', route: '/settings/access' },
      { label: '모듈', route: '/settings/modules', adminOnly: true },
      { label: '이벤트 버스', route: '/settings/bus', adminOnly: true },
    ],
  },
]

/** A menu group's name, for screens that talk about modules. */
export const navLabel = (key: string): string | undefined => NAV.find((m) => m.key === key)?.label

/** Types with their own screens in settings; they never appear as generic menu entries. */
const SETTINGS_TYPES: NavScreen[] = [
  { type: 'member', lockedAfterCreate: ['email'], route: '/settings/members' },
  { type: 'company', route: '/settings/company' },
  { type: 'module', route: '/settings/modules' },
]

export function screenFor(type: string): NavScreen | undefined {
  for (const s of SETTINGS_TYPES) if (s.type === type) return s
  for (const m of NAV) {
    const s = m.screens?.find((x) => x.type === type)
    if (s) return s
  }
  return undefined
}

export interface ResolvedScreen { key: string; label: string; to: string; also?: string }
export interface ResolvedModule { key: string; label: string; icon: string; to: string; screens: ResolvedScreen[] }

/**
 * The menu for this installation. The catalog answers only "is this type installed", because a screen
 * cannot render without its metadata. It does not answer "may this user read it": erp_catalog is not
 * filtered by role, so read_roles are enforced by row security and lists show their own empty state.
 * Types a module adds that are not listed above still appear, under the module the catalog names. A module
 * that is off takes its types out of the catalog, and a group with nothing left to show leaves the menu.
 */
export function resolveNav(catalog: CatalogDoc[], admin = false): ResolvedModule[] {
  const docs = new Map(catalog.map((c) => [c.type, c]))
  const listed = new Set(NAV.flatMap((m) => m.screens ?? []).map((s) => s.type))
  SETTINGS_TYPES.forEach((s) => listed.add(s.type))

  const out: ResolvedModule[] = []
  for (const m of NAV) {
    if (m.route) {
      out.push({ key: m.key, label: m.label, icon: m.icon, to: m.route, screens: [] })
      continue
    }
    const screens: ResolvedScreen[] = []
    for (const s of m.screens ?? []) {
      if (s.adminOnly && !admin) continue
      if (s.route) screens.push({ key: s.route, label: s.label ?? s.route, to: s.route, also: s.also })
      else if (s.type && docs.has(s.type) && !docs.get(s.type)!.hidden) {
        screens.push({ key: s.type, label: s.label ?? docs.get(s.type)!.label, to: `/r/${s.type}` })
      }
    }
    for (const doc of catalog) {
      if (doc.module === m.key && !listed.has(doc.type) && !doc.hidden) {
        screens.push({ key: doc.type, label: doc.label, to: `/r/${doc.type}` })
      }
    }
    if (screens.length) out.push({ key: m.key, label: m.label, icon: m.icon, to: screens[0].to, screens })
  }
  // A plugin's module has no entry above. Its types go with the module id until a label is known.
  const known = new Set(NAV.map((m) => m.key))
  const extras = new Map<string, ResolvedScreen[]>()
  for (const doc of catalog) {
    if (known.has(doc.module) || doc.module === 'settings' || doc.hidden || listed.has(doc.type)) continue
    const list = extras.get(doc.module) ?? []
    list.push({ key: doc.type, label: doc.label, to: `/r/${doc.type}` })
    extras.set(doc.module, list)
  }
  const at = out.findIndex((m) => m.key === 'analytics')
  out.splice(at < 0 ? out.length : at, 0, ...[...extras].map(([key, screens]) => ({
    key, label: screens[0].label, icon: 'master', to: screens[0].to, screens,
  })))
  return out
}

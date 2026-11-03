// The app's menu: module -> screens. A screen naming a type appears only once that type is installed.
//
// To replace the generic screens for one type, add `list` and/or `form` to its entry:
//   { type: 'sales_order', form: () => import('./screens/SalesOrderForm.vue') }
// A custom form receives the same props as MetaForm: { type, id }.
import type { Component } from 'vue'
import type { AskOptions } from './lib/ui'
import type { CatalogDoc, ErpRecord, Field, State } from './lib/types'

type Loader = () => Promise<{ default: Component }>

/** The database refused with this code and is waiting for a decision. Ask, then send the answer along with the same command. */
export interface CommandRetry extends Partial<AskOptions> {
  title: string
  payload: (values: State) => State
}

export interface CommandUi {
  /** Parameters people do not fill in: the screen supplies them, or only a refusal makes them matter. */
  hideParams?: string[]
  /** Parameters that depend on the document. */
  fields?: (record: ErpRecord | null) => Field[]
  payload?: (values: State) => State
  retry?: Record<string, CommandRetry>
}

export interface NavScreen {
  /** Catalog type. The screen is hidden until the type is installed. */
  type?: string
  label?: string
  /** A fixed route instead of a type's list. */
  route?: string
  /** Shown only to admins. The database refuses everyone else regardless. */
  adminOnly?: boolean
  /** A fixed route that means nothing until this catalog type is on. */
  needs?: string
  /** A fixed route shown only to these roles (admins see everything). The database refuses everyone else regardless. */
  roles?: string[]
  /** Fields that fold away under "그 밖의 항목", so the lines stay in view. */
  advanced?: string[]
  /** Fields never drawn on the form. */
  hideFields?: string[]
  /** States in which the form is display-only. The server refuses such edits anyway; this just does not offer them. */
  readonlyIn?: string[]
  /** How some commands are asked, where the catalog's parameters alone would not make a usable dialog. */
  commands?: Record<string, CommandUi>
  /** Links and actions beside the form's buttons. Receives { record, doc }. */
  formExtra?: Loader
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

const loader = (name: string): Loader => () => import(`./screens/docs/${name}.vue`)

// When the database asks a person to decide something, and how to ask. Payment-free of rules: it only carries the answer back.
const BACKORDER_FIELD: Field = {
  name: 'backorder', label: '남은 수량', type: 'enum', required: true, default: 'true',
  options: [{ value: 'true', label: '새 전표로 남겨 두기' }, { value: 'false', label: '버리기' }],
}

export const NAV: NavModule[] = [
  { key: 'home', label: '홈', icon: 'home', route: '/' },
  {
    key: 'sales', label: '판매', icon: 'sales',
    screens: [
      {
        type: 'sales_order', sections: true, formExtra: loader('OrderExtras'),
        advanced: ['invoice_partner_id', 'delivery_partner_id', 'fiscal_position_id', 'template_id', 'commitment_date', 'team', 'client_ref', 'origin', 'campaign', 'medium', 'source',
          'shipping_policy', 'shipping_weight', 'incoterm', 'incoterm_location', 'require_signature', 'require_payment', 'prepayment_percent', 'signed_by', 'signed_at', 'declined_reason', 'margin_percent', 'locked', 'expected_date'],
        commands: {
          send: { hideParams: ['via'] },
          add_optional: {
            fields: (r) => [
              { name: 'option_id', label: '선택 제품', type: 'enum', required: true, options: (r?.state.optional_lines ?? []).filter((o: State) => !o.added).map((o: State) => ({ value: o.id, label: o.name ?? o.id })) },
              { name: 'qty', label: '수량', type: 'number', default: 1 },
            ],
          },
        },
      },
      { type: 'quote_template', sections: true, hideColumns: { lines: ['product_id'], optional_lines: ['product_id'] } },
      { type: 'partner' },
      { type: 'product', fixedLines: ['variants'], hideColumns: { variants: ['values'] } },
      { type: 'pricelist' },
    ],
  },
  {
    key: 'inventory', label: '재고', icon: 'inventory',
    screens: [
      { label: '재고 현황', route: '/inventory/stock', needs: 'picking' },
      {
        type: 'picking', formExtra: loader('PickingExtras'), readonlyIn: ['done', 'cancelled'],
        advanced: ['operation_type_id', 'location_from', 'location_to', 'shipping_policy', 'backorder_of', 'return_of', 'is_return', 'to_refund'],
        hideColumns: { moves: ['product_id', 'name', 'lot_id', 'state'] },
        commands: {
          validate: {
            hideParams: ['backorder', 'moves'],
            retry: {
              ERP_BACKORDER_CHOICE: {
                title: '요구 수량보다 적게 처리합니다',
                message: '처리하지 않은 수량을 어떻게 할까요?',
                fields: [BACKORDER_FIELD],
                payload: (v) => ({ backorder: v.backorder === 'true' }),
              },
            },
          },
        },
      },
      {
        type: 'stock_adjustment', readonlyIn: ['applied', 'reverted'], hideFields: ['product_id', 'name'],
        advanced: ['reference', 'count_date', 'assignee_id', 'accounting_date', 'counted_by', 'applied_by', 'applied_at', 'lot_id'],
        commands: {
          apply: {
            hideParams: ['force'],
            retry: { ERP_STOCK_MOVED: { title: '실사 뒤에 재고가 움직였습니다', confirmLabel: '그래도 반영', danger: true, payload: () => ({ force: true }) } },
          },
        },
      },
      {
        type: 'scrap', readonlyIn: ['done'], hideFields: ['product_id', 'name'],
        commands: {
          validate: {
            hideParams: ['force'],
            retry: { ERP_SCRAP_SHORT: { title: '재고보다 많이 폐기합니다', confirmLabel: '그래도 폐기', danger: true, payload: () => ({ force: true }) } },
          },
        },
      },
      { type: 'lot', hideFields: ['product_id'] },
      { type: 'reorder_rule' },
      { type: 'stock_replenishment', hideFields: ['product_id'] },
      { type: 'operation_type' },
      { type: 'warehouse' },
      { type: 'location' },
    ],
  },
  {
    key: 'purchase', label: '구매', icon: 'purchase',
    screens: [
      {
        type: 'purchase_order', sections: true, formExtra: loader('PurchaseExtras'),
        advanced: ['fiscal_position_id', 'buyer_id', 'origin', 'ask_confirmation', 'confirmed_by_vendor_at', 'date_confirmed', 'date_received', 'locked', 'currency'],
        hideColumns: { lines: ['product_id', 'sequence', 'date_planned'] },
        commands: {
          // Goods with a receipt slip get their quantity from the slip. This is for services and for companies without stock.
          receive: {
            fields: (r) => (r?.state.lines ?? []).filter((l: State) => !l.display_type).map((l: State): Field => ({ name: l.id, label: l.name ?? '줄', type: 'number', default: l.qty_received ?? 0 })),
            payload: (v) => ({ lines: Object.entries(v).map(([id, qty]) => ({ id, qty_received: qty })) }),
          },
        },
      },
    ],
  },
  {
    key: 'invoicing', label: '청구', icon: 'invoicing',
    screens: [
      { label: '청구 대상', route: '/invoicing/targets', needs: 'account_move', roles: ['accounting', 'sales', 'purchase'] },
      {
        type: 'account_move', sections: true, formExtra: loader('InvoiceExtras'), readonlyIn: ['posted', 'cancelled'],
        advanced: ['date', 'payment_reference', 'narration', 'incoterm', 'incoterm_place', 'partner_bank', 'should_be_paid', 'fiscal_position_id', 'currency', 'ref', 'auto_post', 'reversal_of', 'reversed_by', 'reversal_reason', 'debit_note_of'],
        hideFields: ['installments', 'applied', 'state'],
        hideColumns: { lines: ['product_id'] },
      },
      { type: 'payment', readonlyIn: ['in_process', 'paid', 'rejected', 'cancelled'], advanced: ['writeoff_amount', 'writeoff_account_id', 'writeoff_label', 'partner_type'], hideFields: ['state'] },
      { label: '미수금·미지급금', route: '/invoicing/aged', needs: 'account_move', roles: ['accounting', 'sales', 'purchase'] },
    ],
  },
  {
    key: 'accounting', label: '회계', icon: 'accounting',
    screens: [
      { type: 'journal_entry', sections: true, readonlyIn: ['posted', 'auto', 'cancelled'], hideFields: ['state'], advanced: ['origin_event', 'reversal_of', 'reversed_by'] },
      { type: 'account' },
      { label: '시산표', route: '/accounting/trial-balance', needs: 'journal_entry', roles: ['accounting'] },
      { label: '손익계산서', route: '/accounting/profit-loss', needs: 'journal_entry', roles: ['accounting'] },
      { label: '재무상태표', route: '/accounting/balance-sheet', needs: 'journal_entry', roles: ['accounting'] },
    ],
  },
  {
    key: 'master', label: '기초데이터', icon: 'master',
    screens: [
      { type: 'uom' }, { type: 'product_category' }, { type: 'tag' }, { type: 'tax' },
      { type: 'fiscal_position' }, { type: 'payment_term' }, { type: 'attribute' },
    ],
  },
  {
    key: 'analytics', label: '분석', icon: 'analytics',
    screens: [
      { label: '예측·what-if', route: '/analytics/models' },
      { label: '매출 통계', route: '/analytics/stats' },
      { label: '견적 전환율', route: '/analytics/quotes' },
    ],
  },
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
      { label: '연동', route: '/settings/integration', adminOnly: true },
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
  { type: 'api_key', route: '/settings/integration' },
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
export function resolveNav(catalog: CatalogDoc[], roles: string[] = []): ResolvedModule[] {
  const admin = roles.includes('admin')
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
      if (s.needs && !docs.has(s.needs)) continue
      if (s.roles && !admin && !s.roles.some((r) => roles.includes(r))) continue
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

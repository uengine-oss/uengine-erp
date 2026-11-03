<script setup lang="ts">
// One document as it goes on paper. Every figure is what the record already says; nothing is worked out here but the
// sums that gather tax labels for the foot of the page and the weight of a slip.
import { computed } from 'vue'
import { fmtDate, fmtMoney, fmtNumber } from '../../lib/format'
import type { ErpRecord, State } from '../../lib/types'

export interface DocExtras {
  company: State
  names: Record<string, string>
  partners: Record<string, State>
  /** Tax definitions, for group names and labels. */
  taxes: Record<string, State>
  /** The product of each move, for weights. */
  products: Record<string, State>
  /** The order behind an invoice, for its delivery address. */
  order?: State | null
}

const props = defineProps<{ record: ErpRecord; extras: DocExtras; showInstallments?: boolean; showSignature?: boolean }>()
const s = computed<State>(() => props.record.state)
const type = computed(() => props.record.type)
const name = (id: unknown) => (id ? props.extras.names[String(id)] ?? '' : '')

const TITLES: Record<string, string> = { out_invoice: '청구서', out_refund: '대변 메모', in_invoice: '공급사 청구서', in_refund: '공급사 대변 메모' }
const title = computed(() => {
  if (type.value === 'sales_order') return ['draft', 'sent'].includes(s.value.state) ? '견적서' : '주문서'
  if (type.value === 'purchase_order') return ['draft', 'sent', 'to_approve'].includes(s.value.state) ? '견적 요청서' : '발주서'
  if (type.value === 'picking') return s.value.picking_type === 'outgoing' ? '납품서' : s.value.picking_type === 'incoming' ? '입고 확인서' : '이동 전표'
  return TITLES[s.value.move_type] ?? '청구서'
})
function address(id: unknown): string {
  const p = props.extras.partners[String(id ?? '')]
  if (!p) return ''
  return [[p.street, p.city, p.zip].filter(Boolean).join(' '), [p.phone, p.email].filter(Boolean).join(' · '), p.tax_id ? `사업자등록번호 ${p.tax_id}` : ''].filter(Boolean).join('\n')
}
const parties = computed(() => {
  const main = s.value.partner_id
  if (type.value === 'sales_order') {
    const bill = s.value.invoice_partner_id ?? main
    const ship = s.value.delivery_partner_id ?? main
    return [{ label: '고객', id: main }, ...(bill !== main ? [{ label: '청구지', id: bill }] : []), ...(ship !== main ? [{ label: '배송지', id: ship }] : [])]
  }
  if (type.value === 'purchase_order') return [{ label: '공급사', id: main }]
  if (type.value === 'picking') return main ? [{ label: s.value.picking_type === 'incoming' ? '보낸 곳' : '받는 곳', id: main }] : []
  const order = props.extras.order
  const bill = order?.invoice_partner_id ?? main
  const ship = order?.delivery_partner_id
  return [{ label: String(s.value.move_type).startsWith('in_') ? '공급사' : '청구지', id: bill }, ...(ship && ship !== bill ? [{ label: '배송지', id: ship }] : [])]
})
const meta = computed<{ label: string; value: string }[]>(() => {
  const v = s.value
  const rows: [string, unknown][] = type.value === 'sales_order' ? [['주문일', fmtDate(v.date_order)], ['유효기간', fmtDate(v.validity_date)], ['고객 참조', v.client_ref], ['결제 조건', name(v.payment_term_id)]]
    : type.value === 'purchase_order' ? [['주문 마감일', fmtDate(v.date_order)], ['입고 예정일', fmtDate(v.date_planned)], ['공급사 참조', v.vendor_ref], ['결제 조건', name(v.payment_term_id)], ['입고 창고', name(v.warehouse_id)]]
    : type.value === 'picking' ? [['원본 문서', v.origin_name], ['예정일', fmtDate(v.scheduled_date)], ['완료일', fmtDate(v.date_done)], ['창고', name(v.warehouse_id)]]
    : [['청구일', fmtDate(v.invoice_date)], ['만기일', fmtDate(v.due_date)], ['참조', v.ref], ['결제 참조', v.payment_reference], ['결제 조건', name(v.payment_term_id)], ['원본', v.origin_name]]
  return rows.filter(([, x]) => x).map(([label, x]) => ({ label, value: String(x) }))
})
const isSlip = computed(() => type.value === 'picking')
const lines = computed<State[]>(() => (isSlip.value ? s.value.moves ?? [] : s.value.lines ?? []))

/* Each line's tax label, and the foot that adds them up. A group's parts are summed under the group's own name. */
const taxLabel = (t: State | undefined, fallback?: string) => t?.description || t?.name || fallback || ''
function groupOf(taxId: string, lineIds: string[]): State | undefined {
  return lineIds.map((id) => props.extras.taxes[id]).find((t) => t?.amount_type === 'group' && (t.children_tax_ids ?? []).includes(taxId))
}
const lineTax = (l: State) => (l.tax_ids ?? []).map((id: string) => taxLabel(props.extras.taxes[id])).filter(Boolean).join(', ')
const taxFoot = computed(() => {
  const by = new Map<string, number>()
  for (const l of lines.value) {
    if (l.display_type) continue
    const parts: State[] = Array.isArray(l.taxes) ? l.taxes : []
    if (parts.length) {
      for (const t of parts) {
        const group = groupOf(String(t.tax_id), l.tax_ids ?? [])
        const label = group ? taxLabel(group) : taxLabel(props.extras.taxes[String(t.tax_id)], t.name)
        by.set(label, (by.get(label) ?? 0) + Number(t.amount ?? 0))
      }
    } else if (Number(l.tax_amount ?? 0)) {
      const label = lineTax(l) || '세액'
      by.set(label, (by.get(label) ?? 0) + Number(l.tax_amount))
    }
  }
  return [...by.entries()].map(([label, amount]) => ({ label, amount }))
})
const totalWeight = computed(() => lines.value.reduce((n, m) => n + Number(m.done || m.demand || 0) * Number(props.extras.products[String(m.product_id)]?.weight ?? 0), 0))
const installments = computed<State[]>(() => (Array.isArray(s.value.installments) ? s.value.installments : []))
const logo = computed(() => { const u = String(props.extras.company.logo_url ?? ''); return u.startsWith('data:image/') ? u : '' })
const signature = computed(() => (String(s.value.signature ?? '').startsWith('data:image/') ? String(s.value.signature) : ''))
const number = computed(() => s.value.number ?? (props.record.status === 'draft' ? '초안' : ''))
const note = computed(() => s.value.note ?? s.value.narration)
</script>

<template>
  <article class="doc" data-testid="doc-sheet" :data-type="record.type">
    <header class="doc-head">
      <div><h1 data-testid="doc-title">{{ title }}</h1><div class="doc-number" data-testid="doc-number">{{ number }}</div></div>
      <div class="doc-company">
        <img v-if="logo" :src="logo" alt="" class="doc-logo" data-testid="doc-logo" />
        <strong>{{ extras.company.name }}</strong>
        <div>{{ extras.company.address }}</div>
        <div>{{ [extras.company.phone, extras.company.email].filter(Boolean).join(' · ') }}</div>
        <div v-if="extras.company.registration_no">사업자등록번호 {{ extras.company.registration_no }}</div>
      </div>
    </header>
    <section class="doc-parties">
      <div v-for="p in parties" :key="p.label" class="doc-party" data-testid="doc-party" :data-label="p.label"><strong>{{ p.label }}</strong><span>{{ name(p.id) }}</span><span>{{ address(p.id) }}</span></div>
    </section>
    <section class="doc-meta"><div v-for="m in meta" :key="m.label"><strong>{{ m.label }}</strong>{{ m.value }}</div></section>

    <table v-if="isSlip" data-testid="doc-lines">
      <thead><tr><th>제품</th><th class="num">요구 수량</th><th class="num">처리 수량</th><th>로트</th></tr></thead>
      <tbody><tr v-for="(m, i) in lines" :key="m.id ?? i" data-testid="doc-line"><td>{{ m.name ?? name(m.variant_id) }}</td><td class="num">{{ fmtNumber(m.demand) }} {{ name(m.uom_id) }}</td><td class="num">{{ fmtNumber(m.done) }}</td><td>{{ name(m.lot_id) || m.lot_name }}</td></tr></tbody>
    </table>
    <table v-else data-testid="doc-lines">
      <thead><tr><th>품목</th><th class="num">수량</th><th class="num">단가</th><th class="num">할인</th><th>세금</th><th class="num">금액</th></tr></thead>
      <tbody>
        <template v-for="(l, i) in lines" :key="l.id ?? i">
          <tr v-if="l.display_type" :class="l.display_type === 'section' ? 'doc-section' : 'doc-note'"><td colspan="6">{{ l.name }}</td></tr>
          <tr v-else data-testid="doc-line"><td>{{ l.name }}</td><td class="num">{{ fmtNumber(l.qty) }} {{ name(l.uom_id) }}</td><td class="num">{{ fmtMoney(l.price_unit) }}</td><td class="num">{{ l.discount ? `${fmtNumber(l.discount)}%` : '' }}</td><td data-testid="doc-line-tax">{{ lineTax(l) }}</td><td class="num">{{ fmtMoney(l.subtotal) }}</td></tr>
        </template>
      </tbody>
    </table>

    <table v-if="!isSlip" class="doc-totals" data-testid="doc-totals">
      <tbody>
        <tr><td>공급가액</td><td class="num" data-testid="doc-untaxed">{{ fmtMoney(s.amount_untaxed) }}</td></tr>
        <tr v-for="t in taxFoot" :key="t.label" data-testid="doc-tax"><td>{{ t.label }}</td><td class="num">{{ fmtMoney(t.amount) }}</td></tr>
        <tr class="grand"><td>합계</td><td class="num" data-testid="doc-total">{{ fmtMoney(s.amount_total) }}</td></tr>
        <tr v-if="record.type === 'account_move' && record.status === 'posted'"><td>잔액</td><td class="num" data-testid="doc-residual">{{ fmtMoney(s.amount_residual) }}</td></tr>
      </tbody>
    </table>
    <p v-else-if="totalWeight" class="doc-text" style="margin-top: 8px; text-align: right" data-testid="doc-weight">총중량 {{ fmtNumber(totalWeight) }}</p>

    <section v-if="showInstallments && installments.length" class="doc-block" data-testid="doc-installments">
      <h2>회차별 금액</h2>
      <table>
        <thead><tr><th>만기</th><th class="num">금액</th><th>할인 기한</th><th class="num">할인 후 금액</th></tr></thead>
        <tbody><tr v-for="(p, i) in installments" :key="i" data-testid="doc-installment"><td>{{ fmtDate(p.due_date) }}</td><td class="num">{{ fmtMoney(p.amount) }}</td><td>{{ fmtDate(p.discount_date) }}</td><td class="num">{{ fmtMoney(p.discount_amount) }}</td></tr></tbody>
      </table>
    </section>
    <section v-if="note" class="doc-block"><h2>메모</h2><p class="doc-text" style="margin: 0">{{ note }}</p></section>
    <section v-if="showSignature && s.signed_by" class="doc-block" data-testid="doc-signature">
      <h2>서명</h2>
      <img v-if="signature" :src="signature" alt="서명" class="doc-sign-img" />
      <p style="margin: 0">{{ s.signed_by }} · {{ fmtDate(s.signed_at) }}</p>
    </section>
    <section v-if="isSlip" class="doc-signs"><div>보낸 사람 서명</div><div>받은 사람 서명</div></section>
  </article>
</template>

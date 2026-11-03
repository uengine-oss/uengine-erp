# 판매 (`sql/30_sales.sql`)

`quote_template`: `name, validity_days, note, require_signature, require_payment, prepayment_percent, lines[..], optional_lines[..]`

`sales_order`: `number(S00001), partner_id, invoice_partner_id, delivery_partner_id, pricelist_id, payment_term_id, fiscal_position_id, template_id, date_order, validity_date, commitment_date, salesperson_id, team, client_ref, tags, note, shipping_policy(direct/one), incoterm, warehouse_id, require_signature, require_payment, prepayment_percent, portal_token, signed_by, signed_at, state(draft/sent/sale/cancelled), locked, invoice_status(no/to_invoice/invoiced/upselling), delivery_status(no/pending/partial/full), amount_untaxed, amount_tax, amount_total, margin, lines[..], optional_lines[{id, product_id, variant_id, name, qty, uom_id, price_unit, discount}]`

줄: `id, sequence, display_type(null/section/note), product_id, variant_id, name, qty, uom_id, price_unit, discount, tax_ids, subtotal, tax_amount, total, cost, margin, lead_days, qty_delivered, qty_invoiced, qty_to_invoice, is_downpayment`

명령: `create update send confirm cancel set_draft lock unlock delete`, 추가 `update_prices add_optional`.

| 이벤트 | `data` 의 사실 |
|---|---|
| `QuotationCreated` | 합계 + `partner_id` |
| `QuotationUpdated`, `QuotationLineAdded/Changed/Removed` | 줄 `col`, 합계 `set`, 사유 |
| `QuotationSent` | `via`, `portal_token` |
| `QuotationSigned` | `signed_by`, `signed_at` |
| `SalesOrderConfirmed` | **계약** `{partner_id, delivery_partner_id, warehouse_id, shipping_policy, commitment_date, date_order, lines:[{line_id, product_id, variant_id, name, qty, uom_id, lead_days, unit_price, cost, type}]}` |
| `SalesOrderLineQtyChanged` | 확정 후 수량 변경 **계약** `{line_id, variant_id, product_id, from, to, uom_id, name}` |
| `SalesOrderCancelled` | 사유 |
| `SalesOrderDelivered` | 줄별 `qty_delivered`, `delivery_status` |
| `SalesOrderInvoiced` | 줄별 `qty_invoiced`, `invoice_status` |

- 만료된 견적은 `is_expired` 로 표시한다(일괄 상태 변경 없음).
- 확정 주문의 제품은 못 바꾼다. 잠긴 주문은 수량·가격 변경 불가. 납품·청구가 있는 줄은 삭제 불가.
- `invoice_status`: 청구할 수량이 있으면 `to_invoice`, 모두 청구됐으면 `invoiced`, 주문량 초과 납품 후 추가 청구 대상이면 `upselling`.
- 정책별 청구 대상: `order` 는 `qty - qty_invoiced`, `delivery` 는 `qty_delivered - qty_invoiced`.


## 고객 포털 (`sql/30_sales.sql`)

`public.erp_portal_get(token)`, `public.erp_portal_sign(token, name, signature)`, `public.erp_portal_decline(token, reason)`. 익명 호출 가능, 토큰으로만 그 견적 하나를 본다. 서명하면 `QuotationSigned` → 온라인 서명만 요구된 견적은 자동 확정된다.


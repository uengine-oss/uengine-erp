# 구매 (`sql/50_purchase.sql`)

`purchase_order`: `number(P00001), partner_id, vendor_ref, date_order, date_planned, payment_term_id, fiscal_position_id, buyer_id, warehouse_id, note, ask_confirmation, confirmed_by_vendor_at, state(draft/sent/purchase/cancelled), locked, receipt_status(no/pending/partial/full), billing_status(no/to_bill/billed), amount_untaxed, amount_tax, amount_total, lines[{id, sequence, display_type, product_id, variant_id, name, qty, uom_id, price_unit, discount, tax_ids, subtotal, tax_amount, total, date_planned, qty_received, qty_billed, qty_to_bill}]`

명령: `create update send confirm cancel set_draft lock unlock delete`.

| 이벤트 | 계약 |
|---|---|
| `RfqCreated`, `RfqUpdated`, `RfqLineAdded/Changed/Removed`, `RfqSent` | |
| `PurchaseOrderConfirmed` | `{partner_id, warehouse_id, date_planned, lines:[{line_id, product_id, variant_id, name, qty, uom_id, unit_price, type}]}` |
| `PurchaseOrderLineQtyChanged` | `{line_id, variant_id, product_id, from, to, uom_id, name}` |
| `PurchaseOrderCancelled`, `PurchaseOrderReceived`, `PurchaseOrderBilled` | |

- 단가 자동 입력: 제품 `vendors` 에서 공급사·기간·최소 수량이 맞는 줄. 없으면 원가. `date_planned` = 주문일 + `delay_days`.
- 확정 시 공급사 가격표에 없는 조합이면 `vendors` 에 추가한다.
- 청구 대상: `bill_policy=order` 면 `qty - qty_billed`, `receipt` 면 `qty_received - qty_billed`.


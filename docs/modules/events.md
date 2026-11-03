# 모듈 사이의 이벤트 계약

모듈이 서로 아는 것은 이 문서뿐이다. 필드를 빼거나 뜻을 바꾸면 구독자가 깨지므로 먼저 이 문서를 고친다. 더하는 것은 괜찮다.

## 규칙

- 사실은 이벤트의 `data` 최상위에 싣는다. `set`, `col`, `effects`, `changes` 는 그 스트림 자신을 위한 것이므로 구독자가 읽지 않는다.
- 구독자는 `ev.stream_id` 를 원본 문서 ID 로 쓴다. 수량은 `uom_id` 단위다.
- 구독 처리기는 `fn(ev erp.events) returns void` 다. 같은 이벤트가 두 번 와도 결과가 같아야 한다(커서와 처리 결과는 한 트랜잭션이지만, 건너뛰기·재시도·재설치가 있다).
- 구독 처리기 안에서는 자기 모듈의 문서만 만들고 고친다(`erp.dispatch` 또는 `erp.emit`). 다른 모듈의 표를 읽지 않는다. 필요한 사실이 이벤트에 없으면 이 문서에 추가를 요청한다.
- 처리기는 자기가 만든 문서에 `origin_type`, `origin_id`, `origin_line_id` 를 남긴다.
- `Reverted` 는 요청한 구독자에게만 간다. 되돌려진 작업의 아직 전달되지 않은 이벤트는 커널이 건너뛴다.

## 판매가 내는 것

| 이벤트 | `data` 의 사실 |
|---|---|
| `SalesOrderConfirmed` | `number, partner_id, partner_name, delivery_partner_id, region, warehouse_id, shipping_policy, commitment_date, date_order, currency, amount_untaxed, amount_tax, amount_total, lines:[{line_id, product_id, variant_id, name, qty, uom_id, lead_days, unit_price, discount, subtotal, cost, type, invoice_policy}]` |
| `SalesOrderLineAdded` | 확정 뒤 추가. `line:{...위와 같은 줄}, warehouse_id, partner_id, number` |
| `SalesOrderLineQtyChanged` | 확정 뒤 수량 변경. `line_id, variant_id, product_id, from, to, uom_id, name, type, warehouse_id, partner_id, number` |
| `SalesOrderCancelled` | `number, partner_id, was, reason` |
| `SalesOrderDelivered` | 납품 수량이 바뀔 때. `lines:[{line_id, qty_delivered}]`. `manual: true` 는 사람이 적은 납품이고, 이때 줄에 `qty, uom_id, variant_id, product_id, name, type` 도 싣는다 |

`warehouse_id` 는 재고 모듈이 꺼져 있으면 `null` 이고, 그때는 기본 창고를 쓴다. `region` 은 납품처의 지역이고 없으면 거래처의 지역이다.

## 구매가 내는 것

| 이벤트 | `data` 의 사실 |
|---|---|
| `PurchaseOrderConfirmed` | `number, partner_id, partner_name, warehouse_id, date_order, date_planned, currency, amount_untaxed, amount_tax, amount_total, lines:[{line_id, product_id, variant_id, name, qty, uom_id, unit_price, discount, subtotal, type, bill_policy, date_planned, delay_days}]` |
| `PurchaseOrderLineAdded` | `line:{...}, warehouse_id, partner_id, number, date_order` |
| `PurchaseOrderLineQtyChanged` | `line_id, variant_id, product_id, from, to, uom_id, name, type, unit_price, discount, warehouse_id, partner_id, number` |
| `PurchaseOrderLinePriceChanged` | 입고 전 가격 변경. 입고 원가에 반영된다 |
| `PurchaseDraftQtyChanged` | 초안 수량. 재고 예측에 들어가고 보충 요청에 답한다 |
| `PurchaseOrderCancelled` | `number, partner_id` |

## 재고가 내는 것

| 이벤트 | `data` 의 사실 |
|---|---|
| `PickingStateChanged` | 전표 상태가 바뀔 때마다. `number, picking_type, origin_type, origin_id, state, is_return, partner_id, scheduled_date, lines:[{origin_line_id, variant_id, demand, done}]` |
| `PickingValidated` | `number, picking_type, origin_type, origin_id, is_return, to_refund, partner_id, warehouse_id, date_done, moves:[{move_id, origin_line_id, product_id, variant_id, name, qty_done, uom_id, location_from, location_to, lot_id, unit_cost, cost_method}]` |
| `StockAdjusted` | `variant_id, product_id, location_id, warehouse_id, lot_id, delta, unit_cost, counted_qty, accounting_date` |
| `StockScrapped` | `variant_id, product_id, location_id, warehouse_id, lot_id, qty, unit_cost` |
| `ReorderRequested` | 요청별 문서 스트림(되돌릴 때 같은 제품의 다른 요청이 끌려오지 않게). `rule_id, variant_id, product_id, location_id, warehouse_id, qty, uom_id, vendor_id, origin` |

재고 수량 변화는 전부 `data.effects.quant = [{variant_id, location_id, lot_id, qty, reserved}]` 에 실린다. 분석은 이것을 읽는다.

## 청구가 내는 것

줄 공통: `lines:[{line_id, origin_line_id, product_id, variant_id, name, qty, uom_id, price_unit, discount, subtotal, tax_amount, total, taxes:[{tax_id, name, amount, base, account_id}], is_downpayment, downpayment_line_id, account_id}]`

| 이벤트 | `data` 의 사실 |
|---|---|
| `InvoiceDrafted` | 초안이 생기거나 바뀔 때. `move_type, origin_type, origin_id, partner_id, reversal_of, lines` |
| `InvoicePosted` | `move_type, number, origin_type, origin_id, partner_id, partner_name, region, date, invoice_date, due_date, installments, currency, fiscal_position_id, journal_id, journal_account_id, amount_untaxed, amount_tax, amount_total, reversal_of, lines` |
| `InvoiceResetToDraft` | `move_type, number, origin_type, origin_id, partner_id, lines` |
| `InvoiceCancelled` | 초안 또는 게시 취소. `move_type, number, origin_type, origin_id, partner_id, lines` |
| `PaymentPosted` | `payment_type, partner_type, number, partner_id, amount, date, journal, journal_id, journal_account_id, payment_method_id, allocations:[{move_id, amount}], unallocated, writeoff_amount, writeoff_account_id, writeoff_label, early_discount, writeoff_taxes` |
| `PaymentCancelled` | `payment_type, partner_type, number, partner_id, amount, date, journal, allocations` |
| `InvoicePaymentApplied` | 청구서 스트림. `payment_id, credit_move_id, amount, residual, payment_state, partner_id, due_date, date`. 맞물림을 풀면 같은 이벤트가 음수 `amount` 로 나간다 |
| `BankLineBooked` | 은행 거래 스트림. 문서 없이 계정으로 처리한 돈. `date, amount, account_id, journal_account_id, journal_id, partner_id, name`. `amount` 는 들어온 돈이 양수다 |
| `BankLineUnbooked` | 그 처리를 풀었을 때. `date, journal_id` |

세금 분배가 있는 세금은 줄의 `taxes[]` 에 `gross, repartition:[{account_id, amount, grids, factor_percent}], base_grids` 를 더 싣는다. `amount` 는 줄에 남는 세액이다(역과세면 0). `account_id` 가 비면 그 몫은 줄의 계정으로 간다. `InvoicePosted` 의 대변 메모는 대변 메모 분배로 나간다.

청구는 초안일 때부터 `qty` 를 알린다. 판매와 구매의 `qty_invoiced`·`qty_billed` 는 초안 시점에 움직인다.

### 선금

청구가 `method: percentage|fixed` 로 만든 선금 청구서는 `InvoiceDrafted` 줄에 `is_downpayment: true`, `origin_line_id: null` 을 싣고 `line_id` 를 고정한다. 판매는 이 줄을 받아 주문에 `is_downpayment` 줄을 하나 더하되, `invoice_line_id` 로 중복을 막는다. 일반 청구서를 만들 때 청구는 `erp.peek` 로 주문의 선금 줄을 읽어 음수 줄(`origin_line_id` = 주문의 선금 줄)로 차감한다.

## 회계가 내는 것

| 이벤트 | `data` 의 사실 |
|---|---|
| `JournalEntryPosted` | 전표 스트림. 효과 `gl = [{account_id, partner_id, date, debit, credit}]`. 분석의 기간은 `occurred_at` 이 아니라 효과의 `date` 로 거른다(회계를 늦게 켜면 전표 시각은 다시 만든 시점이다) |

## 기초데이터가 내는 것

| 이벤트 | `data` 의 사실 |
|---|---|
| `PartnerMerged` | `into`(대상 거래처) |
| `ProductCostChanged` | `variant_id, product_id, from, to, reason`. 재고 모듈이 기초데이터 명령으로 일으킨다 |

## 구독 관계

발행자는 이 표를 모른다. 어느 칸이 비어도 동작해야 한다.

| 구독자 | 듣는 이벤트 | 하는 일 |
|---|---|---|
| 재고 | `SalesOrderConfirmed`, `SalesOrderLineAdded`, `SalesOrderLineQtyChanged`, `SalesOrderCancelled`, `SalesOrderDelivered`(`manual` 만) | 출고 전표. 손으로 납품한 만큼 열린 전표가 줄고, 남은 것이 없으면 취소된다 |
| 재고 | `PurchaseOrderConfirmed`, `PurchaseOrderLineAdded`, `PurchaseOrderLineQtyChanged`, `PurchaseOrderLinePriceChanged`, `PurchaseOrderCancelled`, `PurchaseDraftQtyChanged` | 입고 전표, 예측 |
| 판매 | `PickingStateChanged`, `PickingValidated` | 납품 상태, `qty_delivered` |
| 판매 | `InvoiceDrafted`, `InvoicePosted`, `InvoiceResetToDraft`, `InvoiceCancelled` | 청구 상태, `qty_invoiced` |
| 판매 | `ModuleEnabled` | 재고·청구가 켜진 시점을 기록해 그 뒤의 주문만 추적 대상으로 본다 |
| 구매 | `ReorderRequested` | 견적 요청 초안 |
| 구매 | `PickingStateChanged`, `PickingValidated` | 입고 상태, `qty_received` |
| 구매 | `InvoiceDrafted`, `InvoicePosted`, `InvoiceResetToDraft`, `InvoiceCancelled` | 청구 상태, `qty_billed` |
| 회계 | `InvoicePosted`, `InvoiceResetToDraft`, `InvoiceCancelled`, `PaymentPosted`, `PaymentCancelled`, `BankLineBooked`, `BankLineUnbooked` | 분개(처음부터 다시 읽는다) |
| 회계 | `PickingValidated`, `StockAdjusted`, `StockScrapped` | 재고 평가 분개(처음부터 다시 읽는다) |
| 분석 | 원장 전체 | 구독하지 않고 직접 읽는다 |

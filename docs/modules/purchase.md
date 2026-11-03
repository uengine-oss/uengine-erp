# 구매 (`sql/50_purchase.sql`)

모듈 `purchase`(sort 30). 재고가 꺼져 있어도 동작한다(입고 수량을 직접 입력). 재고와 청구는 이벤트로만 안다.

`purchase_order`: `number(P00001), partner_id, vendor_ref, date_order, date_planned, date_confirmed, date_received, payment_term_id, fiscal_position_id, buyer_id, warehouse_id, origin, note, ask_confirmation, confirmed_by_vendor_at, currency, state(draft/sent/to_approve/purchase/cancelled), locked, receipt_status(no/pending/partial/full), billing_status(no/to_bill/billed), amount_untaxed, amount_tax, amount_total, lines[{id, sequence, display_type, product_id, variant_id, name, qty, uom_id, price_unit, discount, tax_ids, taxes, subtotal, tax_amount, total, date_planned, delay_days, vendor_code, price_manual, type, bill_policy, qty_received, manual_received, qty_billed, qty_to_bill}]`

`date_order` 는 주문 마감일이고 확정해도 바뀌지 않는다. 확정 시각은 `date_confirmed`. 헤더 `date_planned` 는 줄 중 가장 이른 날이다. 읽기 권한은 `purchase`, `accounting`, 관리자다.

## 명령

| 명령 | 뜻 |
|---|---|
| `create` | 초안. 결제 조건·세금 조정은 공급사에서, 담당자는 요청자에서 채운다 |
| `update` | 머리글과 줄. 줄은 차이를 계산해 줄 이벤트로 남긴다 |
| `send` | 초안 → 보냄. 메일은 보내지 않는다 |
| `confirm` | 초안·보냄 → 구매 주문 또는 승인 대기 |
| `approve` | 승인 대기 → 구매 주문. 관리자가 아니면 아무 일도 없다(오류 없음) |
| `cancel` | 입고가 끝난 전표가 있으면 `ERP_RECEIVED`, 게시된 청구서가 있으면 `ERP_BILLED`, 잠겼으면 `ERP_LOCKED`. 초안 청구서는 막지 않는다 |
| `set_draft` | 취소 → 초안. 다시 확정하면 새 입고 전표가 생긴다 |
| `lock`, `unlock` | 확정 주문만. `state` 는 그대로다 |
| `receive{lines:[{id, qty_received}]}` | 입고 수량 직접 입력 |
| `vendor_confirm{at}` | 공급사 확인 일시 기록 |
| `delete` | 취소된 주문만 |

- **2단계 승인.** 회사 설정 `po_double_validation`(`one_step`/`two_step`), `po_approval_limit`. 세금 포함 합계가 한도 이상이고 관리자가 아니면 승인 대기다. 승인 전에는 `PurchaseOrderConfirmed` 가 없으므로 입고 전표도 없다.
- **확정 뒤 줄.** 지울 수 없다(수량 0 으로). 제품을 바꿀 수 없다. 입고량 아래로 줄이면 `ERP_BELOW_RECEIVED`. 같게 줄이면 남은 입고가 취소된다. 가격과 새 줄은 된다.
- **잠금.** 줄 변경과 취소를 막고 `note`, `vendor_ref` 만 받는다.
- **입고 수량.** 입고 전표가 있는 재화 줄은 전표에서 정해지고 직접 입력을 거부한다. 서비스 줄과 전표가 없는 재화 줄은 직접 입력한다. 어느 모듈이 켜져 있는지 묻지 않고 전표 소식을 들었는지로 판단한다.

## 단가와 납기

`erp.purchase_price(partner, variant_doc, qty, uom, date)`.

- 그 공급사의 줄 중 기간이 맞고 최소 수량이 맞는 것에서 최소 수량이 가장 큰 줄, 같으면 낮은 가격. 줄 순서는 영향이 없다. 할인과 공급사 제품 코드도 그 줄에서 온다.
- 맞는 줄이 없으면 단가는 제품 원가이고, 납기는 기간이 맞는 그 공급사 줄의 값이다(최소 수량 미달이어도). 공급사 줄이 없으면 0.
- 공급사 단가와 최소 수량은 구매 단위 기준이다. 줄 기본 단위도 구매 단위이고, 분류가 다른 단위는 `ERP_UOM`.
- 입고 예정일 = `date_order` + 납기.
- 자동 단가는 수량을 따라 바뀐다. 직접 넣은 단가(`price_manual`)는 다시 바꿀 때까지 유지된다.
- 확정할 때 그 제품의 공급사 목록에 없는 공급사면 `{price, min_qty: 1, delay_days: 0, discount}` 로 더한다(가격은 구매 단위로 환산). 있는 공급사는 그대로 둔다.

## 상태

- `receipt_status`: 전표 상태로 정한다. 전표 없음·전부 취소 → `no`, 완료 없음 → `pending`, 일부 완료 → `partial`, 취소를 뺀 전부 완료 → `full`. 그래서 백오더 없이 일부만 받아도 `full` 이고, 열린 반품이 있으면 `partial` 이다. 전표 소식을 들은 적이 없으면 직접 입력한 수량으로 정한다.
- `qty_received`: `PickingValidated` 의 합. 반품은 `to_refund` 면 빼고, 아니면 그대로다. 전표 단위로 기억하므로 두 번 받아도 한 번이다.
- `qty_billed`: 청구서 이벤트의 합이고 초안부터 센다(`InvoiceDrafted`). `in_refund` 는 뺀다. `InvoiceCancelled` 는 뺀다. 청구서 단위로 기억하므로 초안을 고치면 값이 바뀐다.
- 청구 대상 `qty_to_bill`: 확정 주문에서 `bill_policy=order` 면 `qty - qty_billed`, `receipt` 면 `qty_received - qty_billed`. 음수도 그대로 둔다.
- `billing_status`: 확정 주문에서 대상이 0 이 아닌 줄이 있으면 `to_bill`, 없고 청구서가 있으면 `billed`, 나머지 `no`.

## 이벤트

| 이벤트 | 뜻 |
|---|---|
| `RfqCreated`, `RfqUpdated`, `RfqLineAdded/Changed/Removed`, `RfqAmountsChanged`, `RfqSent`, `RfqResetToDraft`, `RfqReorderLinked` | 초안 |
| `PurchaseOrderApprovalRequested` | 승인 대기 |
| `PurchaseOrderConfirmed`, `PurchaseOrderLineAdded`, `PurchaseOrderLineQtyChanged`, `PurchaseOrderLinePriceChanged`, `PurchaseOrderCancelled` | 계약(`events.md`) |
| `PurchaseDraftQtyChanged` | 초안·보냄·승인 대기의 재화 수량이 바뀔 때. `lines:[{line_id, variant_id, product_id, qty, uom_id}]`(기준 단위), `requests`(이번에 받은 보충 요청) |
| `PurchaseOrderReceived`, `PurchaseOrderReceiptStatusChanged`, `PurchaseOrderBilled` | 재고·청구 소식을 반영함 |
| `PurchaseOrderLineChanged`, `PurchaseOrderAmountsChanged`, `PurchaseOrderUpdated`, `PurchaseOrderLocked/Unlocked`, `PurchaseOrderVendorConfirmed`, `PurchaseOrderDeleted` | 그 밖 |

## 구독

| 구독 | 이벤트 | 하는 일 |
|---|---|---|
| `purchase.reorder` | `ReorderRequested` | 그 공급사·창고의 **요청으로 만든 초안**에 줄을 더한다. 같은 변형·단위 줄은 수량이 는다. 없으면 새 초안(`auto_created`). 사람이 만든 초안과 보낸 문서에는 넣지 않는다. 요청 ID 를 기억해 두 번 받아도 한 번이다 |
| `purchase.receipts` | `PickingStateChanged`, `PickingValidated` | 입고 상태, `qty_received` |
| `purchase.bills` | `InvoiceDrafted`, `InvoicePosted`, `InvoiceResetToDraft`, `InvoiceCancelled` | 청구 상태, `qty_billed` |

`origin_type` 이 `purchase_order` 가 아니거나 문서가 없으면 무시한다.

## 조회

- 뷰 `public.erp_purchase_report`: 줄 단위 분석. 수량·금액·평균 단가·확정 소요일·입고 소요일·무게·부피·지연.
- `public.erp_purchase_dashboard()`: 보낼 것, 답 대기, 승인 대기, 지연(전체와 내 것), 최근 7일 금액·납기·발송 수.
- `public.erp_vendor_catalog(partner_id)`: 그 공급사에서 살 수 있는 제품과 조건.
- `erp.preview_purchase_order(payload)`: 저장 없이 금액 계산.

## 보고

- `erp_purchase_analysis(from, to, group_by[], filters{kind(all/rfq/po), date_field(date_order/date_confirmed), partner_id, product_id, category_id, buyer_id}, compare(previous_period/previous_year))`: `rows[{<묶음>, lines, orders, qty, qty_received, qty_billed, subtotal, total, avg_cost, days_to_confirm, days_to_receive, weight, volume, previous?, change_percent?}]`. 묶음은 `partner_id, product_id, variant_id, category_id, state, buyer_id, month, quarter, year`.
- `erp_vendor_cost_report(from, to, partner_id)`: 확정 주문의 공급사·제품·월별 평균 원가.
- `erp_purchase_spend(from, to, by(partner/category))`: 확정 주문의 지출.
- `erp_vendor_prices(partner_id)`: 공급사 가격표를 줄로. 줄의 `id` 는 `erp_import('vendor_price', ...)` 로 돌아올 때의 외부 ID 다.

승인은 관리자만 한다. 구매 역할이 부르면 `ERP_FORBIDDEN` 이다. 관찰은 조용히 아무 일도 하지 않는데, 그러면 화면이 "승인 완료" 라고 말하고 주문은 그대로다(`docs/plan.md` 결정 13). 이미 보낸 견적 요청의 `send` 는 아무 일도 하지 않는다.

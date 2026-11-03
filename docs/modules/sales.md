# 판매 (`sql/30_sales.sql`)

판매는 혼자서 완전히 동작한다. 재고와 청구는 이벤트로만 만난다(`docs/modules/events.md`). 납품 상태는 전표 이벤트에서만, 청구 수량은 청구서 이벤트에서만 움직인다. 재고·청구 모듈이 없으면 두 상태는 `no`(해당 없음)로 남는다.

`quote_template`: `name, validity_days, note, require_signature, require_payment, prepayment_percent, lines[{id, display_type, product_id, variant_id, name, qty, uom_id}], optional_lines[{id, product_id, variant_id, name, qty, uom_id}]`

`sales_order`: `number, partner_id, invoice_partner_id, delivery_partner_id, pricelist_id, payment_term_id, fiscal_position_id, template_id, date_order, validity_date, commitment_date, expected_date, salesperson_id, team, client_ref, tags, note, origin, campaign, medium, source, shipping_policy(direct/one), shipping_weight, incoterm, incoterm_location, warehouse_id, require_signature, require_payment, prepayment_percent, portal_token, signed_by, signed_at, signature, declined_reason, state(draft/sent/sale/cancelled), locked, invoice_status(no/to_invoice/invoiced/upselling), delivery_status(no/pending/started/partial/full), amount_untaxed, margin, margin_percent, amount_invoiced, amount_to_invoice, amount_tax, amount_total, lines[{id, sequence, display_type, product_id, variant_id, value_ids, name, qty, uom_id, price_unit, discount, tax_ids, subtotal, tax_amount, total, cost, margin, margin_percent, lead_days, weight, qty_delivered, delivery_tracked, qty_invoiced, qty_to_invoice, invoice_status, invoice_policy, product_type, price_manual, linked_line_id, combo_item_id, is_downpayment, invoice_line_id, invoice_id, invoice_state, dp_date, from_portal}], optional_lines[{id, product_id, variant_id, value_ids, name, qty, uom_id, price_unit, discount, added}], pickings, invoices`

- 번호는 `S00001` 형식이고 견적을 만들 때 정해진다.
- `warehouse_id, shipping_policy, shipping_weight, delivery_status, pickings` 와 줄의 `weight` 는 카탈로그에서 `inventory` 모듈 소속이다. `invoice_status, amount_invoiced, amount_to_invoice, invoices` 와 줄의 `qty_invoiced, qty_to_invoice, invoice_status, invoice_policy` 는 `invoicing` 모듈 소속이다. 모듈이 꺼지면 화면에서 숨고, 입력하면 `ERP_MODULE_OFF` 로 거부된다.
- `pickings[{id, number, picking_type, is_return, state, scheduled_date, date_done, counted}]`, `invoices[{id, number, move_type, state, date, reversal_of, amount_total, lines[{line_id, origin_line_id, qty, uom_id, price_unit, is_downpayment, downpayment_line_id}]}]`: 들은 이벤트를 주문 안에 적어 둔 것이다. 연결 문서로 가는 길이기도 하다.

명령: `create update send confirm cancel set_draft lock unlock delete`, 추가 `update_prices update_taxes add_optional{option_id, qty} apply_discount{type, value}`. 복제는 `create{copy_of}` 다.

| 이벤트 | `data` 의 사실 |
|---|---|
| `QuotationCreated` | `set` + 줄 `col` + `number, partner_id, amount_untaxed, amount_tax, amount_total, template_id, copy_of` |
| `QuotationUpdated`, `SalesOrderUpdated` | 머리글 `set` |
| `QuotationLineAdded/Changed/Removed`, `QuotationLinesReordered` | 줄 `col`, 합계 `set`, `before` 또는 `removed` |
| `QuotationOptionTaken` | `option_id, from_portal` |
| `QuotationSent` | `via, portal_token` |
| `QuotationSigned` | `signed_by, signed_at` |
| `QuotationDeclined` | `number, partner_id, reason` |
| `QuotationResetToDraft`, `QuotationDeleted` | |
| `SalesOrderConfirmed`, `SalesOrderLineAdded`, `SalesOrderLineQtyChanged`, `SalesOrderCancelled` | `events.md` 의 계약. `SalesOrderCancelled` 는 `was, reason` 도 싣는다. 줄에는 콤보를 위해 `linked_line_id, combo_item_id` 가 더 있다 |
| `SalesOrderLineChanged` | 확정 뒤 수량 말고 바뀐 줄(가격, 할인, 설명, 세금) |
| `SalesOrderSectionAdded/Removed`, `SalesOrderLinesReordered` | 확정 뒤 구역·메모 줄 |
| `SalesOrderLocked`, `SalesOrderUnlocked` | |
| `SalesOrderDelivered` | 줄별 `qty_delivered`, `delivery_status`. 사람이 입력했으면 `manual` |
| `SalesOrderDeliveryStatusChanged` | 수량 변화 없는 전표 상태 변화 |
| `SalesOrderInvoiced` | 줄별 `qty_invoiced`, `invoice_status`, `invoice_id` |
| `SalesOrderInvoiceStatusChanged` | 청구 모듈을 켜서 상태가 뜻을 갖게 된 때 |

## 견적

- 고객은 필수다. 고객을 고르면 그 소속 회사(최상위 연락처)의 가격표·결제 조건·세금 조정·담당 영업이 온다. 가격표가 없으면 `기본 가격표`, 세금 조정이 없으면 납품처 국가의 `auto_apply` 조정, 담당 영업이 없으면 작성자다. 청구지·배송지는 그 연락처, 하위 연락처, 상위 연락처 순으로 해당 유형의 주소를 찾고 없으면 그 연락처 자신이다. 견적의 고객을 바꾸면 이 값들이 함께 바뀐다.
- `validity_date` 기본값은 오늘 + 회사의 `quotation_validity_days`(없으면 30), 양식이 있으면 양식의 `validity_days` 다. 0 이면 기한이 없다. 호출자가 준 값이 언제나 먼저다.
- 만료는 오늘에 달렸으므로 저장하지 않는다. 화면은 `public.erp_sales_expired(ids)` 와 미리보기의 `is_expired`, 포털의 `is_expired` 로 묻는다. 만료된 견적도 사람이 확정할 수 있고, 줄 없는 견적도 확정된다. 제품 없는 설명 줄은 견적에는 쓸 수 있고 확정이 거부된다. `sale_ok` 가 꺼진 제품도 줄에 넣을 수 있다.
- `require_signature` 기본 켜짐, `require_payment` 기본 꺼짐, `prepayment_percent` 기본 100(%).
- `erp.preview_sales_order(payload)` 는 저장 없이 같은 계산을 돌려준다. `id` 를 주면 그 주문 위에서 계산한다. 결과에 `is_expired`, `suggested_options`(줄 제품의 `optional_product_ids` 중 아직 없는 것)가 더 있다. 아직 아무도 주문하지 않은 동적 조합은 만들지 않는다.
- 양식은 호출자가 비운 것만 채운다. 견적에서 양식을 새로 고르면 줄과 선택 제품을 양식 것으로 바꾼다.
- 복제: `create{copy_of}` 는 줄(수량·단가·할인·세금)과 선택 제품, 메모를 가진 새 견적이다. 선금 줄, 납품·청구 수량, 서명, `client_ref` 는 옮기지 않고 날짜와 번호는 새로 정한다.

## 줄

- 줄은 `variant_id` 를 쓴다. `product_id` 만 주면 그 제품의 유일한 변형, 또는 `value_ids` 가 가리키는 조합이다(`dynamic` 은 이때 변형이 생긴다). `no_variant` 값은 추가 금액이 정가에 더해지고 설명 끝에 붙는다.
- 단가는 가격표에서 온다. 입력한 단가는 소수 자릿수까지 그대로 저장하고(`price_manual`), 수량이 바뀌어도 유지된다. 할인은 수량이 바뀌면 규칙 값으로 돌아온다. 입력하지 않은 단가는 수량을 따라 다시 계산한다. 이미 청구된 줄의 단가는 수량이 바뀌어도 그대로다. 제품이나 단위를 바꾸면 입력한 단가도 잊고 처음부터 계산한다.
- 수량은 단위의 반올림으로, 할인은 소수 2자리로 저장한다. 할인은 100 을 넘거나 음수여도 된다. 수량도 음수가 될 수 있다. 수량은 입력한 값을 소수 둘째 자리(그 단위의 반올림이 더 작으면 그 자리)까지 그대로 둔다. 단위의 반올림은 재고 이동에서만 쓴다. 다른 분류의 단위는 견적에는 넣을 수 있고(가격 환산 없음) 확정할 때 `ERP_UOM` 으로 거부한다. 확정된 주문의 줄은 바로 재고로 가므로 저장할 때 거부한다.
- 세금은 제품의 `sale_tax_ids` 를 세금 조정으로 바꾼 것이고, 전부 포함 세금이면 단가도 조정된다. 호출자가 `tax_ids` 를 주면 그대로 쓴다. 가격표나 세금 조정을 바꿔도 줄은 그대로이고 `update_prices`, `update_taxes` 를 불러야 바뀐다. `update_taxes` 는 단가를 건드리지 않는다.
- `update_prices` 는 주문일 기준으로 다시 계산하고 입력한 단가를 잊는다. 이미 청구된 줄은 단가를 유지하고 할인만 규칙 값으로 돌린다. 할인 줄도 그 제품(정가 0)의 값으로 돌아간다.
- 원가는 줄을 만들 때 변형 원가를 줄 단위로 바꿔 고정한다. 마진 = 공급가 - 원가 × 수량, `margin_percent` 는 공급가 대비 비율이다.
- `expected_date` 는 주문일 + 납기 일수로, `direct` 면 가장 빠른 줄, `one` 이면 가장 늦은 줄이다. `shipping_weight` 는 줄 무게의 합이다.
- 콤보: 줄에 `combo_items:[항목 id]` 를 주면 콤보 줄(단가 0, 세금 없음)과 고른 항목 줄(`linked_line_id, combo_item_id`, 자기 세금)이 함께 생긴다. 항목 단가는 `erp.combo_item_price`, 할인은 콤보 제품의 규칙이다. 콤보 줄을 지우면 항목이 함께 지워지고, 항목은 따로 수량을 주지 않으면 콤보 줄의 수량을 따른다. 재고는 항목 줄만 본다. 콤보 줄은 주문 청구 상태 계산에서 빠진다.

## 일괄 할인

`apply_discount{type, value}`. 값 0 이나 줄 없는 주문은 아무 일도 하지 않는다. 확정 뒤에도 되고, 잠긴 주문도 된다.

- `line`: 모든 줄의 `discount` 를 value(%)로 바꾼다. 100 초과는 거부, 음수는 인상이다.
- `order`: 세금 조합마다 음수 줄 하나를 더한다. 금액은 그 조합의 공급가 합 × value(%)다.
- `amount`: value 만큼 세금 포함 합계를 줄인다. 조합마다 세금 포함 합계 비율로 나눠 음수 줄을 더한다. 음수 줄의 단가는 공급가 기준이다.

음수 줄은 서비스 제품 `erp.seed_id('판매 할인')` 을 쓰고, 처음 쓸 때 만들어진다. 주문이 나중에 바뀌어도 음수 줄은 그대로다.

## 확정과 그 뒤

- 확정하면 `date_order` 가 지금으로 바뀌고 `lock_confirmed_sales` 면 잠긴다. 이 날짜가 뒤의 가격 계산 기준이다. 취소 → 견적 → 재확정이 되고, 그때 다시 `SalesOrderConfirmed` 가 나간다.
- `send` 는 견적 상태에서만, 토큰은 처음 보낼 때 정해진다. `set_draft` 는 취소·보낸 견적에서만이고 서명을 지운다. `lock` 은 확정 주문만, `delete` 는 견적과 취소된 주문만 된다. 취소된 주문은 고칠 수 없다.
- 확정 주문: 제품과 단위를 못 바꾼다. 줄을 못 지운다(수량 0 으로). 구역·메모 줄은 지울 수 있다. 재화 줄은 납품량 아래로 줄일 수 없다(같게는 된다). 서비스는 된다. 고객·가격표·창고·양식·주문일은 못 바꾼다. 줄 추가는 된다. 선택 제품은 못 더한다.
- 잠긴 주문: 수량·단가·설명·세금 변경과 취소가 `ERP_LOCKED` 다. 할인, 메모, 새 줄은 된다.
- 납품 수량: 전표나 이동이 한 번이라도 언급한 줄(`delivery_tracked`)은 사람이 못 고친다. 그 전까지는 재화든 서비스든 직접 입력할 수 있고, 전표가 오면 입력한 값에 더해진다.

## 상태

`delivery_status` 는 수량이 아니라 전표 상태로 정한다. 취소를 뺀 전표가 없으면 `no`, 전부 완료면 `full`(백오더 없이 3/10 만 출고해도), 출고 전표가 완료되었으면 `partial`(열린 반품도 여기 든다), 앞 단계만 완료면 `started`, 나머지는 `pending`.

줄 청구: `order` 는 `qty - qty_invoiced`, `delivery` 는 `qty_delivered - qty_invoiced`. 확정 주문이 아니면 0 이다. 줄 상태는 대상이 0 이 아니면 `to_invoice`(음수 포함), 주문 수량 기준이고 초과 납품이면 `upselling`, 주문량까지 청구됐으면 `invoiced`, 나머지 `no`.

주문 상태: `to_invoice` 줄이 있으면 `to_invoice`, 전부 `invoiced` 면 `invoiced`, `upselling` 이 있고 나머지가 `invoiced` 면 `upselling`, 나머지는 `no`(일부만 청구된 혼합 주문 포함). 구역 줄, 선금 줄, 콤보 줄은 세지 않는다.

청구 수량은 **초안부터** 센다. 청구서 이벤트마다 그 청구서의 줄을 `invoices` 에 적고 주문 전체를 다시 계산한다: 취소가 아닌 청구서의 `origin_line_id` 줄을 더하고 대변 메모는 뺀다. 그래서 같은 이벤트가 두 번 와도 같고 순서에도 흔들리지 않는다. 납품 수량은 더해 가는 값이라 이벤트 번호를 `counted` 에 적어 중복을 막는다. 금액 `amount_invoiced` 는 게시된 것만 센다.

## 선금

선금 청구서의 줄(`is_downpayment`, `origin_line_id: null`, 수량 양수)이 들어오면 주문에 `선금` 구역 하나와 선금 줄을 더한다. 선금 줄의 `id` 는 청구서 줄의 `line_id` 와 같고 `invoice_line_id` 에도 적는다. 수량은 0 이라 합계를 바꾸지 않는다.

| 청구서 상태 | `price_unit` | `qty_invoiced` | `qty_to_invoice` | 줄 상태 |
|---|---|---|---|---|
| 초안 | 청구서 단가 | 1 | -1 | `invoiced` |
| 게시 | 청구서 단가 | 1 | -1 | `to_invoice` |
| 취소 | 0 | 0 | 0 | `invoiced`, 이후 새 선금은 새 줄 |
| 최종 청구서가 차감(수량 음수 줄) | 그대로 | 0 | 0 | `invoiced` |
| 대변 메모 초안 | 그대로 | 0 | 0 | `invoiced` |
| 대변 메모 게시, 일부 | 남은 금액 | 1 | -1 | `to_invoice` |
| 대변 메모 게시, 전액 | 0 | 0 | 0 | `invoiced` |

차감 줄과 대변 메모 줄은 `origin_line_id` 가 선금 줄 `id` 이거나 `downpayment_line_id` 가 청구서 줄 `line_id` 인 것으로 찾고, 대변 메모는 `reversal_of` 로도 찾는다.

## 나중에 켜기

청구 상태는 그 필드가 켜져 있을 때만 뜻을 갖는다. 판매는 카탈로그에서 필드의 소속을 읽을 뿐 모듈 이름을 부르지 않는다. 꺼져 있어도 줄의 `qty_to_invoice` 는 늘 계산해 둔다. 소속 모듈을 켜면 `ModuleEnabled` 를 듣고 확정 주문의 상태를 다시 계산한다. 그 모듈의 옵션 `orders_since` 가 있으면 그 날짜 이후의 주문만 본다.

구독은 처음부터 다시 읽는다(`replay`). 판매를 나중에 켜도 없는 주문의 이벤트는 무시한다.

## 고객 포털

`public.erp_portal_get(token)`, `public.erp_portal_sign(token, name, signature)`, `public.erp_portal_decline(token, reason)`, `public.erp_portal_add_option(token, option_id, qty)`. 익명 호출 가능, 토큰으로만 그 견적 하나를 본다. 원가·마진·담당자·토큰 같은 내부 값은 돌려주지 않는다.

- 서명하면 `QuotationSigned` → 온라인 결제를 요구하지 않은 견적은 자동 확정된다. 결제를 요구하면 서명만 남고 담당자를 기다린다(결제사가 필요하다). 만료된 견적은 `ERP_EXPIRED`, 서명을 요구하지 않는 견적은 `ERP_INVALID`. 서명 이미지는 200,000자까지다.
- 거절하면 `QuotationDeclined` 로 취소된다.
- 선택 제품을 담으면 줄이 생기고 `from_portal` 로 표시되며 `QuotationOptionTaken` 이 남는다.
- 이벤트의 `source` 는 `portal`, `actor_name` 은 서명한 이름이다.

납품이 끝났고(`delivery_status: full`) 납품분을 다 청구한 줄은 주문 수량에 못 미쳐도 `invoiced` 다. 납품이 아직 남았으면(`partial`) `no` 이고, 납품 없이 끝난 줄은 `no` 다.

회사 설정 `default_quote_template_id` 는 줄 없이 만든 견적에 양식을 채운다. 미리보기의 `warnings` 는 납품 희망일이 예상 납품일보다 빠르면 알려 준다. 저장은 막지 않는다.

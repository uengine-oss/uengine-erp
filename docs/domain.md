# uEngine ERP 도메인 계약

모듈은 이 문서의 이벤트·애그리거트·필드 이름을 공통 언어로 쓴다. 바꾸려면 이 문서를 먼저 고친다.

## 1. 구조 원칙

- 서버가 없다. 브라우저(Vue 3, GitHub Pages)와 사용자 소유 Supabase 프로젝트뿐이다.
- 업무 규칙은 전부 Postgres PL/pgSQL 안에 있다. 브라우저 코드는 믿을 수 없기 때문이다. plv8 은 쓰지 않는다(Postgres 17 에서 지원 종료 예정).
- 쓰기는 `public.erp_command(type, id, command, payload, expected_version, reason, source, correlation_id)` 하나로만 한다. 조회는 `public.erp_records`, `public.erp_events` 뷰와 `public.erp_*` 함수로 한다.
- 비공개 스키마는 `erp`, 공개 API 는 `public.erp_*` 이다. 접근 권한은 `sql/99_grants.sql` 이 한곳에서 닫는다.
- Supabase API 문장 제한은 8초다. 오래 걸리는 작업은 묶음으로 나눠 호출하게 만든다.

### 커널 약속 (`sql/00_core.sql`)

| 함수 | 뜻 |
|---|---|
| `erp.emit(type, id, event, data)` | 유일한 쓰기. 이벤트 추가 → `records` 갱신 → `project` 훅 → `react` 훅 |
| `erp.apply(state, data)` | 유일한 리듀서. `set`·`unset`·`col{name:{add,set,del}}` 만 상태를 바꾼다. 그 밖의 `data` 키는 분석용 사실 |
| `erp.fold(id, at)` | 재생. 시점 조회와 무결성 검증이 같은 리듀서를 쓴다 |
| `erp.register_hook('project'\|'react', stream_type, fn)` | `fn(ev erp.events, before jsonb, after jsonb)`. 다른 모듈의 스트림에도 걸 수 있다 |
| `erp.h_<type>(id, command, payload) returns uuid` | 있으면 그 유형의 명령 처리기. 없으면 `erp.h_generic` |
| `erp.preview_<type>(payload) returns jsonb` | 저장 없이 계산만 한다(화면용 금액 계산) |
| `erp.catalog_put(doc)` | 메타데이터 등록. 화면과 MCP 가 이것으로 동작한다 |
| `erp.now()`, `erp.today()` | 업무 시각. `now()`·`current_date` 를 쓰지 말 것(과거 이력 시드가 불가능해진다) |
| `erp.money(n)` | 회사 통화 자릿수로 반올림(half away from zero). `erp.num(jsonb, default)` |
| `erp.next_number(code, format, pad)` | 트랜잭션 안에서 빈 번호 없는 채번 |
| `erp.fail(code, message)` | 오류. 형식 `ERP_코드: 한국어 문구` |
| `erp.require_state(id, type)` | 상태를 읽고 없으면 `ERP_NOT_FOUND` |

규칙:
- **동시성.** `erp.dispatch` 가 처리기 호출 전에 그 애그리거트 행을 잠근다. 처리기는 잠금 뒤 상태를 읽고 규칙을 확인하고 emit 한다. 다른 애그리거트나 파생 표의 값으로 판단할 때(재고 예약 등)는 그 행도 잠근다: `select ... for update` 또는 `update ... where qty - reserved >= n` 후 행 수 확인. 처리기와 판단 함수는 `stable` 로 선언하지 않는다(안정 함수는 호출 시점 스냅샷을 써서 잠금 뒤 최신 값을 못 본다). `erp.require_state` 처럼 읽기만 하는 도우미는 예외다.
- **읽기 권한.** 카탈로그에 `read_roles` 가 있는 유형은 그 역할과 admin 만 읽는다. `security definer` 로 데이터를 돌려주는 공개 함수는 RLS 를 우회하므로 `erp.require_readable(id)` 나 `erp.readable_types()` 또는 `erp.has_role(...)` 로 직접 확인한다.
- **이벤트는 사실이다.** 나중에 재생해도 결과가 같도록, 계산 결과(단가·세액·합계)를 이벤트에 그대로 싣는다. 리듀서는 다른 표를 읽지 않는다.
- **줄 변경은 줄 이벤트로.** 화면이 줄 전체를 보내도 처리기는 차이를 계산해 `...LineAdded/Changed/Removed` 를 낸다. 이력 분석의 재료다.
- **변화가 없으면 이벤트도 없다.**
- 모듈 간 연결은 **이벤트 + react 훅**이다. 다른 모듈의 함수를 직접 부르지 않고 그 모듈의 명령(`erp.dispatch`)을 부른다.
- 파생 표(재고 수량 등)는 `project` 훅으로 갱신하고, 이벤트에서 다시 만들 수 있어야 한다.
- 파일은 여러 번 실행해도 같아야 한다: `create table if not exists`, `create or replace`, `drop trigger if exists`, `on conflict do nothing`. **데이터를 지우는 문장 금지.**
- 공개 저장소다. 코드·주석·문구·시험에 특정 경쟁 제품 이름을 쓰지 않는다.

### 카탈로그 문서 형식

```json
{"type":"partner","module":"master","sort":10,"label":"연락처","label_en":"Contact",
 "fields":[{"name":"name","label":"이름","type":"text","required":true,"list":true,"search":true},
           {"name":"parent_id","label":"소속 회사","type":"ref","ref":"partner"},
           {"name":"lines","label":"품목","type":"lines","columns":[{"name":"qty","label":"수량","type":"number"}]}],
 "states":[{"value":"draft","label":"견적","color":"gray"}],
 "transitions":[{"command":"confirm","to":"sale","from":["draft","sent"],"label":"주문 확정","roles":["sales"],"primary":true,
                 "params":[{"name":"x","label":"..","type":"text"}]}],
 "commands":{"create":{"roles":["sales"]},"update":{"roles":["sales"]},"delete":{"roles":["sales"]}},
 "extra_commands":{"update_prices":{"roles":["sales"],"label":"가격 다시 계산"}},
 "write_roles":["sales"]}
```

필드 유형: `text number money integer boolean date datetime enum ref refs tags json lines password`. 추가 속성: `required list search default readonly options[{value,label}] ref unique create_only computed columns help`.

**MCP 규칙:** 모든 업무 행위는 CRUD 로 표현할 수 있어야 한다.
- 상태 전이: `update` + `{"state": "<to>"}` → 카탈로그 `transitions` 로 명령을 찾는다.
- 다른 문서를 만드는 행위: `create` 로 표현한다(예: `account_move` create `{from_sales_order, method}`, `payment` create, 반품은 `picking` create `{return_of}`).

역할: `admin sales purchase inventory accounting viewer`. `admin` 은 모든 쓰기가 가능하다. 읽기 기본값은 모든 구성원이며, 회계 문서·구매 문서처럼 민감한 유형은 `read_roles` 로 좁힌다.

## 2. 기초데이터 (`sql/10_master.sql`)

| 유형 | 필드 |
|---|---|
| `uom` | `name, category(unit/weight/time/length/volume), ratio, rounding`. `ratio` 는 분류 기준 단위 대비 배수 |
| `product_category` | `name, parent_id, income_account_id, expense_account_id, cost_method(standard/average)` |
| `tag` | `name, color` |
| `account` | `code(unique), name, account_type(asset_receivable, asset_cash, asset_current, asset_non_current, liability_payable, liability_current, equity, income, expense)` |
| `tax` | `name, scope(sale/purchase), amount_type(percent/fixed), amount, price_include, account_id, description` |
| `fiscal_position` | `name, auto_apply, country, tax_map[{id, from_tax_id, to_tax_id}]` |
| `payment_term` | `name, note, lines[{id, value(percent/fixed/balance), amount, days}]`. 잔금 줄은 마지막에 하나 |
| `attribute` | `name, display_type(pills/color/radio/select/multi), create_variant(always/dynamic/no_variant), values[{id, name, color}]`. `multi` 는 `no_variant` 만. 제품에 쓰인 뒤 `create_variant` 변경 금지 |
| `partner` | `company_type(company/person), name, parent_id, address_type(contact/invoice/delivery/other), job_position, phone, mobile, email, website, street, city, zip, country, tax_id, lang, tags, salesperson_id, payment_term_id, vendor_payment_term_id, pricelist_id, fiscal_position_id, note, merged_into, active`. 명령 `merge{into}` |
| `product` | `type(goods/service), name, internal_ref, barcode, category_id, uom_id, purchase_uom_id, list_price, standard_price, sale_ok, purchase_ok, sale_tax_ids, purchase_tax_ids, invoice_policy(order/delivery), bill_policy(order/receipt), tracking(none/lot/serial), weight, volume, customer_lead_days, description_sale, description_purchase, attributes[{id, attribute_id, value_ids, extras:{value_id:price}}], variants[{id, sku, barcode, values:[value_id], name, price_extra, standard_price, active}], vendors[{id, partner_id, min_qty, price, delay_days, vendor_code, discount, date_start, date_end}]` |
| `warehouse` | `name, code, stock_location_id` |
| `location` | `name, parent_id, usage(view/internal/customer/supplier/inventory/transit), scrap` |

- 속성 없는 제품도 기본 변형 한 줄이 생긴다. 주문·재고는 언제나 `variant_id` 를 쓴다.
- 파생 표 `erp.variants(id, product_id, sku, barcode, name, active)` 를 project 훅으로 유지한다.
- 함수 `erp.variant(variant_id) returns jsonb`: 변형 + 제품 필드 + `list_price`(제품 가격 + `price_extra`), 없으면 `ERP_NOT_FOUND`.
- 함수 `erp.uom_convert(qty, from_uom, to_uom)`: 다른 분류면 `ERP_UOM`.
- `dynamic` 은 주문 줄에서 처음 쓸 때 변형을 만든다: `erp.variant_ensure(product_id, value_ids) returns variant_id`.
- 기본 시드(`erp.default_seeds`): 단위, 세금(부가세 10% 매출·매입, 영세율, 면세), 결제 조건(즉시/15일/30일/30%선금+잔금 60일), 계정과목, 기본 분류, 창고 `WH`, 위치(재고·공급사·고객·재고조정·폐기). 시드의 ID 는 `erp.seed_id('이름')`(이름에서 만든 고정 uuid)으로 얻는다.
- 회사 설정의 기본 세금 `default_sale_tax_id`, `default_purchase_tax_id` 는 새 제품의 기본값이다.

## 3. 가격 (`sql/20_pricing.sql`)

`pricelist`: `name, currency, sort, country_group, rules[{id, apply_on(all/category/product/variant), category_id, product_id, variant_id, min_qty, date_start, date_end, price_type(discount/formula/fixed), discount, fixed_price, base(list_price/standard_price/pricelist), base_pricelist_id, formula_discount, round_to, surcharge, min_margin, max_margin}]`

- `erp.price_for(pricelist_id, variant_id, qty, on_date, uom_id) returns jsonb` → `{price_unit, list_price, discount, rule_id}`. 선택 순서: 구체적인 대상(변형 > 제품 > 분류(가까운 쪽) > 전체), 그다음 기준 수량이 큰 쪽. `discount` 유형은 할인율을 줄의 `discount` 로 보여 주고, `formula`·`fixed` 는 단가에 녹인다.
- `erp.tax_compute(price_unit, qty, discount, tax_ids jsonb, fiscal_position_id) returns jsonb` → `{subtotal, tax, total, taxes:[{tax_id, name, base, amount, account_id}], tax_ids}`. 줄 단위 반올림. `price_include` 세금은 단가에서 뺀다. 고정 금액 세금은 수량을 곱한다.
- `public.erp_price(...)`는 화면이 호출한다.

## 4. 판매 (`sql/30_sales.sql`)

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

## 5. 재고 (`sql/40_inventory.sql`)

`picking`: `number(WH/IN/00001, WH/OUT/.., WH/INT/..), picking_type(incoming/outgoing/internal), partner_id, origin_type, origin_id, origin_name, location_from, location_to, warehouse_id, scheduled_date, date_done, shipping_policy, state(draft/waiting/confirmed/ready/done/cancelled), backorder_of, return_of, note, moves[{id, product_id, variant_id, name, uom_id, demand, reserved, done, lot_id, lot_name, origin_line_id, unit_cost}]`

명령: `create update confirm check_availability unreserve validate cancel delete`. `validate{backorder: true/false, moves:[{id, done, lot_name}]}`. 반품은 `create{return_of, moves:[{id, qty}]}`.

| 이벤트 | 계약 |
|---|---|
| `PickingCreated`, `PickingConfirmed`, `PickingReserved`, `PickingUnreserved`, `PickingCancelled`(`origin_type, origin_id, moves`) | |
| `PickingValidated` | `{origin_type, origin_id, picking_type, is_return, moves:[{move_id, origin_line_id, product_id, variant_id, qty_done, uom_id, location_from, location_to, lot_id, unit_cost}]}` |

- 파생 표 `erp.quants(variant_id, location_id, lot_id, qty, reserved)`. 재고 수량의 변화는 전부 이벤트에서 나온다.
- react: `SalesOrderConfirmed` → 출고 전표(재화 줄만), `PurchaseOrderConfirmed` → 입고 전표, `SalesOrderLineQtyChanged`·`PurchaseOrderLineQtyChanged` → 열린 전표 수량 조정, 주문 취소 → 열린 전표 취소.
- `stock_adjustment`: `variant_id, location_id, lot_id, counted_qty, theoretical_qty, difference, reason, state(draft/applied/reverted)`. 이벤트 `StockAdjusted{variant_id, location_id, lot_id, delta, unit_cost}`, `StockAdjustmentReverted`.
- `scrap`: `variant_id, location_id, lot_id, qty, reason, origin_picking_id, state(done)`. 이벤트 `StockScrapped`.
- `lot`: `name, product_id, variant_id, expiration_date`. `serial` 은 수량 1 규칙.
- `reorder_rule`: `variant_id, location_id, min_qty, max_qty, multiple, trigger(auto/manual), vendor_id, active`. 함수 `public.erp_run_scheduler()` 와 react: 재고 변동·주문 확정 때 `auto` 규칙 평가. `RfqRequested` 이벤트(`reorder_rule` 스트림)를 내면 구매 모듈이 RFQ 를 만든다.
- 뷰 `public.erp_stock`: `variant_id, product_id, location_id, lot_id, on_hand, reserved, available, incoming, outgoing, forecast, unit_cost, value`.
- 원가: 분류의 `cost_method`. `average` 면 입고 때 `ProductCostChanged` 를 낸다.

## 6. 구매 (`sql/50_purchase.sql`)

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

## 7. 회계 (`sql/60_accounting.sql`)

`account_move`: `move_type(out_invoice/out_refund/in_invoice/in_refund/entry), number(INV/2026/00001, RINV/.., BILL/.., RBILL/.., MISC/..), partner_id, invoice_date, due_date, payment_term_id, fiscal_position_id, origin_type, origin_id, origin_name, ref, payment_reference, narration, state(draft/posted/cancelled), payment_state(not_paid/in_payment/paid/partial/reversed), should_be_paid(yes/no/exception), amount_untaxed, amount_tax, amount_total, amount_residual, reversal_of, reversed_by, installments[{due_date, amount}], lines[{id, sequence, display_type, product_id, variant_id, name, qty, uom_id, price_unit, discount, tax_ids, subtotal, tax_amount, total, account_id, origin_line_id, is_downpayment}]`

명령: `create update post reset_to_draft cancel reverse delete`.
- `create{from_sales_order, method(regular/percentage/fixed), amount}`: 주문에서 청구서 생성. 선금은 주문에 `is_downpayment` 줄을 만들고, 일반 청구서가 음수 줄로 차감한다.
- `create{from_purchase_order}`: 주문에서 공급사 청구서 생성.
- `reverse{mode(reverse/reverse_and_create), reason, date}`: 대변 메모.

| 이벤트 | 계약 |
|---|---|
| `InvoiceCreated`, `InvoiceUpdated`, `InvoiceLine*`, `InvoiceResetToDraft`, `InvoiceCancelled` | |
| `InvoicePosted` | `{move_type, number, origin_type, origin_id, partner_id, date, lines:[{line_id, origin_line_id, qty, subtotal, is_downpayment}], gl:[{account_id, partner_id, debit, credit, name}]}` |
| `InvoicePaymentApplied` | `{payment_id, amount, residual, payment_state}` |
| `PaymentPosted`, `PaymentCancelled`, `PaymentAllocated` | `gl` 포함 |

- `payment`: `payment_type(inbound/outbound), partner_id, amount, date, journal(bank/cash), memo, state(draft/posted/cancelled), allocations[{id, move_id, amount}], unallocated, writeoff_amount, writeoff_account_id`. 부분 결제 후 "완납 처리"는 차액 대손·에누리 분개로 처리한다. 미배분 금액은 고객 크레딧으로 남고 나중에 배분한다.
- 파생 표 `erp.gl_lines(event_seq, move_id, date, account_id, partner_id, debit, credit, name)`. 차변과 대변이 다르면 게시 불가(`ERP_UNBALANCED`).
- 보고서 함수: `erp_trial_balance(from, to)`, `erp_aged(kind, at)`, `erp_general_ledger(account, from, to)`, `erp_profit_loss(from, to)`, `erp_balance_sheet(at)`.
- 게시된 청구서는 `reset_to_draft` 뒤에만 고친다(번호 유지). `reversed` 이면 `payment_state='reversed'`.
- 판매 쪽 react: `InvoicePosted`(`origin_type='sales_order'`) → 줄 `qty_invoiced`, 대변 메모는 감소. 구매도 같다.

## 8. 고객 포털 (`sql/30_sales.sql`)

`public.erp_portal_get(token)`, `public.erp_portal_sign(token, name, signature)`, `public.erp_portal_decline(token, reason)`. 익명 호출 가능, 토큰으로만 그 견적 하나를 본다. 서명하면 `QuotationSigned` → 온라인 서명만 요구된 견적은 자동 확정된다.

## 9. 분석 (`sql/70_analytics.sql`)

`erp_snapshot_at(at)`, `erp_flow_stats(from, to)`, `erp_demand_series(variant, bucket, from, to, as_of)`, `erp_stock_history(variant, from, to)`, `erp_price_history(variant)`, `erp_quote_revisions(from, to)`, `erp_payment_behavior(partner)`, `erp_ar_forecast_inputs()`. 예측 계산은 브라우저(`web/src/lib/forecast.ts`)에서 한다.
